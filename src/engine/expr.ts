// Безопасный вычислитель выражений {{ ... }}. Без eval/Function/vm: собственный разбор и белый список функций.
import type { Item } from '../shared/types';

export class ExprError extends Error {}

export interface ExprContext {
  json: Record<string, unknown>;
  index: number;
  node(name: string): { json: Record<string, unknown>; items: Item[] } | undefined;
  runId: string;
  now: Date;
}

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string | number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: 'num', v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { const n = src[j + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; } else s += src[j++];
      }
      if (j >= src.length) throw new ExprError('Незакрытая строка в выражении');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[A-Za-z_$Ѐ-ӿ]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$Ѐ-ӿ]/.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '??'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!?:()[].,'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new ExprError(`Недопустимый символ «${c}» в выражении`);
  }
  return out;
}

type Ast =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'member'; obj: Ast; prop: Ast }
  | { k: 'call'; name: string; args: Ast[] }
  | { k: 'un'; op: string; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'cond'; c: Ast; a: Ast; b: Ast };

class Parser {
  p = 0;
  constructor(private toks: Tok[]) {}
  peek() { return this.toks[this.p]; }
  isOp(v: string) { const t = this.peek(); return t && t.t === 'op' && t.v === v; }
  eat(v: string) { if (!this.isOp(v)) throw new ExprError(`Ожидалось «${v}» в выражении`); this.p++; }
  parse(): Ast { const a = this.ternary(); if (this.p < this.toks.length) throw new ExprError('Лишние символы в конце выражения'); return a; }
  ternary(): Ast {
    const c = this.bin(0);
    if (this.isOp('?')) { this.p++; const a = this.ternary(); this.eat(':'); const b = this.ternary(); return { k: 'cond', c, a, b }; }
    return c;
  }
  static levels = [['??'], ['||'], ['&&'], ['==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
  bin(level: number): Ast {
    if (level >= Parser.levels.length) return this.unary();
    let a = this.bin(level + 1);
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && Parser.levels[level].includes(t.v as string)) { this.p++; a = { k: 'bin', op: t.v as string, a, b: this.bin(level + 1) }; } else return a;
    }
  }
  unary(): Ast {
    if (this.isOp('!') || this.isOp('-')) { const op = (this.peek().v as string); this.p++; return { k: 'un', op, a: this.unary() }; }
    return this.postfix();
  }
  postfix(): Ast {
    let a = this.primary();
    for (;;) {
      if (this.isOp('.')) {
        this.p++; const t = this.peek();
        if (!t || t.t !== 'id') throw new ExprError('Ожидалось имя поля после «.»');
        this.p++; a = { k: 'member', obj: a, prop: { k: 'lit', v: t.v } };
      } else if (this.isOp('[')) { this.p++; const idx = this.ternary(); this.eat(']'); a = { k: 'member', obj: a, prop: idx }; }
      else return a;
    }
  }
  primary(): Ast {
    const t = this.peek();
    if (!t) throw new ExprError('Выражение оборвано');
    this.p++;
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      const name = t.v as string;
      if (name === 'true') return { k: 'lit', v: true };
      if (name === 'false') return { k: 'lit', v: false };
      if (name === 'null') return { k: 'lit', v: null };
      if (this.isOp('(')) {
        this.p++; const args: Ast[] = [];
        if (!this.isOp(')')) { for (;;) { args.push(this.ternary()); if (this.isOp(',')) { this.p++; continue; } break; } }
        this.eat(')'); return { k: 'call', name, args };
      }
      return { k: 'id', name };
    }
    if (t.v === '(') { const a = this.ternary(); this.eat(')'); return a; }
    throw new ExprError(`Неожиданный символ «${String(t.v)}» в выражении`);
  }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
class NodeAccessor { constructor(public ctx: ExprContext) {} }

const toNum = (v: unknown) => (typeof v === 'number' ? v : Number(v));
const FUNCS: Record<string, (...a: any[]) => unknown> = {
  round: (x, n = 0) => { const m = 10 ** toNum(n); return Math.round(toNum(x) * m) / m; },
  floor: (x) => Math.floor(toNum(x)), ceil: (x) => Math.ceil(toNum(x)), abs: (x) => Math.abs(toNum(x)),
  min: (...a) => Math.min(...a.map(toNum)), max: (...a) => Math.max(...a.map(toNum)),
  number: (x) => toNum(x), string: (x) => (typeof x === 'string' ? x : x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x)),
  upper: (x) => String(x ?? '').toUpperCase(), lower: (x) => String(x ?? '').toLowerCase(), trim: (x) => String(x ?? '').trim(),
  length: (x) => (typeof x === 'string' || Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0),
  join: (arr, sep = ', ') => (Array.isArray(arr) ? arr.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(String(sep)) : ''),
  json: (x) => JSON.stringify(x),
  parseJson: (x) => { try { return JSON.parse(String(x)); } catch { throw new ExprError('parseJson: некорректный JSON'); } },
  replace: (s, a, b) => String(s ?? '').split(String(a)).join(String(b)),
  substring: (s, a, b) => String(s ?? '').substring(toNum(a), b === undefined ? undefined : toNum(b)),
  isEmpty: (x) => x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0),
  first: (a) => (Array.isArray(a) ? a[0] : undefined), last: (a) => (Array.isArray(a) ? a[a.length - 1] : undefined),
};

