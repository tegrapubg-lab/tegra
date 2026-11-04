import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { ZodError } from 'zod';
import { BUILTIN_TOOLS, CREDENTIAL_TYPES, NODE_SPECS } from '../shared/specs';
import type { Engine } from './engine';
import { EngineError } from './engine';
import { installExample, listExamples } from './examples';
import { credentialSchema, definitionSchema, runSchema, settingsSchema, workflowCreateSchema, workflowUpdateSchema } from './schemas';

type Ctx = { params: Record<string, string>; query: Record<string, string>; body: any };
type Handler = (c: Ctx) => unknown | Promise<unknown>;

const MAX_API_BODY = 12 * 1024 * 1024;
const MAX_HOOK_BODY = 1024 * 1024;

export interface ServerOptions { host?: string; port: number; token: string }

export function createServer(engine: Engine, opts: ServerOptions) {
  const routes: { verb: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  const add = (verb: string, p: string, h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + p.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ verb, re, keys, h });
  };
  const wfWithHooks = (id: string) => { const w = engine.store.getWorkflow(id); if (!w) throw new EngineError('Сценарий не найден', 404); return { ...w, webhooks: engine.webhookUrls(w) }; };

  add('GET', '/api/status', () => engine.status());
  add('GET', '/api/node-types', () => ({ nodes: NODE_SPECS, credentialTypes: CREDENTIAL_TYPES, tools: BUILTIN_TOOLS }));
  add('GET', '/api/workflows', () => engine.store.listWorkflows());
  add('POST', '/api/workflows/import', ({ body }) => engine.importWorkflow(body?.data));
  add('POST', '/api/workflows/validate', ({ body }) => engine.validate(definitionSchema.parse(body?.definition)));
  add('GET', '/api/workflows/:id', ({ params }) => wfWithHooks(params.id));
  add('POST', '/api/workflows', ({ body }) => { const b = workflowCreateSchema.parse(body); return engine.createWorkflow(b.name, b.definition as any); });
  add('PUT', '/api/workflows/:id', ({ params, body }) => { engine.updateWorkflow(params.id, workflowUpdateSchema.parse(body) as any); return wfWithHooks(params.id); });
  add('DELETE', '/api/workflows/:id', ({ params }) => { engine.deleteWorkflow(params.id); return { ok: true }; });
  add('POST', '/api/workflows/:id/duplicate', ({ params }) => engine.duplicateWorkflow(params.id));
  add('POST', '/api/workflows/:id/active', ({ params, body }) => { engine.setActive(params.id, !!body?.active); return wfWithHooks(params.id); });
  add('GET', '/api/workflows/:id/export', ({ params }) => engine.exportWorkflow(params.id));
  add('POST', '/api/workflows/:id/run', ({ params, body }) => { const b = runSchema.parse(body ?? {}); return { runId: engine.startRun(params.id, b) }; });
  add('GET', '/api/runs', ({ query }) => engine.store.listRuns({ workflowId: query.workflowId, status: query.status, limit: query.limit ? Number(query.limit) : 50 }));
  add('GET', '/api/runs/:id', ({ params }) => engine.runDetail(params.id) ?? (() => { throw new EngineError('Запуск не найден', 404); })());
  add('POST', '/api/runs/:id/cancel', ({ params }) => engine.cancelRun(params.id));
  add('DELETE', '/api/runs/:id', ({ params }) => { const r = engine.store.getRunRow(params.id); if (!r) throw new EngineError('Запуск не найден', 404); if (!['succeeded', 'failed', 'cancelled'].includes(r.status)) throw new EngineError('Сначала отмените запуск', 409); engine.store.deleteRun(params.id); return { ok: true }; });
  add('GET', '/api/approvals', () => engine.listApprovals());
  add('POST', '/api/runs/:id/nodes/:nodeId/decision', ({ params, body }) => {
    if (body?.decision !== 'approved' && body?.decision !== 'rejected') throw new EngineError('decision: approved | rejected');
    engine.decideApproval(params.id, params.nodeId, body.decision, String(body.comment ?? '')); return { ok: true };
  });
  add('GET', '/api/credentials', () => engine.store.listCredentials());
  add('POST', '/api/credentials', ({ body }) => { const b = credentialSchema.parse(body); return { id: engine.saveCredential(null, b.name, b.type, b.data) }; });
  add('PUT', '/api/credentials/:id', ({ params, body }) => { const b = credentialSchema.parse(body); return { id: engine.saveCredential(params.id, b.name, b.type, b.data) }; });
  add('DELETE', '/api/credentials/:id', ({ params }) => { engine.deleteCredential(params.id); return { ok: true }; });
  add('GET', '/api/settings', () => engine.settings());
  add('PUT', '/api/settings', ({ body }) => { engine.setSettings(settingsSchema.parse(body)); return engine.settings(); });
  add('GET', '/api/examples', () => listExamples());
  add('POST', '/api/examples/:id/install', ({ params }) => installExample(engine, params.id));
  add('GET', '/api/pollers', () => engine.pollerStatuses());
  add('POST', '/api/backup', ({ body }) => {
    const target = String(body?.path ?? '');
    if (!path.isAbsolute(target) || !/\.sqlite$/i.test(target)) throw new EngineError('Путь резервной копии должен быть абсолютным и оканчиваться на .sqlite');
    engine.backupTo(target); return { ok: true, path: target };
  });

  const tokenBuf = crypto.createHash('sha256').update(opts.token).digest();
  const authOk = (h: string | undefined) => {
    const m = /^Bearer (.+)$/.exec(h ?? ''); if (!m) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), tokenBuf);
  };

  const readBody = (req: http.IncomingMessage, limit: number) => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > limit) { reject(new EngineError('Тело запроса слишком большое', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const data = JSON.stringify(body ?? null);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // защита от DNS-rebinding: принимаем только запросы к локальному имени
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 421, { error: 'Недопустимый Host' });

      if (url.pathname.startsWith('/hook/')) {
        const raw = await readBody(req, MAX_HOOK_BODY);
        let body: unknown = raw.toString('utf8');
        if (/json/i.test(req.headers['content-type'] ?? '') && raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Некорректный JSON' }); } }
        else if (!raw.length) body = null;
        const r = engine.handleWebhook(decodeURIComponent(url.pathname.slice(6)), req.method ?? 'GET', req.headers, Object.fromEntries(url.searchParams), body, req.socket.remoteAddress ?? '');
        return send(res, r.status, r.body);
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });
      if (!authOk(req.headers.authorization)) return send(res, 401, { error: 'Требуется авторизация' });
      const route = routes.find((r) => r.verb === req.method && r.re.test(url.pathname));
      if (!route) return send(res, routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, { error: 'Метод не найден' });
      const m = route.re.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body: any;
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const raw = await readBody(req, MAX_API_BODY);
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Некорректный JSON' }); } }
      }
      const out = await route.h({ params, query: Object.fromEntries(url.searchParams), body });
      send(res, 200, out);
    } catch (e) {
      if (e instanceof EngineError) return send(res, e.status, { error: engine.redactor.string(e.message), issues: e.issues });
      if (e instanceof ZodError) return send(res, 422, { error: 'Некорректные данные: ' + e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'запрос'}: ${i.message}`).join('; ') });
      console.error('API error', e);
      send(res, 500, { error: engine.redactor.string((e as Error).message || 'Внутренняя ошибка') });
    }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 60_000;
  return server;
}
