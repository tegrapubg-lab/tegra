import type { Item } from '../../shared/types';
import { SPEC_BY_TYPE } from '../../shared/specs';
import { guardedFetch } from '../netguard';
import type { NodeImpl } from './types';

type KV = { key?: string; value?: unknown };
const kvToObj = (list: unknown): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const r of (Array.isArray(list) ? list : []) as KV[]) if (r?.key) o[String(r.key)] = r.value === undefined || r.value === null ? '' : typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value);
  return o;
};

export const httpNode: NodeImpl = {
  spec: SPEC_BY_TYPE['http.request'],
  async execute(ctx) {
    const out: Item[] = [];
    const maxBytes = Math.min(ctx.num('maxResponseKb', 0, 5120), 25600) * 1024;
    const credId = ctx.str('auth');
    const cred = credId ? ctx.svc.getCredential(credId) : null;
    for (let i = 0; i < ctx.items.length; i++) {
      const method = (ctx.str('method', i) || 'GET').toUpperCase();
      const u = new URL(ctx.str('url', i));
      for (const [k, v] of Object.entries(kvToObj(ctx.param('query', i)))) u.searchParams.set(k, v);
      const headers = Object.fromEntries(Object.entries(kvToObj(ctx.param('headers', i))).map(([k, v]) => [k.toLowerCase(), v]));
      if (cred) {
        const d = cred.data;
        if (d.scheme === 'basic') headers.authorization = 'Basic ' + Buffer.from(`${d.username ?? ''}:${d.password ?? ''}`).toString('base64');
        else if (d.scheme === 'header') headers[(d.headerName || 'x-api-key').toLowerCase()] = d.token ?? '';
        else headers.authorization = `Bearer ${d.token ?? ''}`;
      }
      let body: string | undefined;
      const bodyType = ctx.str('bodyType') || 'none';
      if (bodyType !== 'none' && method !== 'GET' && method !== 'HEAD') {
        const raw = ctx.param('body', i);
        body = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        if (bodyType === 'json') { try { JSON.parse(body); } catch { throw new Error('Тело запроса не является корректным JSON'); } headers['content-type'] ??= 'application/json'; }
        else if (bodyType === 'form') headers['content-type'] ??= 'application/x-www-form-urlencoded';
        else headers['content-type'] ??= 'text/plain; charset=utf-8';
      }
      if (ctx.bool('idempotency')) headers['idempotency-key'] ??= `${ctx.runId}:${ctx.node.id}:${i}`;
      const res = await guardedFetch({
        url: u.toString(), method, headers, body, allowPrivate: ctx.bool('allowPrivate'),
        followRedirects: ctx.raw('followRedirects') !== false, maxBytes, signal: ctx.signal,
      });
      const ct = res.headers['content-type'] ?? '';
      const text = res.body.toString('utf8');
      let parsed: unknown = text;
      if (/json/i.test(ct) || /^\s*[[{]/.test(text)) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
      const ok = res.status >= 200 && res.status < 300;
      if (!ok && !ctx.bool('neverError')) {
        throw new Error(`HTTP ${res.status} ${res.statusText} от ${u.origin}${u.pathname}: ${text.slice(0, 200)}`);
      }
      out.push({ json: { status: res.status, ok, headers: res.headers, body: parsed, url: res.finalUrl } });
      ctx.log(`${method} ${u.origin}${u.pathname} → ${res.status}`);
    }
    const last = out[out.length - 1]?.json as { status?: number } | undefined;
    return { outputs: { main: out }, summary: out.length === 1 ? `HTTP ${last?.status}` : `Запросов: ${out.length}, последний HTTP ${last?.status}` };
  },
};
