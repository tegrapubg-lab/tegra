// Тест настоящего процесса движка: запуск бандла, HTTP API, kill -9 и восстановление.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mockServer, sleep, tmpDir, waitFor } from './helpers';

const ENGINE = path.resolve(__dirname, '../dist/engine/main.js');
const procs: ChildProcess[] = [];
afterAll(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* уже завершён */ } } });

async function startEngine(dir: string, token = 'tok-process-test') {
  const p = spawn(process.execPath, ['--no-warnings', ENGINE], { env: { ...process.env, TEGRA_DATA_DIR: dir, TEGRA_API_TOKEN: token, TEGRA_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let err = ''; p.stderr!.on('data', (d) => (err += d));
  const info = await new Promise<{ port: number }>((resolve, reject) => {
    let buf = ''; p.stdout!.on('data', (d) => { buf += d; const m = /TEGRA_READY (.+)/.exec(buf); if (m) resolve(JSON.parse(m[1])); });
    p.on('exit', (c) => reject(new Error(`движок завершился (${c}): ${err}`)));
    setTimeout(() => reject(new Error('движок не стартовал: ' + err)), 15000);
  });
  const api = async (verb: string, url: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${info.port}${url}`, { method: verb, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = text; }
    if (!r.ok) throw new Error(`${verb} ${url} → ${r.status}: ${text}`);
    return j;
  };
  return { p, port: info.port, api, exited: new Promise<number | null>((r) => p.on('exit', (c) => r(c))) };
}

const node = (id: string, type: string, params: Record<string, unknown> = {}, settings?: any) => ({ id, type, name: id, position: { x: 0, y: 0 }, params, settings });
const edge = (s: string, sh: string, t: string) => ({ id: `${s}-${t}`, source: s, sourceHandle: sh, target: t, targetHandle: 'main' });

describe('процесс движка (реальный Node-процесс)', () => {
  it('запуск → API → выполнение через очередь; kill -9 в середине → восстановление и завершение после перезапуска', async () => {
    const dir = tmpDir();
    let release: () => void = () => {};
    let hits = 0;
    const s = await mockServer((_r, _b, res) => { hits++; if (hits === 1) { /* первый вызов «зависает» — движок будет убит */ return; } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); void release; });

    const e1 = await startEngine(dir);
    const w = await e1.api('POST', '/api/workflows', { name: 'Крэш-тест', definition: {
      nodes: [node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'v', value: '1', type: 'number' }] }),
        node('h', 'http.request', { url: s.url, allowPrivate: true }, { timeoutMs: 60000 }), node('after', 'core.set', { assignments: [{ name: 'done', value: 'true', type: 'boolean' }] })],
      edges: [edge('t', 'main', 's'), edge('s', 'main', 'h'), edge('h', 'main', 'after')] } });
    const { runId } = await e1.api('POST', `/api/workflows/${w.id}/run`, {});
    await waitFor(() => hits >= 1, 10000);
    const mid = await e1.api('GET', `/api/runs/${runId}`);
    expect(mid.status).toBe('running');
    expect(mid.nodes.find((n: any) => n.nodeId === 's').status).toBe('succeeded'); // уже сохранено в SQLite
    expect(mid.nodes.find((n: any) => n.nodeId === 'h').status).toBe('running');

    e1.p.kill('SIGKILL'); // внезапная смерть процесса
    await e1.exited;
    expect(fs.existsSync(path.join(dir, 'engine.lock'))).toBe(true); // замок остался от умершего процесса

    const e2 = await startEngine(dir);
    const done = await waitFor(async () => { const r = await e2.api('GET', `/api/runs/${runId}`); return r.status === 'succeeded' ? r : null; }, 15000);
    expect(done.nodes.find((n: any) => n.nodeId === 'after').outputs.main[0].json.done).toBe(true);
    expect(done.nodes.find((n: any) => n.nodeId === 'h').log.join('\n')).toContain('Восстановлено после перезапуска');
    expect(done.nodes.find((n: any) => n.nodeId === 's').attempt).toBe(1); // уже выполненный узел не повторялся
    expect(hits).toBe(2);

    // корректное завершение по SIGTERM снимает замок
    e2.p.kill('SIGTERM'); await e2.exited;
    expect(fs.existsSync(path.join(dir, 'engine.lock'))).toBe(false);
    await s.close();
  });

  it('второй экземпляр на тех же данных не стартует; API без токена закрыт', async () => {
    const dir = tmpDir();
    const e1 = await startEngine(dir);
    await expect(startEngine(dir)).rejects.toThrow(/уже запущен/);
    const r = await fetch(`http://127.0.0.1:${e1.port}/api/workflows`);
    expect(r.status).toBe(401);
    e1.p.kill('SIGTERM'); await e1.exited; await sleep(50);
  });

  it('ожидание переживает перезапуск процесса: Wait в БД продолжается после рестарта', async () => {
    const dir = tmpDir();
    const e1 = await startEngine(dir);
    const w = await e1.api('POST', '/api/workflows', { name: 'Ждём', definition: { nodes: [node('t', 'trigger.manual'), node('w', 'core.wait', { mode: 'duration', amount: 2, unit: 'seconds' }), node('a', 'core.set', { assignments: [{ name: 'x', value: '1', type: 'number' }] })], edges: [edge('t', 'main', 'w'), edge('w', 'main', 'a')] } });
    const { runId } = await e1.api('POST', `/api/workflows/${w.id}/run`, {});
    await waitFor(async () => (await e1.api('GET', `/api/runs/${runId}`)).status === 'waiting', 8000);
    e1.p.kill('SIGTERM'); await e1.exited;
    await sleep(2200); // время ожидания истекло, пока приложение было закрыто
    const e2 = await startEngine(dir);
    const run = await waitFor(async () => { const r = await e2.api('GET', `/api/runs/${runId}`); return r.status === 'succeeded' ? r : null; }, 10000);
    expect(run.nodes.find((n: any) => n.nodeId === 'a').status).toBe('succeeded');
    e2.p.kill('SIGTERM'); await e2.exited;
  });
});
