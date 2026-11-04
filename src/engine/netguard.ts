// Защита от SSRF: проверка адресов, ручная обработка перенаправлений, лимиты размера.
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as ufetch } from 'undici';

export class NetError extends Error {}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (hexMapped) { const hi = parseInt(hexMapped[1], 16); const lo = parseInt(hexMapped[2], 16); return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return /^(fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:|ff[0-9a-f]{2}:)/.test(l);
  }
  return false;
}

function checkUrl(u: URL, allowPrivate: boolean): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NetError(`Протокол «${u.protocol}» не поддерживается (только http/https)`);
  if (u.username || u.password) throw new NetError('Логин и пароль в URL запрещены — используйте подключение «Авторизация HTTP»');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new NetError(`Адрес «${host}» локальный. Доступ к локальным сервисам нужно включить явно в настройках узла.`);
    if (net.isIP(host) && isPrivateAddress(host)) throw new NetError(`Адрес ${host} приватный/локальный. Доступ к локальным сервисам нужно включить явно в настройках узла.`);
  }
}

const agents = new Map<boolean, Agent>();
function agentFor(allowPrivate: boolean): Agent {
  let a = agents.get(allowPrivate);
  if (!a) {
    a = new Agent({
      connect: {
        // Проверка на этапе соединения защищает и от DNS-rebinding.
        lookup: (hostname, options, cb) => {
          dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addrs) => {
            if (err) return (cb as any)(err);
            const list = addrs as dns.LookupAddress[];
            const ok = allowPrivate ? list : list.filter((x) => !isPrivateAddress(x.address));
            if (ok.length === 0) return (cb as any)(new NetError(`Адрес «${hostname}» указывает на приватную сеть. Доступ нужно включить явно в настройках узла.`));
            if ((options as dns.LookupOptions).all) (cb as any)(null, ok);
            else (cb as any)(null, ok[0].address, ok[0].family);
          });
        },
      },
    });
    agents.set(allowPrivate, a);
  }
  return a;
}

export interface GuardedRequest {
  url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array | FormData | null;
  allowPrivate?: boolean; followRedirects?: boolean; maxBytes?: number; signal?: AbortSignal; maxRedirects?: number;
}
export interface GuardedResponse { status: number; statusText: string; headers: Record<string, string>; body: Buffer; finalUrl: string }

export async function guardedFetch(req: GuardedRequest): Promise<GuardedResponse> {
  const allowPrivate = !!req.allowPrivate;
  const maxBytes = req.maxBytes ?? 5 * 1024 * 1024;
  let url = new URL(req.url);
  let method = (req.method ?? 'GET').toUpperCase();
  let body = req.body ?? null;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  const originalOrigin = url.origin;
  const maxRedirects = req.maxRedirects ?? 5;

  for (let hop = 0; ; hop++) {
    checkUrl(url, allowPrivate);
    let res;
    try {
      res = await ufetch(url, { method, headers, body: body as any, redirect: 'manual', signal: req.signal, dispatcher: agentFor(allowPrivate) });
    } catch (e) {
      const err = e as Error & { cause?: Error };
      if (err.cause instanceof NetError) throw err.cause;
      if (err.name === 'AbortError' || req.signal?.aborted) throw err;
      throw new NetError(`Сетевая ошибка: ${err.cause?.message ?? err.message}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location') && req.followRedirects !== false) {
      if (hop >= maxRedirects) throw new NetError(`Слишком много перенаправлений (больше ${maxRedirects})`);
      await res.body?.cancel().catch(() => {});
      url = new URL(res.headers.get('location')!, url);
      if (url.origin !== originalOrigin) { delete headers['authorization']; delete headers['Authorization']; delete headers['cookie']; delete headers['Cookie']; }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = null; delete headers['content-type']; delete headers['Content-Type']; }
      continue;
    }
    const chunks: Buffer[] = []; let size = 0;
    if (res.body) {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) { await res.body.cancel().catch(() => {}); throw new NetError(`Ответ больше лимита ${Math.round(maxBytes / 1024)} КБ`); }
        chunks.push(Buffer.from(chunk));
      }
    }
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    return { status: res.status, statusText: res.statusText, headers: h, body: Buffer.concat(chunks), finalUrl: url.toString() };
  }
}