function evalAst(a: Ast, ctx: ExprContext): unknown {
  switch (a.k) {
    case 'lit': return a.v;
    case 'id':
      switch (a.name) {
        case '$json': return ctx.json;
        case '$index': return ctx.index;
        case '$node': return new NodeAccessor(ctx);
        case '$run': return { id: ctx.runId };
        case '$now': return ctx.now.toISOString();
        case '$today': return ctx.now.toISOString().slice(0, 10);
        default: throw new ExprError(`Неизвестная переменная «${a.name}». Доступно: $json, $node, $index, $run, $now, $today`);
      }
    case 'member': {
      const obj = evalAst(a.obj, ctx);
      const prop = evalAst(a.prop, ctx);
      if (obj instanceof NodeAccessor) {
        const n = obj.ctx.node(String(prop));
        if (!n) throw new ExprError(`Узел «${String(prop)}» не найден или ещё не выполнен`);
        return n;
      }
      if (obj === null || obj === undefined) return undefined;
      if (typeof prop === 'string' && FORBIDDEN.has(prop)) throw new ExprError('Доступ к служебным свойствам запрещён');
      if (Array.isArray(obj)) {
        if (prop === 'length') return obj.length;
        return typeof prop === 'number' ? obj[prop < 0 ? obj.length + prop : prop] : undefined;
      }
      if (typeof obj === 'string') return prop === 'length' ? obj.length : typeof prop === 'number' ? obj[prop] : undefined;
      if (typeof obj === 'object') return Object.hasOwn(obj as object, String(prop)) ? (obj as Record<string, unknown>)[String(prop)] : undefined;
      return undefined;
    }
    case 'call': {
      const f = Object.hasOwn(FUNCS, a.name) ? FUNCS[a.name] : undefined;
      if (!f) throw new ExprError(`Неизвестная функция «${a.name}»`);
      return f(...a.args.map((x) => evalAst(x, ctx)));
    }
    case 'un': { const v = evalAst(a.a, ctx); return a.op === '!' ? !v : -toNum(v); }
    case 'cond': return evalAst(a.c, ctx) ? evalAst(a.a, ctx) : evalAst(a.b, ctx);
    case 'bin': {
      if (a.op === '&&') { const l = evalAst(a.a, ctx); return l ? evalAst(a.b, ctx) : l; }
      if (a.op === '||') { const l = evalAst(a.a, ctx); return l ? l : evalAst(a.b, ctx); }
      if (a.op === '??') { const l = evalAst(a.a, ctx); return l ?? evalAst(a.b, ctx); }
      const l = evalAst(a.a, ctx); const r = evalAst(a.b, ctx);
      switch (a.op) {
        case '+': return typeof l === 'number' && typeof r === 'number' ? l + r : typeof l === 'string' || typeof r === 'string' ? String(l ?? '') + String(r ?? '') : toNum(l) + toNum(r);
        case '-': return toNum(l) - toNum(r);
        case '*': return toNum(l) * toNum(r);
        case '/': return toNum(l) / toNum(r);
        case '%': return toNum(l) % toNum(r);
        case '==': return l === r || (l !== null && r !== null && typeof l !== 'object' && typeof r !== 'object' && String(l) === String(r));
        case '!=': return !(l === r || (l !== null && r !== null && typeof l !== 'object' && typeof r !== 'object' && String(l) === String(r)));
        case '<': return toNum(l) < toNum(r);
        case '>': return toNum(l) > toNum(r);
        case '<=': return toNum(l) <= toNum(r);
        case '>=': return toNum(l) >= toNum(r);
      }
      throw new ExprError('Неизвестный оператор');
    }
  }
}

const astCache = new Map<string, Ast>();
export function evalExpression(src: string, ctx: ExprContext): unknown {
  let ast = astCache.get(src);
  if (!ast) {
    if (src.length > 2000) throw new ExprError('Выражение слишком длинное');
    ast = new Parser(tokenize(src)).parse();
    if (astCache.size > 500) astCache.clear();
    astCache.set(src, ast);
  }
  const v = evalAst(ast, ctx);
  return v instanceof NodeAccessor ? undefined : v;
}

const TPL = /\{\{([\s\S]+?)\}\}/g;

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Строка с {{ }}: если вся строка — одно выражение, возвращается типизированное значение. */
export function resolveTemplate(s: string, ctx: ExprContext): unknown {
  if (!s.includes('{{')) return s;
  const only = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(s);
  if (only && !only[1].includes('}}')) return evalExpression(only[1], ctx);
  return s.replace(TPL, (_m, e: string) => stringify(evalExpression(e, ctx)));
}

export function resolveDeep(v: unknown, ctx: ExprContext, depth = 0): unknown {
  if (depth > 20) return v;
  if (typeof v === 'string') return resolveTemplate(v, ctx);
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, ctx, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, ctx, depth + 1)]));
  return v;
}
