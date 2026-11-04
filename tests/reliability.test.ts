import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import { edge, key, makeEngine, mockServer, node, runToEnd, sleep, tmpDir, waitFor, wf } from './helpers';
import path from 'node:path';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

describe('повторы, тайм-ауты, ошибки', () => {
  it('retries с задержкой: узел успешен на 3-й попытке, Idempotency-Key одинаков', async () => {
    let hits = 0;
    const s = await mockServer((_req, _b, res) => { hits++; if (hits < 3) { res.writeHead(503); res.end('busy'); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } });
    closers.push(s.close);
    const { engine } = makeEngine();
    const w = engine.createWorkflow('retry', wf([node('t', 'trigger.manual'), node('h', 'http.request', { method: 'POST', url: s.url, bodyType: 'text', body: 'x', allowPrivate: true, idempotency: true }, { maxAttempts: 3, retryDelayMs: 20 })], [edge('t', 'main', 'h')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    const h = run.nodes.find((n) => n.nodeId === 'h')!;
    expect(h.attempt).toBe(3);
    expect(h.log.filter((l) => l.includes('не удалась'))).toHaveLength(2);
    const keys = s.requests.map((r) => r.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(1); expect(keys[0]).toContain(run.id);
  });

  it('исчерпание попыток → запуск failed, остальные ветки не выполняются', async () => {
    const s = await mockServer((_r, _b, res) => { res.writeHead(500); res.end('boom'); });
    closers.push(s.close);
    const { engine } = makeEngine();
    const w = engine.createWorkflow('fail', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: true }, { maxAttempts: 2, retryDelayMs: 10 }), node('n', 'core.set', { assignments: [] })], [edge('t', 'main', 'h'), edge('h', 'main', 'n')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('failed'); expect(run.error).toContain('HTTP 500');
    expect(run.nodes.find((n) => n.nodeId === 'h')!.attempt).toBe(2);
    expect(run.nodes.find((n) => n.nodeId === 'n')!.status).toBe('cancelled');
  });

  it('onError=continue передаёт ошибку дальше как данные', async () => {
    const s = await mockServer((_r, _b, res) => { res.writeHead(404); res.end('no'); });
    closers.push(s.close);
    const { engine } = makeEngine();
    const w = engine.createWorkflow('cont', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: true }, { onError: 'continue' }), node('n', 'core.set', { assignments: [{ name: 'seen', value: '{{ $json.error.message }}', type: 'string' }] })], [edge('t', 'main', 'h'), edge('h', 'main', 'n')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    expect(String(run.nodes.find((n) => n.nodeId === 'n')!.outputs!.main[0].json.seen)).toContain('HTTP 404');
  });

  it('тайм-аут узла прерывает долгий запрос', async () => {
    const s = await mockServer(() => { /* не отвечаем */ });
    closers.push(s.close);
    const { engine } = makeEngine();
    const w = engine.createWorkflow('to', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: true }, { timeoutMs: 300 })], [edge('t', 'main', 'h')]));
    const t0 = Date.now();
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('failed'); expect(run.error).toMatch(/Тайм-аут/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('отмена', () => {
  it('отмена прерывает выполняющийся HTTP-запрос и помечает узлы cancelled', async () => {
    const s = await mockServer(() => { /* висим */ });
    closers.push(s.close);
    const { engine } = makeEngine();
    const w = engine.createWorkflow('cancel', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: true }, { timeoutMs: 60000 }), node('n', 'core.set', { assignments: [] })], [edge('t', 'main', 'h'), edge('h', 'main', 'n')]));
    const runId = engine.startRun(w.id);
    const drained = engine.drain();
    await waitFor(() => s.requests.length > 0);
    engine.cancelRun(runId);
    await drained;
    const run = engine.store.getRunDetail(runId)!;
    expect(run.status).toBe('cancelled');
    expect(run.nodes.find((n) => n.nodeId === 'h')!.status).toBe('cancelled');
    expect(run.nodes.find((n) => n.nodeId === 'n')!.status).toBe('cancelled');
  });

  it('отмена ожидающего запуска и каскад на вложенные', async () => {
    const { engine } = makeEngine();
    const child = engine.createWorkflow('child', wf([node('t', 'trigger.manual'), node('w', 'core.wait', { mode: 'duration', amount: 1, unit: 'hours' })], [edge('t', 'main', 'w')]));
    const parent = engine.createWorkflow('parent', wf([node('t', 'trigger.manual'), node('c', 'core.subworkflow', { workflowId: child.id })], [edge('t', 'main', 'c')]));
    const runId = engine.startRun(parent.id);
    await engine.drain();
    expect(engine.store.getRunRow(runId)!.status).toBe('waiting');
    engine.cancelRun(runId);
    expect(engine.store.getRunRow(runId)!.status).toBe('cancelled');
    const kids = engine.store.listRuns({ workflowId: child.id });
    expect(kids[0].status).toBe('cancelled');
  });
});

