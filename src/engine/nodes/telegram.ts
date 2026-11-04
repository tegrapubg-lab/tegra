import type { Item } from '../../shared/types';
import { SPEC_BY_TYPE } from '../../shared/specs';
import { guardedFetch } from '../netguard';
import type { CredentialData, NodeImpl } from './types';

export function tgBase(cred: CredentialData): { base: string; explicit: boolean } {
  const custom = cred.data.apiBase?.trim();
  return { base: (custom || 'https://api.telegram.org').replace(/\/+$/, ''), explicit: !!custom };
}

/** Вызов Bot API. Токен никогда не попадает в сообщения об ошибках. */
export async function tgCall(cred: CredentialData, method: string, payload: Record<string, unknown> | FormData, signal?: AbortSignal, timeoutSec = 0): Promise<any> {
  const { base, explicit } = tgBase(cred);
  const url = `${base}/bot${cred.data.token}/${method}`;
  const isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
  const res = await guardedFetch({
    url, method: 'POST', headers: isForm ? {} : { 'content-type': 'application/json' },
    body: isForm ? (payload as FormData) : JSON.stringify(payload), allowPrivate: explicit,
    maxBytes: 5 * 1024 * 1024, signal,
  });
  let j: any;
  try { j = JSON.parse(res.body.toString('utf8')); } catch { throw new Error(`Telegram вернул не-JSON (HTTP ${res.status})`); }
  if (!j.ok) {
    const e = new Error(`Telegram: ${j.description ?? 'ошибка'} (код ${j.error_code ?? res.status})`) as Error & { code?: number };
    e.code = j.error_code; throw e;
  }
  void timeoutSec;
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
        const form = new FormData();
        form.set('chat_id', chatId);
        const caption = ctx.str('text', i).slice(0, 1000);
        if (caption) form.set('caption', caption);
        form.set('document', new Blob([content], { type: 'text/plain' }), ctx.str('fileName', i).replace(/[^\w.\-а-яА-ЯёЁ ]/g, '_') || 'result.txt');
        const r = await tgCall(cred, 'sendDocument', form, ctx.signal);
        msgIds = [r.message_id];
      }
      out.push({ json: { ...ctx.items[i].json, telegram: { chatId, messageIds: msgIds, sent: true } } });
    }
    return { outputs: { main: out }, summary: `Отправлено в Telegram: ${out.length}` };
  },
};
