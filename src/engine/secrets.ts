import crypto from 'node:crypto';

export function generateMasterKey(): Buffer { return crypto.randomBytes(32); }

export function encryptString(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptString(key: Buffer, blob: string): string {
  if (!blob.startsWith('v1:')) throw new Error('Неизвестный формат шифрования');
  const buf = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try { return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); }
  catch { throw new Error('Не удалось расшифровать секрет: мастер-ключ не подходит (данные созданы на другом компьютере/профиле?)'); }
}

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-webhook-secret|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|bot[-_]?token)$/i;
const MIN_SECRET_LEN = 6;

/** Маскирует известные секреты и значения «чувствительных» ключей в любых данных. */
export class Redactor {
  private secrets = new Set<string>();
  private pattern: RegExp | null = null;

  setSecrets(values: Iterable<string>): void {
    this.secrets = new Set([...values].filter((v) => v && v.length >= MIN_SECRET_LEN));
    this.pattern = null;
  }
  add(value: string): void { if (value && value.length >= MIN_SECRET_LEN) { this.secrets.add(value); this.pattern = null; } }

  private regex(): RegExp | null {
    if (this.secrets.size === 0) return null;
    if (!this.pattern) {
      const parts = [...this.secrets].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      this.pattern = new RegExp(parts.join('|'), 'g');
    }
    return this.pattern;
  }

  string(s: string): string {
    let out = s;
    const re = this.regex();
    if (re) out = out.replace(re, '***');
    // токены Telegram в URL и Bearer в тексте
    out = out.replace(/\/bot\d{5,}:[\w-]{20,}/g, '/bot***').replace(/(Bearer\s+)[\w.~+/=-]{8,}/gi, '$1***');
    return out;
  }

  value<T>(v: T, depth = 0): T {
    if (depth > 30) return v;
    if (typeof v === 'string') return this.string(v) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1)) as unknown as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      const obj = v as Record<string, unknown>;
      // строки списков «ключ/значение» (заголовки, параметры): маскируем значение по имени ключа
      const kvSensitive = typeof obj.key === 'string' && SENSITIVE_KEY.test(obj.key.trim());
      for (const [k, x] of Object.entries(obj)) {
        const sensitive = SENSITIVE_KEY.test(k) || (kvSensitive && k === 'value');
        out[k] = sensitive && x !== null && x !== undefined && x !== '' ? '***' : this.value(x, depth + 1);
      }
      return out as T;
    }
    return v;
  }
}