describe('ожидание, подтверждение, вложенные сценарии', () => {
  it('Wait сохраняется в БД, не держит процесс и продолжается по таймеру (в т.ч. после перезапуска движка)', async () => {
    let now = Date.parse('2026-05-01T10:00:00Z');
    const dir = tmpDir();
    const e1 = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: key, background: false, now: () => now });
    const w = e1.createWorkflow('wait', wf([node('t', 'trigger.manual'), node('w', 'core.wait', { mode: 'duration', amount: 10, unit: 'minutes' }), node('a', 'core.set', { assignments: [{ name: 'done', value: 'true', type: 'boolean' }] })], [edge('t', 'main', 'w'), edge('w', 'main', 'a')]));
    const runId = e1.startRun(w.id);
    await e1.drain();
    expect(e1.store.getRunRow(runId)!.status).toBe('waiting');
    expect(e1.queue.counts()).toEqual({ queued: 0, claimed: 0 }); // задания нет — процесс свободен
    now += 5 * 60_000; expect(e1.tickTimers()).toBe(0);
    await e1.stop();

    // «перезапуск приложения» спустя 20 минут
    now += 15 * 60_000;
    const e2 = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: key, background: false, now: () => now });
    await e2.start();
    expect(e2.tickTimers()).toBe(1);
    await e2.drain();
    const run = e2.store.getRunDetail(runId)!;
    expect(run.status).toBe('succeeded');
    expect(run.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json.done).toBe(true);
    await e2.stop();
  });

  it('подтверждение пользователя: продолжить / отклонить / тайм-аут', async () => {
    let now = Date.parse('2026-05-01T10:00:00Z');
    const { engine } = makeEngine({ now: () => now });
    const w = engine.createWorkflow('appr', wf([
      node('t', 'trigger.manual'),
      node('ap', 'core.approval', { message: 'Ок?', timeoutHours: 1, onTimeout: 'rejected' }),
      node('yes', 'core.set', { assignments: [{ name: 'r', value: 'да', type: 'string' }] }), node('no', 'core.set', { assignments: [{ name: 'r', value: 'нет', type: 'string' }] }),
    ], [edge('t', 'main', 'ap'), edge('ap', 'approved', 'yes'), edge('ap', 'rejected', 'no')]));

    const r1 = engine.startRun(w.id); await engine.drain();
    const list = engine.listApprovals(); expect(list).toHaveLength(1); expect(list[0].message).toBe('Ок?');
    engine.decideApproval(r1, 'ap', 'approved', 'хорошо'); await engine.drain();
    let run = engine.store.getRunDetail(r1)!;
    expect(run.status).toBe('succeeded'); expect(run.nodes.find((n) => n.nodeId === 'yes')!.status).toBe('succeeded'); expect(run.nodes.find((n) => n.nodeId === 'no')!.status).toBe('skipped');
    expect(() => engine.decideApproval(r1, 'ap', 'approved')).toThrow(/уже принято/);

    const r2 = engine.startRun(w.id); await engine.drain();
    engine.decideApproval(r2, 'ap', 'rejected', 'плохо'); await engine.drain();
    run = engine.store.getRunDetail(r2)!;
    expect(run.nodes.find((n) => n.nodeId === 'no')!.outputs!.main[0].json).toMatchObject({ r: 'нет', decisionComment: 'плохо' });

    const r3 = engine.startRun(w.id); await engine.drain();
    now += 2 * 3600_000; engine.tickTimers(); await engine.drain();
    run = engine.store.getRunDetail(r3)!;
    expect(run.status).toBe('succeeded'); expect(run.nodes.find((n) => n.nodeId === 'no')!.outputs!.main[0].json.decisionTimedOut).toBe(true);
  });

  it('вложенный сценарий возвращает результат core.result; родитель ждёт в БД', async () => {
    const { engine } = makeEngine();
    const child = engine.createWorkflow('child', wf([
      node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'doubled', value: '{{ $json.n * 2 }}', type: 'number' }] }), node('r', 'core.result'),
    ], [edge('t', 'main', 's'), edge('s', 'main', 'r')]));
    const parent = engine.createWorkflow('parent', wf([
      node('t', 'trigger.manual'), node('c', 'core.subworkflow', { workflowId: child.id }), node('p', 'core.set', { assignments: [{ name: 'got', value: '{{ $json.doubled }}', type: 'number' }] }),
    ], [edge('t', 'main', 'c'), edge('c', 'main', 'p')]));
    const run = await runToEnd(engine, parent.id, { n: 21 });
    expect(run.status).toBe('succeeded');
    expect(run.nodes.find((n) => n.nodeId === 'p')!.outputs!.main[0].json.got).toBe(42);
    expect(engine.store.listRuns({ workflowId: child.id })[0].parentRunId).toBe(run.id);
  });

  it('вложенный сценарий с ошибкой роняет родителя с понятной причиной; рекурсия ограничена', async () => {
    const { engine } = makeEngine();
    const child = engine.createWorkflow('bad-child', wf([node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'x', value: '{{ nope }}', type: 'auto' }] })], [edge('t', 'main', 's')]));
    const parent = engine.createWorkflow('p', wf([node('t', 'trigger.manual'), node('c', 'core.subworkflow', { workflowId: child.id })], [edge('t', 'main', 'c')]));
    const run = await runToEnd(engine, parent.id);
    expect(run.status).toBe('failed'); expect(run.error).toMatch(/Вложенный сценарий/);

    // самовызов: сценарий вызывает сам себя → упирается в лимит глубины
    const self = engine.createWorkflow('self', wf([node('t', 'trigger.manual')], []));
    engine.updateWorkflow(self.id, { definition: wf([node('t', 'trigger.manual'), node('c', 'core.subworkflow', { workflowId: self.id })], [edge('t', 'main', 'c')]) });
    const r = engine.startRun(self.id); await engine.drain(200);
    expect(engine.store.getRunRow(r)!.status).toBe('failed');
    expect(engine.store.listRuns({ workflowId: self.id, limit: 50 }).length).toBeLessThanOrEqual(7);
  });
});

