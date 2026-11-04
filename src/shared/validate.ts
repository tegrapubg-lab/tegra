import { SPEC_BY_TYPE, type FieldSpec, type NodeSpec } from './specs';
import type { ValidationIssue, WorkflowDefinition, WorkflowNode } from './types';

export const hasExpression = (v: unknown): boolean => typeof v === 'string' && v.includes('{{');

export function isFieldVisible(field: FieldSpec, params: Record<string, unknown>): boolean {
  if (!field.showIf) return true;
  const cur = params[field.showIf.field];
  const eq = field.showIf.equals;
  return Array.isArray(eq) ? eq.includes(cur) : cur === eq;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function validateFields(fields: FieldSpec[], params: Record<string, unknown>, prefix = ''): string[] {
  const errs: string[] = [];
  for (const f of fields) {
    if (!isFieldVisible(f, params)) continue;
    const label = prefix + f.label;
    const v = params[f.name];
    if (f.required && isEmpty(v)) { errs.push(`Поле «${label}» обязательно`); continue; }
    if (isEmpty(v)) continue;
    switch (f.kind) {
      case 'number': {
        if (hasExpression(v)) break;
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) errs.push(`Поле «${label}» должно быть числом`);
        else {
          if (f.min !== undefined && n < f.min) errs.push(`Поле «${label}»: минимум ${f.min}`);
          if (f.max !== undefined && n > f.max) errs.push(`Поле «${label}»: максимум ${f.max}`);
        }
        break;
      }
      case 'select':
        if (f.options && !hasExpression(v) && !f.options.some((o) => o.value === v)) errs.push(`Поле «${label}»: недопустимое значение`);
        break;
      case 'json':
        if (typeof v === 'string' && !hasExpression(v)) { try { JSON.parse(v); } catch { errs.push(`Поле «${label}»: некорректный JSON`); } }
        break;
      case 'list': {
        if (!Array.isArray(v)) { errs.push(`Поле «${label}» должно быть списком`); break; }
        if (f.maxItems && v.length > f.maxItems) errs.push(`Поле «${label}»: не больше ${f.maxItems} строк`);
        v.forEach((row, i) => {
          if (!row || typeof row !== 'object') { errs.push(`Поле «${label}», строка ${i + 1}: неверный формат`); return; }
          errs.push(...validateFields(f.itemFields ?? [], row as Record<string, unknown>, `${label} #${i + 1} → `));
        });
        break;
      }
      case 'tools':
        if (!Array.isArray(v)) errs.push(`Поле «${label}» должно быть списком`);
        break;
    }
  }
  return errs;
}

/** Дополнительные проверки, зависящие от типа узла. */
function extraNodeChecks(node: WorkflowNode, spec: NodeSpec): string[] {
  const p = node.params;
  const errs: string[] = [];
  if (spec.type === 'trigger.schedule') {
    if (p.mode === 'cron' && !p.cron) errs.push('Укажите cron-выражение');
    if (p.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: String(p.timezone) }); } catch { errs.push(`Неизвестный часовой пояс «${String(p.timezone)}»`); } }
  }
  if (spec.type === 'core.wait' && p.mode === 'until' && !p.until) errs.push('Укажите дату и время ожидания');
  if (spec.type === 'telegram.send') {
    if (p.mode === 'documentUrl' && !p.fileUrl) errs.push('Укажите URL файла');
    if (p.mode === 'documentText' && !p.fileContent) errs.push('Укажите содержимое файла');
    if ((p.mode ?? 'text') === 'text' && !p.text) errs.push('Укажите текст сообщения');
  }
  return errs;
}

