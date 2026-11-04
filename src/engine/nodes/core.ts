import type { Item } from '../../shared/types';
import { SPEC_BY_TYPE } from '../../shared/specs';
import type { NodeImpl } from './types';
import { resolveDeep } from '../expr';
import { compare, getPath, setPath } from './util';

const spec = (t: string) => SPEC_BY_TYPE[t];

const triggerImpl = (type: string): NodeImpl => ({
  spec: spec(type),
  async execute(ctx) {
    const out = ctx.triggerData.length ? ctx.triggerData : [{ json: {} }];
    return { outputs: { main: out }, summary: `Запуск: ${out.length} эл.` };
  },
});

function convert(value: unknown, type: string, name: string): unknown {
  switch (type) {
    case 'string': return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': { const n = typeof value === 'number' ? value : Number(value); if (!Number.isFinite(n)) throw new Error(`Поле «${name}»: «${String(value)}» не число`); return n; }
    case 'boolean': return typeof value === 'string' ? ['true', '1', 'да', 'yes'].includes(value.toLowerCase()) : !!value;
    case 'json': if (typeof value === 'string') { try { return JSON.parse(value); } catch { throw new Error(`Поле «${name}»: некорректный JSON`); } } return value;
    default: return value;
  }
}

const setNode: NodeImpl = {
  spec: spec('core.set'),
  async execute(ctx) {
    const mode = ctx.str('mode') || 'add';
    const out: Item[] = ctx.items.map((it, i) => {
      const assignments = (ctx.raw('assignments') as { name: string; value: unknown; type?: string }[]) ?? [];
      const json: Record<string, unknown> = mode === 'only' ? {} : structuredClone(it.json);
      // Строки выполняются по порядку и видят уже заданные поля ($json — текущий результат).
      // Исходный элемент доступен как $node["Имя предыдущего узла"].
      for (const a of assignments) {
        if (!a.name) continue;
        let value: unknown;
        try { value = resolveDeep(a.value, { ...ctx.exprCtx(i), json: mode === 'only' ? { ...it.json, ...json } : json }); }
        catch (e) { throw new Error(`Поле «${a.name}»: ${(e as Error).message}`); }
        setPath(json, a.name, convert(value, a.type ?? 'auto', a.name));
      }
      return { json };
    });
    return { outputs: { main: out }, summary: `Обработано элементов: ${out.length}` };
  },
};

function evalConditions(ctx: Parameters<NodeImpl['execute']>[0], i: number): boolean {
  const conds = (ctx.param('conditions', i) as { left: unknown; op: string; right: unknown }[]) ?? [];
  const results = conds.map((c) => compare(c.op, c.left, c.right));
  return ctx.str('combinator') === 'or' ? results.some(Boolean) : results.every(Boolean);
}

const ifNode: NodeImpl = {
  spec: spec('core.if'),
  async execute(ctx) {
    const t: Item[] = []; const f: Item[] = [];
    ctx.items.forEach((it, i) => (evalConditions(ctx, i) ? t : f).push(it));
    return { outputs: { true: t, false: f }, summary: `Да: ${t.length}, Нет: ${f.length}` };
  },
};