describe('восстановление и очередь', () => {
  it('снимок сценария неизменен: правка во время ожидания не меняет запущенное выполнение', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('snap', wf([node('t', 'trigger.manual'), node('w', 'core.wait', { mode: 'duration', amount: 1, unit: 'hours' }), node('a', 'core.set', { assignments: [{ name: 'v', value: 'старая', type: 'string' }] })], [edge('t', 'main', 'w'), edge('w', 'main', 'a')]));
    const runId = engine.startRun(w.id); await engine.drain();
    engine.updateWorkflow(w.id, { definition: wf([node('t', 'trigger.manual'), node('a', 'core.set', { assignments: [{ name: 'v', value: 'новая', type: 'string' }] })], [edge('t', 'main', 'a')]) });
    engine.db.prepare(`UPDATE run_nodes SET resume_at=0 WHERE run_id=?`).run(runId);
    engine.tickTimers(); await engine.drain();
    expect(engine.store.getRunDetail(runId)!.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json.v).toBe('старая');
  });

  it('защита от двойного захвата: два воркера на одной БД не берут одно задание', async () => {
    const { engine, dir } = makeEngine();
    const w = engine.createWorkflow('q', wf([node('t', 'trigger.manual')], []));
    for (let i = 0; i < 30; i++) engine.startRun(w.id);
    const other = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: key, background: false, workerId: 'other' });
    const a = new Set<string>(); const b = new Set<string>(); let n = 0;
    for (;;) {
      const j1 = engine.queue.claim(); const j2 = other.queue.claim();
      if (!j1 && !j2) break;
      if (j1) { a.add(j1.runId); n++; } if (j2) { b.add(j2.runId); n++; }
    }
    expect(n).toBe(30);
    expect([...a].filter((x) => b.has(x))).toEqual([]);
    expect(a.size + b.size).toBe(30);
    await other.stop();
  });

  it('просроченный lease возвращает задание в очередь, узел running сбрасывается и выполняется заново', async () => {
    let now = 1_000_000;
    const { engine, dir } = makeEngine({ now: () => now });
    const w = engine.createWorkflow('lease', wf([node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'a', value: '1', type: 'number' }] })], [edge('t', 'main', 's')]));
    const runId = engine.startRun(w.id);
    const job = engine.queue.claim()!; expect(job.runId).toBe(runId);
    // имитируем падение посреди выполнения узла
    engine.store.ensureRunNodes(runId, ['t', 's']);
    engine.db.prepare(`UPDATE run_nodes SET status='running' WHERE run_id=? AND node_id='t'`).run(runId);
    engine.db.prepare(`UPDATE runs SET status='running' WHERE id=?`).run(runId);
    expect(engine.queue.claim()).toBeNull();
    now += 60_000; // lease 30 с истёк
    expect(engine.queue.recoverExpired()).toBe(1);
    await engine.drain();
    const run = engine.store.getRunDetail(runId)!;
    expect(run.status).toBe('succeeded');
    expect(run.nodes.find((n) => n.nodeId === 't')!.log.join('\n')).toContain('Восстановлено после перезапуска');
    void dir;
  });

  it('перезапуск: запуски в статусе running без задания возвращаются в очередь при старте', async () => {
    const dir = tmpDir();
    const e1 = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: key, background: false });
    const w = e1.createWorkflow('r', wf([node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'a', value: '1', type: 'number' }] })], [edge('t', 'main', 's')]));
    const runId = e1.startRun(w.id);
    e1.queue.claim(); e1.db.prepare(`UPDATE runs SET status='running' WHERE id=?`).run(runId);
    await e1.stop(); // «крэш»: задание claimed, запуск running
    const e2 = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: key, background: false });
    await e2.start(); await e2.drain();
    expect(e2.store.getRunRow(runId)!.status).toBe('succeeded');
    await e2.stop();
  });

  it('фоновый воркер выполняет запуски сам (background=true) и соблюдает лимит параллелизма', async () => {
    const s = await mockServer((_r, _b, res) => { setTimeout(() => { res.writeHead(200); res.end('ok'); }, 150); });
    closers.push(s.close);
    const { engine } = makeEngine({ background: true });
    engine.store.setSetting('maxConcurrentRuns', 2);
    closers.push(() => engine.stop());
    await engine.start();
    const w = engine.createWorkflow('bg', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: true })], [edge('t', 'main', 'h')]));
    const ids = [1, 2, 3, 4].map(() => engine.startRun(w.id));
    await sleep(60);
    expect(engine.status().runsActive).toBeLessThanOrEqual(2);
    await waitFor(() => ids.every((id) => engine.store.getRunRow(id)!.status === 'succeeded'), 15000);
  });
});
