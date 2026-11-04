import type { Item } from '../../shared/types';
import { SPEC_BY_TYPE } from '../../shared/specs';
import { guardedFetch } from '../netguard';
import type { CredentialData, NodeImpl } from './types';

export function tgBase(cred: CredentialData): { base: string; explicit: boolean } {
  const custom = cred.data.apiBase?.trim();
  return { base: (custom || 'https://api.telegram.org').replace(/\/+$/, ''), explicit: !!custom };
}

/** Вызов Bot API. Токен никогда не попадает в сообщения об ошибках. */
export interface Multipart { fields: Record<string, string>; file: { field: string; name: string; type: string; content: Buffer } }

/** multipart/form-data вручную: встроенный FormData Node несовместим с undici из пакета. */
function encodeMultipart(m: Multipart): { body: Buffer; contentType: string } {
  const boundary = '----tegra' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(m.fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const name = m.file.name.replace(/["\r\n]/g, '_');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${m.file.field}"; filename="${name}"\r\nContent-Type: ${m.file.type}\r\n\r\n`), m.file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function tgCall(cred: CredentialData, method: string, payload: Record<string, unknown> | Multipart, signal?: AbortSignal): Promise<any> {
  const { base, explicit } = tgBase(cred);
  const url = `${base}/bot${cred.data.token}/${method}`;
  const isForm = 'file' in payload && 'fields' in payload;
  const mp = isForm ? encodeMultipart(payload as Multipart) : null;
  const res = await guardedFetch({
    url, method: 'POST', headers: { 'content-type': mp ? mp.contentType : 'application/json' },
    body: mp ? mp.body : JSON.stringify(payload), allowPrivate: explicit,
    maxBytes: 5 * 1024 * 1024, signal,
  });
  let j: any;
  try { j = JSON.parse(res.body.toString('utf8')); } catch { throw new Error(`Telegram вернул не-JSON (HTTP ${res.status})`); }
  if (!j.ok) {
    const e = new Error(`Telegram: ${j.description ?? 'ошибка'} (код ${j.error_code ?? res.status})`) as Error & { code?: number };
    e.code = j.error_code; throw e;
  }
  return j.result;
}

function chunks(text: string, size = 4000): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

export const telegramSendNode: NodeImpl = {
  spec: SPEC_BY_TYPE['telegram.send'],
  async execute(ctx) {
    const cred = ctx.svc.getCredential(ctx.str('credential'));
    if (cred.type !== 'telegramBot') throw new Error('Выбранное подключение не является Telegram-ботом');
    const out: Item[] = [];
    for (let i = 0; i < ctx.items.length; i++) {
      const chatId = ctx.str('chatId', i).trim();
      if (!chatId) throw new Error('Не указан chat id');
      const mode = ctx.str('mode', i) || 'text';
      let msgIds: number[] = [];
      if (mode === 'text') {
        const text = ctx.str('text', i);
        if (!text.trim()) throw new Error('Пустой текст сообщения');
        for (const part of chunks(text)) { const r = await tgCall(cred, 'sendMessage', { chat_id: chatId, text: part }, ctx.signal); msgIds.push(r.message_id); }
      } else if (mode === 'documentUrl') {
        const r = await tgCall(cred, 'sendDocument', { chat_id: chatId, document: ctx.str('fileUrl', i), caption: ctx.str('text', i).slice(0, 1000) }, ctx.signal);
        msgIds = [r.message_id];
      } else {
        const content = ctx.str('fileContent', i);
        if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new Error('Файл больше 10 МБ');
        const caption = ctx.str('text', i).slice(0, 1000);
        const fileName = ctx.str('fileName', i).replace(/[^\w.\-а-яА-ЯёЁ ]/g, '_') || 'result.txt';
        const r = await tgCall(cred, 'sendDocument', { fields: { chat_id: chatId, ...(caption ? { caption } : {}) }, file: { field: 'document', name: fileName, type: 'text/plain; charset=utf-8', content: Buffer.from(content, 'utf8') } }, ctx.signal);
        msgIds = [r.message_id];
      }
      out.push({ json: { ...ctx.items[i].json, telegram: { chatId, messageIds: msgIds, sent: true } } });
    }
    return { outputs: { main: out }, summary: `Отправлено в Telegram: ${out.length}` };
  },
};