const switchNode: NodeImpl = {
  spec: spec('core.switch'),
  async execute(ctx) {
    const outs: Record<string, Item[]> = { case1: [], case2: [], case3: [], case4: [], other: [] };
    ctx.items.forEach((it, i) => {
      const value = ctx.param('value', i);
      const rules = (ctx.param('rules', i) as { op: string; right: unknown }[]) ?? [];
      const idx = rules.findIndex((r) => compare(r.op, value, r.right));
      outs[idx >= 0 ? `case${idx + 1}` : 'other'].push(it);
    });
    return { outputs: outs, summary: Object.entries(outs).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.length}`).join(', ') || 'нет элементов' };
  },
};

const splitNode: NodeImpl = {
  spec: spec('core.splitOut'),
  async execute(ctx) {
    const field = ctx.str('field');
    const keep = ctx.bool('keepParent');
    const out: Item[] = [];
    for (const it of ctx.items) {
      const v = getPath(it.json, field);
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v)) throw new Error(`Поле «${field}» не является списком`);
      for (const el of v) {
        const json = el && typeof el === 'object' && !Array.isArray(el) ? { ...(el as Record<string, unknown>) } : { value: el };
        if (keep) { const { [field]: _omit, ...rest } = it.json; (json as Record<string, unknown>).parent = rest; }
        out.push({ json });
      }
    }
    return { outputs: { main: out }, summary: `Получено элементов: ${out.length}` };
  },
};

const mergeNode: NodeImpl = {
  spec: spec('core.merge'),
  async execute(ctx) {
    const a = ctx.inputs.a ?? []; const b = ctx.inputs.b ?? [];
    if (ctx.bool('requireBoth') && (a.length === 0 || b.length === 0)) return { skip: 'Одна из веток не передала данные' };
    if (ctx.str('mode') === 'zip') {
      const n = Math.max(a.length, b.length);
      const out: Item[] = [];
      for (let i = 0; i < n; i++) out.push({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } });
      return { outputs: { main: out }, summary: `Объединено попарно: ${out.length}` };
    }
    return { outputs: { main: [...a, ...b] }, summary: `A: ${a.length} + B: ${b.length}` };
  },
};

const repeatNode: NodeImpl = {
  spec: spec('core.repeat'),
  async execute(ctx) {
    const n = Math.floor(ctx.num('count', 0, 1));
    if (n < 1 || n > 1000) throw new Error('Количество повторов должно быть от 1 до 1000');
    return { outputs: { main: Array.from({ length: n }, (_, index) => ({ json: { index } })) }, summary: `Повторов: ${n}` };
  },
};

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

const waitNode: NodeImpl = {
  spec: spec('core.wait'),
  async execute(ctx) {
    let at: number;
    if (ctx.str('mode') === 'until') {
      at = Date.parse(ctx.str('until'));
      if (!Number.isFinite(at)) throw new Error('Некорректная дата ожидания (нужен формат ISO, например 2026-12-01T09:00:00+03:00)');
    } else {
      at = ctx.svc.now() + ctx.num('amount', 0, 0) * (UNIT_MS[ctx.str('unit') || 'seconds'] ?? 1000);
    }
    if (at <= ctx.svc.now()) return { outputs: { main: ctx.items }, summary: 'Ждать не нужно' };
    return { wait: { kind: 'timer', resumeAt: new Date(at).toISOString() }, summary: `Ожидание до ${new Date(at).toISOString()}` };
  },
  async resume(ctx) { return { outputs: { main: ctx.items }, summary: 'Ожидание завершено' }; },
};

const subworkflowNode: NodeImpl = {
  spec: spec('core.subworkflow'),
  async execute(ctx) {
    const id = ctx.str('workflowId');
    const name = ctx.svc.workflowName(id);
    if (!name) throw new Error('Вложенный сценарий не найден (возможно, удалён)');
    const childId = ctx.svc.startChildRun(ctx.runId, ctx.node.id, id, ctx.items);
    return { wait: { kind: 'child', childRunId: childId, message: `Вложенный сценарий «${name}»` }, summary: `Запущен «${name}»` };
  },
  async resume(_ctx, wait, payload) {
    if (payload.status !== 'succeeded') throw new Error(`Вложенный сценарий завершился со статусом «${String(payload.status)}»${payload.error ? `: ${String(payload.error)}` : ''}`);
    const out = (payload.items as Item[]) ?? [];
    return { outputs: { main: out }, summary: `Вложенный сценарий вернул ${out.length} эл.` };
  },
};

const resultNode: NodeImpl = {
  spec: spec('core.result'),
  async execute(ctx) { return { outputs: { main: ctx.items }, summary: `Результат: ${ctx.items.length} эл.` }; },
};

const approvalNode: NodeImpl = {
  spec: spec('core.approval'),
  async execute(ctx) {
    const hours = ctx.num('timeoutHours', 0, 0);
    const onTimeout = ctx.str('onTimeout') === 'approved' ? 'approved' : 'rejected';
    return {
      wait: {
        kind: 'approval', message: ctx.str('message', 0),
        resumeAt: hours > 0 ? new Date(ctx.svc.now() + hours * 3_600_000).toISOString() : null,
        timeoutPayload: { decision: onTimeout, timedOut: true, comment: 'Тайм-аут ожидания решения' },
      },
      summary: 'Ожидает решения пользователя',
    };
  },
  async resume(ctx, _wait, payload) {
    const decision = payload.decision === 'approved' ? 'approved' : 'rejected';
    const out = ctx.items.map((it) => ({ json: { ...it.json, decision, decisionComment: String(payload.comment ?? ''), decisionTimedOut: !!payload.timedOut } }));
    return { outputs: { approved: decision === 'approved' ? out : [], rejected: decision === 'rejected' ? out : [] }, summary: decision === 'approved' ? 'Продолжить' : 'Отклонено' };
  },
};

export const coreNodes: NodeImpl[] = [
  triggerImpl('trigger.manual'), triggerImpl('trigger.webhook'), triggerImpl('trigger.schedule'), triggerImpl('trigger.telegram'),
  setNode, ifNode, switchNode, splitNode, mergeNode, repeatNode, waitNode, subworkflowNode, resultNode, approvalNode,
];
