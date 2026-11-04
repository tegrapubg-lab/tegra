// Исполнитель графа. Всё состояние живёт в БД (run_nodes), поэтому выполнение можно
// прервать (перезапуск, сон, отмена) и продолжить с любого места.
import type { Item, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../shared/types';
import { SPEC_BY_TYPE } from '../shared/specs';
import { evalExpression, resolveDeep, type ExprContext } from './expr';
import type { NodeRegistry } from './nodes';
import type { EngineServices, NodeExecContext, NodeImpl } from './nodes/types';
import { abortableSleep } from './nodes/util';
import type { Redactor } from './secrets';
import { iso, TERMINAL, type NodeRow, type RunRow, type Store } from './store';

const MAX_ITEMS_PER_NODE = 10_000;
const MAX_NODE_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 300_000;
const MAX_LOG_LINES = 200;

export interface ExecutorDeps {
  store: Store; registry: NodeRegistry; svc: EngineServices; redactor: Redactor; now: () => number;
  isShuttingDown(): boolean;
  nodeParallelism(): number;
  onRunFinished(run: RunRow): void;
  cancelChildren(runId: string): void;
}

export class StopReason extends Error {
  constructor(public kind: 'cancel' | 'shutdown' | 'run-failed' | 'timeout', message: string) { super(message); this.name = 'StopReason'; }
}

export class RunExecutor {
  constructor(private d: ExecutorDeps) {}

  async process(runId: string, outerSignal: AbortSignal): Promise<void> {
    const { store } = this.d;
    const run = store.getRunRow(runId);
    if (!run || TERMINAL.includes(run.status)) return;
    const def = JSON.parse(run.snapshot) as WorkflowDefinition;
    const triggerData = JSON.parse(run.trigger_data) as Item[];
    const nodeById = new Map(def.nodes.map((n) => [n.id, n]));
    const nodeByName = new Map(def.nodes.map((n) => [n.name, n]));
    const incoming = new Map<string, WorkflowEdge[]>();
    for (const e of def.edges) (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);

    store.ensureRunNodes(runId, def.nodes.map((n) => n.id));
    store.resetRunningNodes(runId);
    store.updateRun(runId, { status: 'running', started_at: run.started_at ?? iso(this.d.now()) });
    const states = new Map(store.getRunNodes(runId).map((s) => [s.nodeId, s]));

    const runCtl = new AbortController();
    const onOuter = () => runCtl.abort(outerSignal.reason instanceof StopReason ? outerSignal.reason : new StopReason('cancel', 'Запуск отменён'));
    if (outerSignal.aborted) onOuter(); else outerSignal.addEventListener('abort', onOuter, { once: true });

    const save = (st: NodeRow) => store.saveNode(runId, st);
    const pushLog = (st: NodeRow, msg: string) => {
      st.log.push(`${new Date(this.d.now()).toISOString().slice(11, 19)} ${this.d.redactor.string(msg)}`);
      if (st.log.length > MAX_LOG_LINES) st.log.splice(0, st.log.length - MAX_LOG_LINES);
    };

    const edgeLive = (e: WorkflowEdge) => {
      const s = states.get(e.source);
      return !!s && s.status === 'succeeded' && (s.outputs?.[e.sourceHandle]?.length ?? 0) > 0;
    };
    const classify = (id: string): 'wait' | 'skip' | 'ready' => {
      const inc = incoming.get(id) ?? [];
      if (inc.length === 0) return id === run.trigger_node_id ? 'ready' : 'skip';
      for (const e of inc) { const s = states.get(e.source)?.status; if (s === 'pending' || s === 'running' || s === 'waiting') return 'wait'; }
      return inc.some(edgeLive) ? 'ready' : 'skip';
    };
    const collectInputs = (id: string): Record<string, Item[]> => {
      const out: Record<string, Item[]> = {};
      for (const e of incoming.get(id) ?? []) if (edgeLive(e)) (out[e.targetHandle] ??= []).push(...(states.get(e.source)!.outputs![e.sourceHandle]));
      return out;
    };

    const makeCtx = (node: WorkflowNode, impl: NodeImpl, st: NodeRow, inputs: Record<string, Item[]>, signal: AbortSignal): NodeExecContext => {
      const items = inputs.main ?? (impl.spec.inputs.length > 1 ? [] : Object.values(inputs).flat());
      const exprCtx = (index: number): ExprContext => ({
        json: items[index]?.json ?? {}, index, runId, now: new Date(this.d.now()),
        node: (name) => {
          const n = nodeByName.get(name); const s = n && states.get(n.id);
          if (!s || s.status !== 'succeeded' || !s.outputs) return undefined;
          const port = s.outputs.main?.length ? 'main' : Object.keys(s.outputs).find((k) => s.outputs![k].length) ?? 'main';
          const its = s.outputs[port] ?? [];
          return { json: its[0]?.json ?? {}, items: its };
        },
      });
      const raw = (name: string) => node.params[name] ?? impl.spec.params.find((p) => p.name === name)?.default;
      const param = (name: string, index = 0) => {
        try { return resolveDeep(raw(name), exprCtx(index)); }
        catch (e) { throw new Error(`Ошибка в выражении поля «${impl.spec.params.find((p) => p.name === name)?.label ?? name}»: ${(e as Error).message}`); }
      };
      return {
        node, spec: impl.spec, runId, runDepth: run.depth, inputs, items, triggerData, attempt: st.attempt, signal, svc: this.d.svc,
        param, raw,
        str: (n, i = 0) => { const v = param(n, i); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); },
        num: (n, i = 0, fb = 0) => { const v = param(n, i); if (v === undefined || v === null || v === '') return fb; const x = Number(v); if (!Number.isFinite(x)) throw new Error(`Поле «${n}» должно быть числом`); return x; },
        bool: (n) => { const v = raw(n); return v === true || v === 'true'; },
        exprCtx, log: (m) => pushLog(st, m),
      };
    };

    const failNode = (st: NodeRow, node: WorkflowNode, impl: NodeImpl, message: string): 'failed' | 'continued' => {
      const msg = this.d.redactor.string(message);
      st.finishedAt = iso(this.d.now());
      st.error = msg; st.wait = null; st.resumeAt = null;
      if (node.settings?.onError === 'continue') {
        const port = impl.spec.outputs[0]?.id ?? 'main';
        st.status = 'succeeded'; st.outputs = { [port]: [{ json: { error: { message: msg, node: node.name, attempts: st.attempt } } }] };
        st.summary = `Ошибка (продолжение): ${msg.slice(0, 120)}`; save(st); return 'continued';
      }
      st.status = 'failed'; st.summary = msg.slice(0, 200); save(st); return 'failed';
    };

    const finishOk = (st: NodeRow, outputs: Record<string, Item[]>, summary?: string) => {
      let total = 0; let bytes = 0;
      for (const v of Object.values(outputs)) { total += v.length; }
      if (total > MAX_ITEMS_PER_NODE) throw new Error(`Узел вернул слишком много элементов (${total} > ${MAX_ITEMS_PER_NODE})`);
      const safe = this.d.redactor.value(outputs);
      bytes = Buffer.byteLength(JSON.stringify(safe));
      if (bytes > MAX_NODE_OUTPUT_BYTES) throw new Error(`Результат узла слишком большой (${Math.round(bytes / 1024)} КБ > ${MAX_NODE_OUTPUT_BYTES / 1024} КБ)`);
      st.outputs = safe; st.status = 'succeeded'; st.error = null; st.wait = null; st.resumeAt = null; st.resumePayload = null;
      st.summary = summary ? this.d.redactor.string(summary) : null; st.finishedAt = iso(this.d.now()); save(st);
    };

    let failure = null as string | null;
    const stopKind = () => (runCtl.signal.reason instanceof StopReason ? runCtl.signal.reason.kind : null);

    const executeNode = async (id: string, resume: Record<string, unknown> | null): Promise<void> => {
      const node = nodeById.get(id)!; const st = states.get(id)!;
      const impl = this.d.registry.get(node.type);
      if (!impl) { failure ??= `Неизвестный тип узла ${node.type}`; failNode(st, node, { spec: SPEC_BY_TYPE[node.type] } as NodeImpl, `Неизвестный тип узла ${node.type}`); return; }
      const inputs = resume ? { main: st.input ?? [] } : collectInputs(id);
      if (!resume) { st.input = this.d.redactor.value(Object.values(inputs).flat()); st.startedAt = iso(this.d.now()); st.outputs = null; st.error = null; }
      st.status = 'running'; save(st);

      const maxAttempts = Math.min(Math.max(node.settings?.maxAttempts ?? 1, 1), 10);
      const baseDelay = Math.min(Math.max(node.settings?.retryDelayMs ?? 1000, 0), MAX_RETRY_DELAY_MS);
      const defaultTimeout = node.type === 'ai.agent' ? 300_000 : 60_000;
      const timeoutMs = node.settings?.timeoutMs ?? defaultTimeout;
      let lastErr = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (!resume) st.attempt = attempt;
        save(st);
        const ac = new AbortController();
        const link = () => ac.abort(runCtl.signal.reason);
        runCtl.signal.addEventListener('abort', link, { once: true });
        const timer = setTimeout(() => ac.abort(new StopReason('timeout', `Тайм-аут узла (${Math.round(timeoutMs / 1000)} с)`)), timeoutMs);
        try {
          if (runCtl.signal.aborted) throw runCtl.signal.reason;
          const ctx = makeCtx(node, impl, st, inputs, ac.signal);
          const aborted = new Promise<never>((_, rej) => { const f = () => rej(ac.signal.reason); if (ac.signal.aborted) f(); else ac.signal.addEventListener('abort', f, { once: true }); });
          if (resume) {
            if (!impl.resume) throw new Error('Узел не поддерживает возобновление');
            const r = await Promise.race([impl.resume(ctx, st.wait ?? { kind: 'timer' }, resume), aborted]);
            finishOk(st, r.outputs, r.summary);
            return;
          }
          const r = await Promise.race([impl.execute(ctx), aborted]);
          if ('skip' in r) { st.status = 'skipped'; st.summary = r.skip; st.finishedAt = iso(this.d.now()); save(st); return; }
          if ('wait' in r) {
            st.status = 'waiting'; st.wait = r.wait; st.summary = r.summary ?? null;
            st.resumeAt = r.wait.resumeAt ? Date.parse(r.wait.resumeAt) : null; st.resumePayload = null; save(st);
            return;
          }
          finishOk(st, r.outputs, r.summary);
          return;
        } catch (e) {
          const err = e as Error;
          if (err instanceof StopReason && (err.kind === 'cancel' || err.kind === 'shutdown' || err.kind === 'run-failed')) {
            if (err.kind === 'shutdown') return; // оставляем running: восстановится при следующем запуске
            st.status = 'cancelled'; st.finishedAt = iso(this.d.now()); st.summary = err.kind === 'cancel' ? 'Отменено' : 'Остановлено из-за ошибки в другой ветке'; save(st);
            return;
          }
          lastErr = err instanceof StopReason ? err.message : (err.name === 'AbortError' ? 'Запрос прерван' : err.message);
          pushLog(st, `Попытка ${attempt}/${maxAttempts} не удалась: ${lastErr}`);
          save(st);
          if (resume || attempt >= maxAttempts) break;
          const delay = Math.min(baseDelay * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
          pushLog(st, `Повтор через ${delay} мс`); save(st);
          try { await abortableSleep(delay, runCtl.signal); } catch { st.status = 'cancelled'; st.finishedAt = iso(this.d.now()); save(st); return; }
        } finally {
          clearTimeout(timer);
          runCtl.signal.removeEventListener('abort', link);
        }
      }
      const r = failNode(st, node, impl, lastErr || 'Неизвестная ошибка');
      if (r === 'failed') {
        failure ??= `Узел «${node.name}»: ${st.error}`;
        runCtl.abort(new StopReason('run-failed', failure));
      }
    };

    // ----- главный цикл -----
    const inflight = new Map<string, Promise<void>>();
    const launch = (id: string, resume: Record<string, unknown> | null) => {
      const p = executeNode(id, resume).catch((e) => {
        const st = states.get(id)!; const node = nodeById.get(id)!;
        failNode(st, node, this.d.registry.get(node.type) ?? ({ spec: SPEC_BY_TYPE[node.type] } as NodeImpl), `Внутренняя ошибка: ${(e as Error).message}`);
        failure ??= `Узел «${node.name}»: ${(e as Error).message}`;
        runCtl.abort(new StopReason('run-failed', failure));
      }).finally(() => { inflight.delete(id); });
      inflight.set(id, p);
    };

    // возобновление ожидающих узлов
    for (const st of states.values()) {
      if (st.status === 'waiting' && st.resumePayload) { const payload = st.resumePayload; st.resumePayload = null; st.status = 'running'; launch(st.nodeId, payload); }
    }

    const parallelism = Math.max(1, def.settings?.nodeParallelism ?? this.d.nodeParallelism());
    for (;;) {
      if (store.getRunRow(runId)?.cancel_requested && !runCtl.signal.aborted) runCtl.abort(new StopReason('cancel', 'Запуск отменён пользователем'));
      let changed: boolean; const ready: string[] = [];
      do {
        changed = false; ready.length = 0;
        for (const n of def.nodes) {
          const st = states.get(n.id)!;
          if (st.status !== 'pending' || runCtl.signal.aborted) continue; // после ошибки/отмены ничего не пропагируем
          const c = classify(n.id);
          if (c === 'skip') { st.status = 'skipped'; st.finishedAt = iso(this.d.now()); st.summary = 'Пропущен: нет данных на входе'; save(st); changed = true; }
          else if (c === 'ready') ready.push(n.id);
        }
      } while (changed);
      if (!runCtl.signal.aborted) {
        for (const id of ready) { if (inflight.size >= parallelism) break; if (!inflight.has(id)) { states.get(id)!.status = 'running'; launch(id, null); } }
      }
      if (inflight.size === 0) break;
      await Promise.race(inflight.values());
    }
    outerSignal.removeEventListener('abort', onOuter);

    // ----- итог -----
    if (this.d.isShuttingDown() && stopKind() === 'shutdown') return; // состояние сохранено, задание восстановится
    const cancelled = stopKind() === 'cancel';
    const anyWaiting = [...states.values()].some((s) => s.status === 'waiting');
    if (cancelled || failure) {
      for (const st of states.values()) {
        if (st.status === 'pending' || st.status === 'waiting' || st.status === 'running') {
          st.status = 'cancelled'; st.finishedAt = iso(this.d.now()); st.summary = cancelled ? 'Отменено' : 'Не выполнен из-за ошибки в сценарии'; st.wait = null; save(st);
        }
      }
      this.d.cancelChildren(runId);
      store.updateRun(runId, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Отменено пользователем' : this.d.redactor.string(failure!), finished_at: iso(this.d.now()) });
    } else if (anyWaiting) {
      store.updateRun(runId, { status: 'waiting' });
      return;
    } else {
      store.updateRun(runId, { status: 'succeeded', finished_at: iso(this.d.now()) });
    }
    this.d.onRunFinished(store.getRunRow(runId)!);
  }
}

export { evalExpression };
