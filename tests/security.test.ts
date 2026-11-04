import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import { createServer } from '../src/engine/server';
import { guardedFetch, isPrivateAddress } from '../src/engine/netguard';
import { Redactor, decryptString, encryptString, generateMasterKey } from '../src/engine/secrets';
import { edge, key, makeEngine, mockServer, node, runToEnd, tmpDir, wf } from './helpers';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

describe('защита от SSRF', () => {
  it('таблица приватных адресов', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('по умолчанию запрещены localhost, loopback, облачные метаданные, обфусцированные формы', async () => {
    for (const url of ['http://127.0.0.1:1/', 'http://localhost:1/', 'http://[::1]:1/', 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f.1/', 'http://foo.localhost/', 'http://10.0.0.1/'])
      await expect(guardedFetch({ url }), url).rejects.toThrow(/локальн|приватн/i);
    await expect(guardedFetch({ url: 'file:///etc/passwd' })).rejects.toThrow(/Протокол/);
    await expect(guardedFetch({ url: 'http://user:pw@example.com/' })).rejects.toThrow(/Логин и пароль/);
  });
  it('HTTP-узел без явного разрешения не достаёт локальный сервис; с разрешением — достаёт', async () => {
    const s = await mockServer((_r, _b, res) => { res.writeHead(200); res.end('internal'); }); closers.push(s.close);
    const { engine } = makeEngine();
    const mk = (allow: boolean) => engine.createWorkflow('s', wf([node('t', 'trigger.manual'), node('h', 'http.request', { url: s.url, allowPrivate: allow })], [edge('t', 'main', 'h')]));
    const blocked = await runToEnd(engine, mk(false).id);
    expect(blocked.status).toBe('failed'); expect(blocked.error).toMatch(/локальн|приватн/i); expect(s.requests).toHaveLength(0);
    const allowed = await runToEnd(engine, mk(true).id);
    expect(allowed.status).toBe('succeeded');
  });
  it('перенаправления: лимит, и Authorization не уходит на другой origin', async () => {
    const b = await mockServer((_r, _b, res) => { res.writeHead(200); res.end('b'); }); closers.push(b.close);
    const a = await mockServer((_r, _b, res) => { res.writeHead(302, { location: b.url + '/x' }); res.end(); }); closers.push(a.close);
    const r = await guardedFetch({ url: a.url, headers: { authorization: 'Bearer SECRET-VALUE' }, allowPrivate: true });
    expect(r.status).toBe(200); expect(b.requests[0].headers.authorization).toBeUndefined();
    const loop = await mockServer((_r, _b, res) => { res.writeHead(302, { location: '/again' }); res.end(); }); closers.push(loop.close);
    await expect(guardedFetch({ url: loop.url, allowPrivate: true })).rejects.toThrow(/перенаправлений/);
  });
  it('лимит размера ответа', async () => {
    const s = await mockServer((_r, _b, res) => { res.writeHead(200); res.end('x'.repeat(200_000)); }); closers.push(s.close);
    await expect(guardedFetch({ url: s.url, allowPrivate: true, maxBytes: 50_000 })).rejects.toThrow(/лимита/);
  });
});

describe('секреты', () => {
  const TOKEN = 'SUPER-SECRET-TOKEN-9f3a1b77';
  it('шифрование AES-GCM: round-trip, чужой ключ не расшифровывает', () => {
    const k = generateMasterKey(); const enc = encryptString(k, 'пароль');
    expect(enc).not.toContain('пароль'); expect(decryptString(k, enc)).toBe('пароль');
    expect(() => decryptString(generateMasterKey(), enc)).toThrow(/мастер-ключ/);
  });
  it('Redactor маскирует значения и чувствительные ключи', () => {
    const r = new Redactor(); r.setSecrets([TOKEN]);
    const out = r.value({ a: `x ${TOKEN} y`, headers: { Authorization: 'Bearer abc', 'X-Other': 'ok' }, nested: [{ token: 'zzz' }], url: 'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456/getMe' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.headers.Authorization).toBe('***'); expect(out.headers['X-Other']).toBe('ok'); expect(out.nested[0].token).toBe('***');
    expect(out.url).toContain('/bot***/');
  });
  const echo = async () => {
    const s = await mockServer((req, _b, res) => {
      if (req.url === '/fail') { res.writeHead(500); res.end(`bad token ${req.headers.authorization}`); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ got: req.headers.authorization, echo: `key=${TOKEN}` }));
    }); closers.push(s.close); return s;
  };
  it('секрет подключения не попадает ни в выход узла, ни в ошибку, ни в файлы БД, ни в API, ни в экспорт', async () => {
    const s = await echo();
    const dir = tmpDir();
    const { engine } = makeEngine({ dir });
    const cid = engine.saveCredential(null, 'API', 'httpAuth', { scheme: 'bearer', token: TOKEN });
    const w = engine.createWorkflow('sec', wf([
      node('t', 'trigger.manual'),
      node('h', 'http.request', { url: s.url + '/ok', auth: cid, allowPrivate: true }),
      node('f', 'http.request', { url: s.url + '/fail', auth: cid, allowPrivate: true }, { onError: 'continue' }),
    ], [edge('t', 'main', 'h'), edge('h', 'main', 'f')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    expect(s.requests[0].headers.authorization).toBe('Bearer ' + TOKEN); // реально отправлен
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    engine.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f)).toString('latin1'), f).not.toContain(TOKEN);
    const list = JSON.stringify(engine.store.listCredentials());
    expect(list).not.toContain(TOKEN); expect(engine.store.listCredentials()[0].secretSet).toEqual({ token: true, password: false });
    const exp = JSON.stringify(engine.exportWorkflow(w.id));
    expect(exp).not.toContain(TOKEN); expect(exp).not.toContain(cid);
    engine.saveCredential(cid, 'API2', 'httpAuth', { scheme: 'bearer', token: '' });
    expect(engine.store.getCredentialData(cid)!.data.token).toBe(TOKEN); // пустое поле при правке = оставить прежнее
  });
  it('секрет, вписанный вручную в параметр узла, маскируется в истории запусков, логах и экспорте', async () => {
    const s = await echo();
    const { engine } = makeEngine();
    engine.saveCredential(null, 'API', 'httpAuth', { scheme: 'bearer', token: TOKEN }); // регистрирует значение в маскировщике
    const w = engine.createWorkflow('manual', wf([
      node('t', 'trigger.manual'),
      node('h', 'http.request', { url: s.url + '/ok', allowPrivate: true, headers: [{ key: 'Authorization', value: 'Bearer ' + TOKEN }, { key: 'X-Note', value: 'token=' + TOKEN }] }),
    ], [edge('t', 'main', 'h')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(engine.runDetail(run.id))).not.toContain(TOKEN);
    expect(JSON.stringify(run.nodes)).not.toContain(TOKEN);
    expect(JSON.stringify(engine.exportWorkflow(w.id))).not.toContain(TOKEN);
  });
  it('экспорт → импорт: работает без секретов и выдаёт новые адреса webhook', () => {
    const { engine } = makeEngine();
    const sid = engine.saveCredential(null, 'S', 'webhookSecret', { secret: 'abcdef123456' });
    const w = engine.createWorkflow('hook', wf([node('t', 'trigger.webhook', { path: 'fixed-path', method: 'POST', secret: sid }), node('s', 'core.set', { assignments: [] })], [edge('t', 'main', 's')]));
    const exp = engine.exportWorkflow(w.id);
    const imp = engine.importWorkflow(JSON.parse(JSON.stringify(exp)));
    const t = imp.nodes.find((n) => n.type === 'trigger.webhook')!;
    expect(t.params.path).not.toBe('fixed-path'); expect(t.params.secret).toBeUndefined();
    expect(() => engine.importWorkflow({ format: 'x' })).toThrow(/не похож/);
  });
});

describe('webhook и локальный API', () => {
  it('webhook проверяет секрет, метод, ограничивает перебор', async () => {
    const { engine } = makeEngine();
    const sid = engine.saveCredential(null, 'S', 'webhookSecret', { secret: 'right-secret-123' });
    const w = engine.createWorkflow('hook', wf([node('t', 'trigger.webhook', { path: 'p1', method: 'POST', secret: sid }), node('s', 'core.set', { assignments: [{ name: 'c', value: '{{ $json.body.customer }}', type: 'string' }] })], [edge('t', 'main', 's')]));
    engine.setActive(w.id, true);
    expect(engine.handleWebhook('p1', 'POST', {}, {}, {}, '1.1.1.1').status).toBe(401);
    expect(engine.handleWebhook('p1', 'POST', { 'x-webhook-secret': 'wrong' }, {}, {}, '1.1.1.1').status).toBe(401);
    expect(engine.handleWebhook('p1', 'GET', { 'x-webhook-secret': 'right-secret-123' }, {}, {}, '2.2.2.2').status).toBe(405);
    const ok = engine.handleWebhook('p1', 'POST', { 'x-webhook-secret': 'right-secret-123', 'user-agent': 'curl' }, { a: '1' }, { customer: 'Али' }, '2.2.2.2');
    expect(ok.status).toBe(202);
    await engine.drain();
    const run = engine.store.getRunDetail((ok.body as any).runId)!;
    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(run.triggerData)).not.toContain('right-secret-123'); // заголовок с секретом не сохраняется
    expect(run.nodes.find((n) => n.nodeId === 's')!.outputs!.main[0].json.c).toBe('Али');
    expect(engine.handleWebhook('nope', 'POST', {}, {}, {}, '3.3.3.3').status).toBe(404);
    for (let i = 0; i < 25; i++) engine.handleWebhook('p1', 'POST', { 'x-webhook-secret': 'x' }, {}, {}, '9.9.9.9');
    expect(engine.handleWebhook('p1', 'POST', { 'x-webhook-secret': 'right-secret-123' }, {}, {}, '9.9.9.9').status).toBe(429);
    // выключенный сценарий не принимает запросы
    engine.setActive(w.id, false);
    expect(engine.handleWebhook('p1', 'POST', { 'x-webhook-secret': 'right-secret-123' }, {}, {}, '4.4.4.4').status).toBe(404);
  });

  it('HTTP-сервер: слушает только 127.0.0.1, /api требует токен, чужой Host отклоняется', async () => {
    const { engine } = makeEngine();
    const server = createServer(engine, { port: 0, token: 'api-token-xyz' });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe('127.0.0.1');
    const call = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: addr.port, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b })); }).on('error', reject);
    });
    expect((await call('/api/workflows')).status).toBe(401);
    expect((await call('/api/workflows', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('/api/workflows', { authorization: 'Bearer api-token-xyz' })).status).toBe(200);
    expect((await call('/api/workflows', { authorization: 'Bearer api-token-xyz', host: 'evil.example.com' })).status).toBe(421);
    expect((await call('/api/status', { authorization: 'Bearer api-token-xyz' })).body).toContain('activeWorkflows');
  });
});

describe('данные: миграции и резервные копии', () => {
  it('миграции применяются один раз; резервная копия содержит сценарии и открывается заново', async () => {
    const { engine, dir } = makeEngine();
    expect((engine.db.prepare('SELECT version FROM schema_migrations').all() as any[]).map((r) => r.version)).toEqual([1]);
    const w = engine.createWorkflow('Важный', wf([node('t', 'trigger.manual')], []));
    const cid = engine.saveCredential(null, 'API', 'httpAuth', { scheme: 'bearer', token: 'tok-1234567' });
    const backup = path.join(dir, 'backup', 'copy.sqlite');
    engine.backupTo(backup);
    await engine.stop();
    const restored = new Engine({ dbPath: backup, masterKey: key, background: false });
    expect(restored.store.getWorkflow(w.id)!.name).toBe('Важный');
    expect(restored.store.getCredentialData(cid)!.data.token).toBe('tok-1234567'); // тот же мастер-ключ
    const wrong = new Engine({ dbPath: backup, masterKey: generateMasterKey(), background: false });
    expect(() => wrong.store.getCredentialData(cid)).toThrow(/мастер-ключ/);
    await restored.stop(); await wrong.stop();
  });
});
