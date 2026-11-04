import crypto from 'node:crypto';
import type { CredentialData } from './nodes/types';
import { tgCall } from './nodes/telegram';

export interface TelegramMessageEvent { tokenHash: string; updateId: number; json: Record<string, unknown> }

export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);

export interface PollerStatus { tokenHash: string; running: boolean; lastPollAt: string | null; lastError: string | null; received: number; credentialName: string }

/** Один long-polling получатель на один токен бота. */
export class TelegramPoller {
  status: PollerStatus;
  private ctl = new AbortController();
  private done: Promise<void> = Promise.resolve();

  constructor(
    private cred: CredentialData, private getOffset: () => number, private saveOffset: (n: number) => void,
    private onMessage: (e: TelegramMessageEvent) => void, private pollTimeoutSec: number, private now: () => number,
  ) {
    this.status = { tokenHash: tokenHash(cred.data.token ?? ''), running: false, lastPollAt: null, lastError: null, received: 0, credentialName: cred.name };
  }

  start() {
    if (this.status.running) return;
    this.status.running = true;
    this.done = this.loop();
  }

  async stop() { this.ctl.abort(); this.status.running = false; await this.done.catch(() => {}); }

  private async sleep(ms: number) { await new Promise<void>((r) => { const t = setTimeout(r, ms); this.ctl.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); }

  private async loop() {
    let failures = 0;
    while (!this.ctl.signal.aborted) {
      try {
        const updates = await tgCall(this.cred, 'getUpdates', { offset: this.getOffset(), timeout: this.pollTimeoutSec, allowed_updates: ['message'] }, this.ctl.signal) as any[];
        this.status.lastPollAt = new Date(this.now()).toISOString(); this.status.lastError = null; failures = 0;
        for (const u of updates) {
          const m = u.message;
          if (m) {
            this.status.received++;
            this.onMessage({
              tokenHash: this.status.tokenHash, updateId: u.update_id,
              json: {
                updateId: u.update_id, chatId: String(m.chat?.id), chatType: m.chat?.type, messageId: m.message_id, text: m.text ?? m.caption ?? '',
                hasMedia: !!(m.photo || m.document || m.video || m.voice || m.audio),
                from: { id: m.from?.id, username: m.from?.username ?? null, firstName: m.from?.first_name ?? null }, date: m.date,
              },
            });
          }
          this.saveOffset(u.update_id + 1);
        }
        if (updates.length === 0 && this.pollTimeoutSec === 0) await this.sleep(500);
      } catch (e) {
        if (this.ctl.signal.aborted) return;
        const err = e as Error & { code?: number };
        failures++;
        this.status.lastError = err.code === 409
          ? 'Конфликт (409): этот бот уже опрашивается другим приложением или webhook. Закройте другой получатель.'
          : err.message;
        await this.sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) * (err.code === 409 ? 3 : 1));
      }
    }
  }
}