export function validateWorkflow(def: WorkflowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, WorkflowNode>();
  const names = new Map<string, string>();

  for (const n of def.nodes) {
    if (byId.has(n.id)) issues.push({ level: 'error', nodeId: n.id, message: `Дублирующийся id узла «${n.id}»` });
    byId.set(n.id, n);
    const prev = names.get(n.name);
    if (prev) issues.push({ level: 'error', nodeId: n.id, message: `Имя узла «${n.name}» используется дважды — имена должны быть уникальны` });
    names.set(n.name, n.id);
  }

  for (const n of def.nodes) {
    const spec = SPEC_BY_TYPE[n.type];
    if (!spec) { issues.push({ level: 'error', nodeId: n.id, message: `Неизвестный тип узла «${n.type}»` }); continue; }
    for (const m of validateFields(spec.params, n.params ?? {})) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: ${m}` });
    for (const m of extraNodeChecks(n, spec)) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: ${m}` });
    const s = n.settings;
    if (s?.maxAttempts !== undefined && (s.maxAttempts < 1 || s.maxAttempts > 10)) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: попыток должно быть от 1 до 10` });
    if (s?.timeoutMs !== undefined && (s.timeoutMs < 100 || s.timeoutMs > 3_600_000)) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: тайм-аут от 100 мс до 1 часа` });
  }

  const seenEdges = new Set<string>();
  const incoming = new Map<string, number>();
  for (const e of def.edges) {
    const s = byId.get(e.source); const t = byId.get(e.target);
    if (!s || !t) { issues.push({ level: 'error', message: `Соединение ссылается на несуществующий узел` }); continue; }
    const ss = SPEC_BY_TYPE[s.type]; const ts = SPEC_BY_TYPE[t.type];
    if (!ss || !ts) continue;
    if (!ss.outputs.some((o) => o.id === e.sourceHandle)) issues.push({ level: 'error', nodeId: s.id, message: `${s.name}: нет выхода «${e.sourceHandle}»` });
    if (!ts.inputs.includes(e.targetHandle)) issues.push({ level: 'error', nodeId: t.id, message: `${t.name}: нет входа «${e.targetHandle}»` });
    if (ts.isTrigger) issues.push({ level: 'error', nodeId: t.id, message: `К триггеру «${t.name}» нельзя подключать входящие соединения` });
    const key = `${e.source}|${e.sourceHandle}|${e.target}|${e.targetHandle}`;
    if (seenEdges.has(key)) issues.push({ level: 'warning', message: `Повторяющееся соединение ${s.name} → ${t.name}` });
    seenEdges.add(key);
    incoming.set(t.id, (incoming.get(t.id) ?? 0) + 1);
  }

  // циклы (алгоритм Кана)
  const indeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of def.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  }
  const q = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (q.length) {
    const id = q.pop()!; visited++;
    for (const nx of adj.get(id) ?? []) { indeg.set(nx, indeg.get(nx)! - 1); if (indeg.get(nx) === 0) q.push(nx); }
  }
  if (visited < byId.size) issues.push({ level: 'error', message: 'В сценарии есть цикл. Циклы запрещены — используйте узлы «Повторить N раз» или «Разделить список».' });

  const triggers = def.nodes.filter((n) => SPEC_BY_TYPE[n.type]?.isTrigger);
  if (triggers.length === 0) issues.push({ level: 'error', message: 'Добавьте хотя бы один триггер (например, «Ручной запуск»)' });

  // достижимость
  const reach = new Set<string>(triggers.map((t) => t.id));
  const stack = [...reach];
  while (stack.length) { const id = stack.pop()!; for (const nx of adj.get(id) ?? []) if (!reach.has(nx)) { reach.add(nx); stack.push(nx); } }
  for (const n of def.nodes) {
    if (!reach.has(n.id) && SPEC_BY_TYPE[n.type]) issues.push({ level: 'warning', nodeId: n.id, message: `${n.name}: узел не связан с триггером и не будет выполнен` });
  }
  const paths = new Map<string, string>();
  for (const t of triggers.filter((x) => x.type === 'trigger.webhook')) {
    const p = String(t.params.path ?? '');
    if (p && paths.has(p)) issues.push({ level: 'error', nodeId: t.id, message: `Адрес webhook «${p}» уже используется другим узлом` });
    paths.set(p, t.id);
  }
  return issues;
}

export const hasErrors = (issues: ValidationIssue[]) => issues.some((i) => i.level === 'error');
