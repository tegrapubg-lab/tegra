import type { Item } from '../../shared/types';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function getPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || FORBIDDEN.has(part) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('Пустое имя поля');
  if (parts.some((p) => FORBIDDEN.has(p))) throw new Error(`Недопустимое имя поля «${path}»`);
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const nxt = cur[parts[i]];
    if (!nxt || typeof nxt !== 'object' || Array.isArray(nxt)) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export const items = (arr: Record<string, unknown>[]): Item[] => arr.map((json) => ({ json }));

export function compare(op: string, left: unknown, right: unknown): boolean {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const empty = (v: unknown) => v === undefined || v === null || v === '';
  switch (op) {
    case 'equals': return left === right || (!empty(left) && !empty(right) && typeof left !== 'object' && typeof right !== 'object' && str(left) === str(right)) || (empty(left) && empty(right));
    case 'notEquals': return !compare('equals', left, right);
    case 'contains': return Array.isArray(left) ? left.some((x) => str(x) === str(right)) : str(left).includes(str(right));
    case 'notContains': return !compare('contains', left, right);
    case 'startsWith': return str(left).startsWith(str(right));
    case 'endsWith': return str(left).endsWith(str(right));
    case 'gt': return num(left) > num(right);
    case 'gte': return num(left) >= num(right);
    case 'lt': return num(left) < num(right);
    case 'lte': return num(left) <= num(right);
    case 'exists': return !empty(left);
    case 'notExists': return empty(left);
    case 'isTrue': return left === true || str(left).toLowerCase() === 'true';
    case 'isFalse': return left === false || str(left).toLowerCase() === 'false';
  }
  throw new Error(`Неизвестное условие «${op}»`);
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
