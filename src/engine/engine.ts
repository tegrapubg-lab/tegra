import crypto from 'node:crypto';
import type { ApprovalInfo, Item, RunSummary, ValidationIssue, Workflow, WorkflowDefinition, WorkflowNode } from '../shared/types';
import { CRED_TYPE_BY_NAME, SPEC_BY_TYPE } from '../shared/specs';
import { hasErrors, validateWorkflow } from '../shared/validate';
import { backupTo, openDb, type Db } from './db';
import { nextCronRun } from './cron';
import { RunExecutor, StopReason } from './executor';
import { LlmRegistry } from './llm';
import { createRegistry, type NodeRegistry } from './nodes';
import type { CredentialData, EngineServices } from './nodes/types';
import { Redactor } from './secrets';
import { JobQueue } from './queue';
import { definitionSchema, exportSchema } from './schemas';
import { iso, Store, TERMINAL, uid, type RunRow } from './store';
import { TelegramPoller, tokenHash, type PollerStatus, type TelegramMessageEvent } from './telegramPoller';

export class EngineError extends Error {
  constructor(message: string, public status = 400, public issues?: ValidationIssue[]) { super(message); }
}

export interface EngineOptions {
  dbPath: string;
  masterKey: Buffer;
  now?: () => number;
  workerId?: string;
  registry?: NodeRegistry;
  llm?: LlmRegistry;
  /** false — не запускать фоновые циклы (для детерминированных тестов). */
  background?: boolean;
  telegramPollTimeoutSec?: number;
  maxRunDepth?: number;
}

const SCHEDULE_GRACE_MS = 90_000;
export const MAX_RUN_DEPTH = 5;
const INTERNAL_SENSITIVE_HEADERS = /^(authorization|cookie|x-api-key|x-webhook-secret|proxy-authorization)$/i;

export class Engine {
  readonly db: Db;
  readonly store: Store;
  readonly queue: JobQueue;
  readonly registry: NodeRegistry;
  readonly llm: LlmRegistry;
  readonly redactor = new Redactor();
  readonly executor: RunExecutor;
  readonly svc: EngineServices;
  readonly now: () => number;
  private active = new Map<string, AbortController>();
  private shuttingDown = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private wakeResolver: (() => void) | null = null;
  private loopPromise: Promise<void> = Promise.resolve();
  private pollers = new Map<string, TelegramPoller>();
  private failedWebhookAttempts = new Map<string, { n: number; reset: number }>();
  publicBaseUrl = '';
  localBaseUrl = '';

  constructor(private opts: EngineOptions) {
    this.now = opts.now ?? Date.now;
    this.db = openDb(opts.dbPath);
    this.store = new Store(this.db, opts.masterKey, this.now);
    this.queue = new JobQueue(this.db, opts.workerId ?? `w-${process.pid}-${crypto.randomBytes(3).toString('hex')}`, this.now);
    this.registry = opts.registry ?? createRegistry();
    this.llm = opts.llm ?? new LlmRegistry();
    this.refreshSecrets();
    this.svc = {
      now: this.now, llm: this.llm, redactor: this.redactor,
      getCredential: (id) => this.getCredential(id),
      startChildRun: (p, n, w, items) => this.startChildRun(p, n, w, items),
      runInline: (w, items, signal, depth) => this.runInline(w, items, signal, depth),
      workflowName: (id) => this.store.getWorkflow(id)?.name,
      telegramApiBase: (c) => c.data.apiBase || 'https://api.telegram.org',
    };
    this.executor = new RunExecutor({
      store: this.store, registry: this.registry, svc: this.svc, redactor: this.redactor, now: this.now,
      isShuttingDown: () => this.shuttingDown, nodeParallelism: () => this.store.getSetting('nodeParallelism', 4),
      onRunFinished: (run) => this.onRunFinished(run), cancelChildren: (id) => this.cancelChildren(id),
    });
  }

  // ---------- жизненный цикл ----------
  async start(): Promise<void> {
    this.recover();
    const days = this.store.getSetting('runRetentionDays', 30);
    this.store.pruneRuns(iso(this.now() - days * 86_400_000));
    this.publicBaseUrl = this.store.getSetting('publicBaseUrl', '');
    this.syncTriggers();
    if (this.opts.background === false) return;
    this.loopPromise = this.workerLoop();
    this.timers.push(setInterval(() => { try { this.tickTimers(); } catch (e) { console.error('tickTimers', e); } }, 1000));
    this.timers.push(setInterval(() => { try { this.tickSchedules(); } catch (e) { console.error('tickSchedules', e); } }, 5000));
    this.tickSchedules();
  }

  /** Корректная остановка: активные запуски прерываются без потери состояния и продолжатся при следующем старте. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.shuttingDown = true; this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.wake();
    for (const ac of this.active.values()) ac.abort(new StopReason('shutdown', 'Приложение остановлено'));
    await Promise.all([...this.pollers.values()].map((p) => p.stop()));
    this.pollers.clear();
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 8000))]);
    try { this.db.close(); } catch { /* уже закрыта */ }
  }

  private recover() {
    this.queue.recoverExpired(true);
    const rows = this.db.prepare(`SELECT id FROM runs WHERE status IN ('queued','running') AND id NOT IN (SELECT run_id FROM jobs)`).all() as { id: string }[];
    for (const r of rows) this.queue.enqueue(r.id);
    for (const id of this.store.runsWithPendingResume()) this.queue.enqueue(id);
  }

  private wake() { this.wakeResolver?.(); }
  private async workerLoop() {
    while (!this.stopped) {
      const max = this.store.getSetting('maxConcurrentRuns', 4);
      if (this.active.size < max) {
        const job = this.queue.claim();
        if (job) { void this.runJob(job); continue; }
      }
      await new Promise<void>((r) => { this.wakeResolver = r; setTimeout(r, 150); });
    }
    // дождаться завершения активных заданий
    while (this.active.size) await new Promise((r) => setTimeout(r, 20));
  }

  private async runJob(job: { id: number; runId: string }) {
    const ac = new AbortController();
    this.active.set(job.runId, ac);
    const hb = setInterval(() => this.queue.heartbeat(job.id), 10_000);
    try { await this.executor.process(job.runId, ac.signal); }
    catch (e) {
      console.error('Ошибка обработки запуска', job.runId, e);
      this.store.updateRun(job.runId, { status: 'failed', error: this.redactor.string(`Внутренняя ошибка: ${(e as Error).message}`), finished_at: iso(this.now()) });
      const row = this.store.getRunRow(job.runId); if (row) this.onRunFinished(row);
    } finally {
      clearInterval(hb);
      this.active.delete(job.runId);
      try { if (!this.stopped) this.queue.complete(job.id); } catch { /* БД закрыта */ }
      this.wake();
    }
  }

  /** Для тестов: обработать очередь синхронно, пока есть готовые задания. */
  async drain(maxJobs = 100): Promise<void> {
    for (let i = 0; i < maxJobs; i++) {
      const job = this.queue.claim(); if (!job) return;
      const ac = new AbortController(); this.active.set(job.runId, ac);
      try { await this.executor.process(job.runId, ac.signal); } finally { this.active.delete(job.runId); this.queue.complete(job.id); }
    }
  }

  // ---------- секреты ----------
  refreshSecrets() { this.redactor.setSecrets(this.store.allSecretValues()); }
  getCredential(id: string): CredentialData {
    if (!id) throw new Error('Подключение не выбрано');
    const c = this.store.getCredentialData(id);
    if (!c) throw new Error('Подключение не найдено (возможно, удалено)');
    return c;
  }
  saveCredential(id: string | null, name: string, type: string, data: Record<string, string>) {
    const spec = CRED_TYPE_BY_NAME[type];
    if (!spec) throw new EngineError(`Неизвестный тип подключения «${type}»`);
    let merged = { ...data };
    if (id) {
      const cur = this.store.getCredentialData(id);
      if (!cur) throw new EngineError('Подключение не найдено', 404);
      // пустое секретное поле при редактировании = «оставить прежнее»
      for (const f of spec.fields) if (f.secret && !merged[f.name] && cur.data[f.name]) merged[f.name] = cur.data[f.name];
    }
    const clean: Record<string, string> = {};
    for (const f of spec.fields) {
      const v = (merged[f.name] ?? f.default ?? '').toString().trim();
      if (f.required && !v) throw new EngineError(`Поле «${f.label}» обязательно`);
      if (v) clean[f.name] = v;
    }
    if (type === 'telegramBot' && !/^\d+:[\w-]{20,}$/.test(clean.token ?? '') && !clean.apiBase) throw new EngineError('Токен Telegram должен иметь вид 123456:ABC… (получите у @BotFather)');
    const nid = this.store.saveCredential(id, name, type, clean);
    this.refreshSecrets();
    this.syncTriggers();
    return nid;
  }
  deleteCredential(id: string) { this.store.deleteCredential(id); this.refreshSecrets(); this.syncTriggers(); }

  // ---------- проверка ----------
  validate(def: WorkflowDefinition): ValidationIssue[] {
    const issues = validateWorkflow(def);
    for (const n of def.nodes) {
      const spec = SPEC_BY_TYPE[n.type]; if (!spec) continue;
      for (const f of spec.params) {
        if (f.kind === 'credential') {
          const id = n.params[f.name];
          if (id) {
            const c = this.store.getCredentialData(String(id));
            if (!c) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: выбранное подключение не найдено` });
            else if (f.credentialType && c.type !== f.credentialType) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: подключение «${c.name}» имеет неверный тип` });
          }
        }
        if (f.kind === 'workflow' && n.params[f.name] && !this.store.getWorkflow(String(n.params[f.name]))) issues.push({ level: 'error', nodeId: n.id, message: `${n.name}: вложенный сценарий не найден` });
      }
    }
    return issues;
  }

  private assertValid(def: WorkflowDefinition) {
    const issues = this.validate(def);
    if (hasErrors(issues)) throw new EngineError('Сценарий содержит ошибки:\n' + issues.filter((i) => i.level === 'error').map((i) => '• ' + i.message).join('\n'), 422, issues);
  }

  // ---------- сценарии ----------
  createWorkflow(name: string, def?: WorkflowDefinition): Workflow {
    const d = def ?? { nodes: [{ id: uid(), type: 'trigger.manual', name: 'Ручной запуск', position: { x: 80, y: 120 }, params: {} }], edges: [] };
    return this.store.createWorkflow(name, d);
  }

  updateWorkflow(id: string, patch: { name?: string; definition?: WorkflowDefinition }): Workflow {
    const cur = this.store.getWorkflow(id);
    if (!cur) throw new EngineError('Сценарий не найден', 404);
    if (patch.definition) definitionSchema.parse(patch.definition);
    if (cur.active && patch.definition) {
      // активный сценарий нельзя сохранить в невалидном виде: иначе триггеры перестанут работать молча
      this.assertValid(patch.definition);
      this.assertTelegramFree(patch.definition, id);
    }
    const w = this.store.updateWorkflow(id, patch)!;
    if (cur.active) { this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=?').run(id); this.syncTriggers(); }
    return w;
  }

  deleteWorkflow(id: string) {
    const refs = this.store.listWorkflows().filter((w) => w.id !== id).flatMap((w) => {
      const full = this.store.getWorkflow(w.id)!;
      return full.nodes.some((n) => n.type === 'core.subworkflow' && n.params.workflowId === id) ? [w.name] : [];
    });
    if (refs.length) throw new EngineError(`Сценарий используется как вложенный в: ${refs.join(', ')}`, 409);
    this.store.deleteWorkflow(id);
    this.syncTriggers();
  }

  duplicateWorkflow(id: string): Workflow {
    const w = this.store.getWorkflow(id); if (!w) throw new EngineError('Сценарий не найден', 404);
    return this.store.createWorkflow(`${w.name} (копия)`, this.freshenWebhookPaths({ nodes: structuredClone(w.nodes), edges: structuredClone(w.edges), settings: w.settings }));
  }

  private freshenWebhookPaths(def: WorkflowDefinition): WorkflowDefinition {
    for (const n of def.nodes) if (n.type === 'trigger.webhook') n.params.path = crypto.randomBytes(12).toString('hex');
    return def;
  }

  setActive(id: string, active: boolean): Workflow {
    const w = this.store.getWorkflow(id); if (!w) throw new EngineError('Сценарий не найден', 404);
    if (active) {
      this.assertValid(w);
      if (!w.nodes.some((n) => SPEC_BY_TYPE[n.type]?.isTrigger && n.type !== 'trigger.manual')) throw new EngineError('Для включения нужен автоматический триггер: Расписание, Webhook или Telegram. Ручной запуск работает и без включения.', 422);
      this.assertTelegramFree(w, id);
    }
    this.store.setActive(id, active);
    if (!active) this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=?').run(id);
    this.syncTriggers();
    return this.store.getWorkflow(id)!;
  }

  exportWorkflow(id: string) {
    const w = this.store.getWorkflow(id); if (!w) throw new EngineError('Сценарий не найден', 404);
    const def = structuredClone({ nodes: w.nodes, edges: w.edges, settings: w.settings }) as WorkflowDefinition;
    for (const n of def.nodes) {
      const spec = SPEC_BY_TYPE[n.type];
      for (const f of spec?.params ?? []) {
        if (f.kind === 'credential') delete n.params[f.name]; // ссылки на локальные подключения не переносятся
        if (f.kind === 'list' && Array.isArray(n.params[f.name])) {
          for (const row of n.params[f.name] as Record<string, unknown>[]) if (typeof row.key === 'string' && INTERNAL_SENSITIVE_HEADERS.test(row.key)) row.value = '';
        }
      }
    }
    return { format: 'tegra-flow' as const, version: 1, name: w.name, exportedAt: iso(this.now()), definition: this.redactor.value(def) };
  }

  importWorkflow(data: unknown): Workflow {
    const parsed = exportSchema.safeParse(data);
    if (!parsed.success) throw new EngineError('Файл не похож на сценарий Tegra Flow: ' + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
    const { name, definition } = parsed.data;
    return this.store.createWorkflow(name, this.freshenWebhookPaths(definition as WorkflowDefinition));
  }

  // ---------- запуск ----------
  startRun(workflowId: string, opts: { triggerNodeId?: string; input?: unknown; trigger?: string; skipValidation?: boolean } = {}): string {
    const w = this.store.getWorkflow(workflowId); if (!w) throw new EngineError('Сценарий не найден', 404);
    if (!opts.skipValidation) this.assertValid(w);
    const trig = opts.triggerNodeId ? w.nodes.find((n) => n.id === opts.triggerNodeId) : (w.nodes.find((n) => n.type === 'trigger.manual') ?? w.nodes.find((n) => SPEC_BY_TYPE[n.type]?.isTrigger));
    if (!trig || !SPEC_BY_TYPE[trig.type]?.isTrigger) throw new EngineError('В сценарии нет подходящего триггера', 422);
    let items: Item[] = [];
    if (opts.input !== undefined && opts.input !== null) {
      if (Array.isArray(opts.input)) items = opts.input.map((x) => ({ json: x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : { value: x } }));
      else if (typeof opts.input === 'object') items = [{ json: opts.input as Record<string, unknown> }];
      else items = [{ json: { value: opts.input } }];
    }
    if (items.length > 1000) throw new EngineError('Слишком много входных элементов (максимум 1000)');
    const runId = this.store.createRun({ workflow: w, trigger: opts.trigger ?? 'manual', triggerNodeId: trig.id, triggerData: this.redactor.value(items) });
    this.queue.enqueue(runId);
    this.wake();
    return runId;
  }

  private startChildRun(parentRunId: string, parentNodeId: string, workflowId: string, items: Item[]): string {
    const existing = this.store.findChildRun(parentRunId, parentNodeId);
    if (existing) return existing.id;
    const parent = this.store.getRunRow(parentRunId)!;
    if (parent.depth + 1 > (this.opts.maxRunDepth ?? MAX_RUN_DEPTH)) throw new Error(`Слишком глубокая вложенность сценариев (максимум ${MAX_RUN_DEPTH})`);
    const w = this.store.getWorkflow(workflowId); if (!w) throw new Error('Вложенный сценарий не найден');
    this.assertValid(w);
    const trig = w.nodes.find((n) => n.type === 'trigger.manual') ?? w.nodes.find((n) => SPEC_BY_TYPE[n.type]?.isTrigger);
    if (!trig) throw new Error('Во вложенном сценарии нет триггера');
    const id = this.store.createRun({ workflow: w, trigger: 'subworkflow', triggerNodeId: trig.id, triggerData: items, parent: { runId: parentRunId, nodeId: parentNodeId }, depth: parent.depth + 1 });
    this.queue.enqueue(id);
    this.wake();
    return id;
  }

  private async runInline(workflowId: string, items: Item[], signal: AbortSignal, depth: number) {
    if (depth > MAX_RUN_DEPTH) throw new Error('Слишком глубокая вложенность сценариев');
    const w = this.store.getWorkflow(workflowId); if (!w) throw new Error('Сценарий не найден');
    this.assertValid(w);
    const trig = w.nodes.find((n) => n.type === 'trigger.manual') ?? w.nodes.find((n) => SPEC_BY_TYPE[n.type]?.isTrigger)!;
    const id = this.store.createRun({ workflow: w, trigger: 'agent-tool', triggerNodeId: trig.id, triggerData: items, depth });
    await this.executor.process(id, signal);
    let row = this.store.getRunRow(id)!;
    if (row.status === 'waiting') { this.cancelRun(id); row = this.store.getRunRow(id)!; return { status: 'waiting', items: [], error: 'Сценарий ожидает (пауза/подтверждение) — в инструменте агента это не поддерживается' }; }
    return { status: row.status, items: this.resultItems(id), error: row.error ?? undefined };
  }

  /** Детали запуска для показа пользователю: секреты замаскированы (в т.ч. вписанные вручную в параметры). */
  runDetail(id: string) {
    const d = this.store.getRunDetail(id);
    return d ? this.redactor.value(d) : undefined;
  }

  resultItems(runId: string): Item[] {
    const run = this.store.getRunRow(runId)!; const def = JSON.parse(run.snapshot) as WorkflowDefinition;
    const states = new Map(this.store.getRunNodes(runId).map((s) => [s.nodeId, s]));
    const explicit = def.nodes.filter((n) => n.type === 'core.result');
    const pick = explicit.length ? explicit : def.nodes.filter((n) => !def.edges.some((e) => e.source === n.id) && !SPEC_BY_TYPE[n.type]?.isTrigger);
    const out: Item[] = [];
    for (const n of pick) { const s = states.get(n.id); if (s?.status === 'succeeded' && s.outputs) for (const items of Object.values(s.outputs)) out.push(...items); }
    return out;
  }

  private onRunFinished(run: RunRow) {
    if (!run.parent_run_id || !run.parent_node_id) return;
    const payload = { status: run.status, items: run.status === 'succeeded' ? this.resultItems(run.id) : [], error: run.error };
    if (this.store.setResumePayload(run.parent_run_id, run.parent_node_id, payload)) { this.queue.enqueue(run.parent_run_id); this.wake(); }
  }

  cancelRun(id: string): RunSummary {
    const run = this.store.getRunRow(id); if (!run) throw new EngineError('Запуск не найден', 404);
    if (TERMINAL.includes(run.status)) return this.store.listRuns({ limit: 1 }).find((r) => r.id === id) ?? ({} as RunSummary);
    this.store.updateRun(id, { cancel_requested: 1 });
    const ac = this.active.get(id);
    if (ac) ac.abort(new StopReason('cancel', 'Запуск отменён'));
    else {
      // запуск не исполняется сейчас (ожидает/в очереди) — завершаем сразу
      this.queue.deleteForRun(id);
      for (const st of this.store.getRunNodes(id)) if (['pending', 'waiting', 'running'].includes(st.status)) { st.status = 'cancelled'; st.finishedAt = iso(this.now()); st.summary = 'Отменено'; st.wait = null; this.store.saveNode(id, st); }
      this.store.updateRun(id, { status: 'cancelled', error: 'Отменено пользователем', finished_at: iso(this.now()) });
      this.cancelChildren(id);
      this.onRunFinished(this.store.getRunRow(id)!);
    }
    return this.store.listRuns({ limit: 500 }).find((r) => r.id === id)!;
  }

  private cancelChildren(parentId: string) {
    const kids = this.db.prepare(`SELECT id FROM runs WHERE parent_run_id=? AND status NOT IN ('succeeded','failed','cancelled')`).all(parentId) as { id: string }[];
    for (const k of kids) this.cancelRun(k.id);
  }

  // ---------- ожидание решения ----------
  listApprovals(): ApprovalInfo[] {
    return this.store.waitingApprovals().map(({ run, node }) => {
      const def = JSON.parse(run.snapshot) as WorkflowDefinition;
      return {
        runId: run.id, workflowId: run.workflow_id, workflowName: run.workflow_name, nodeId: node.nodeId,
        nodeName: def.nodes.find((n) => n.id === node.nodeId)?.name ?? node.nodeId, message: node.wait?.message ?? '',
        since: node.startedAt ?? '', timeoutAt: node.resumeAt ? iso(node.resumeAt) : null, itemsPreview: (node.input ?? []).slice(0, 5),
      };
    });
  }

  decideApproval(runId: string, nodeId: string, decision: 'approved' | 'rejected', comment = ''): void {
    const ok = this.store.setResumePayload(runId, nodeId, { decision, comment: comment.slice(0, 2000) });
    if (!ok) throw new EngineError('Решение уже принято или запрос не найден', 409);
    this.queue.enqueue(runId); this.wake();
  }

  // ---------- таймеры ожидания ----------
  tickTimers(): number {
    let n = 0;
    for (const t of this.store.dueTimers(this.now())) {
      const payload = t.wait.kind === 'approval' ? (t.wait.timeoutPayload ?? { decision: 'rejected', timedOut: true }) : {};
      if (this.store.setResumePayload(t.runId, t.nodeId, payload)) { this.queue.enqueue(t.runId); n++; }
    }
    if (n) this.wake();
    return n;
  }

  // ---------- триггеры ----------
  private activeWorkflows(): Workflow[] {
    return (this.db.prepare('SELECT id FROM workflows WHERE active=1').all() as { id: string }[]).map((r) => this.store.getWorkflow(r.id)!);
  }

  private tgTriggers(w: Workflow) {
    return w.nodes.filter((n) => n.type === 'trigger.telegram').flatMap((n) => {
      const c = n.params.credential ? this.store.getCredentialData(String(n.params.credential)) : undefined;
      return c?.data.token ? [{ node: n, cred: c, hash: tokenHash(c.data.token) }] : [];
    });
  }

  private assertTelegramFree(def: WorkflowDefinition, selfId: string) {
    const mine = this.tgTriggers({ ...(def as Workflow), id: selfId });
    const seen = new Set<string>();
    for (const t of mine) { if (seen.has(t.hash)) throw new EngineError('В сценарии два Telegram-триггера используют одного и того же бота. Один бот — один получатель.', 422); seen.add(t.hash); }
    for (const other of this.activeWorkflows()) {
      if (other.id === selfId) continue;
      for (const t of this.tgTriggers(other)) if (seen.has(t.hash)) throw new EngineError(`Этот бот Telegram уже принимает сообщения в сценарии «${other.name}». Для одного токена допускается один получатель — отключите тот сценарий.`, 409);
    }
  }

  syncTriggers() {
    const wfs = this.activeWorkflows();
    // расписания
    const keep = new Set<string>();
    for (const w of wfs) for (const n of w.nodes) if (n.type === 'trigger.schedule') {
      keep.add(`${w.id}|${n.id}`);
      const cur = this.db.prepare('SELECT 1 FROM schedule_state WHERE workflow_id=? AND node_id=?').get(w.id, n.id);
      if (!cur) { try { this.db.prepare('INSERT INTO schedule_state(workflow_id,node_id,next_run_at) VALUES (?,?,?)').run(w.id, n.id, this.computeNext(n, this.now())); } catch { /* невалидное расписание отражено в validate */ } }
    }
    for (const r of this.db.prepare('SELECT workflow_id,node_id FROM schedule_state').all() as { workflow_id: string; node_id: string }[]) {
      if (!keep.has(`${r.workflow_id}|${r.node_id}`)) this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=? AND node_id=?').run(r.workflow_id, r.node_id);
    }
    // Telegram
    if (this.opts.background === false && this.opts.telegramPollTimeoutSec === undefined) return;
    const want = new Map<string, CredentialData>();
    for (const w of wfs) for (const t of this.tgTriggers(w)) if (!want.has(t.hash)) want.set(t.hash, t.cred);
    for (const [h, p] of this.pollers) if (!want.has(h)) { void p.stop(); this.pollers.delete(h); }
    for (const [h, cred] of want) {
      if (this.pollers.has(h)) continue;
      const p = new TelegramPoller(cred, () => (this.db.prepare('SELECT next_offset FROM telegram_offsets WHERE token_hash=?').get(h) as any)?.next_offset ?? 0,
        (n) => this.db.prepare('INSERT INTO telegram_offsets(token_hash,next_offset) VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET next_offset=excluded.next_offset').run(h, n),
        (e) => this.dispatchTelegram(e), this.opts.telegramPollTimeoutSec ?? 25, this.now);
      this.pollers.set(h, p); p.start();
    }
  }

  pollerStatuses(): PollerStatus[] { return [...this.pollers.values()].map((p) => p.status); }

  private dispatchTelegram(e: TelegramMessageEvent) {
    for (const w of this.activeWorkflows()) for (const t of this.tgTriggers(w)) {
      if (t.hash !== e.tokenHash) continue;
      const allowed = String(t.node.params.allowedChatIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (allowed.length && !allowed.includes(String(e.json.chatId))) continue;
      try {
        const id = this.store.createRun({ workflow: w, trigger: 'telegram', triggerNodeId: t.node.id, triggerData: this.redactor.value([{ json: e.json }]) });
        this.queue.enqueue(id); this.wake();
      } catch (err) { console.error('telegram dispatch', err); }
    }
  }

  private computeNext(n: WorkflowNode, after: number): number {
    const p = n.params;
    if (p.mode === 'cron') return nextCronRun(String(p.cron ?? ''), String(p.timezone || 'UTC'), after);
    return after + Math.max(1, Number(p.everyMinutes ?? 60)) * 60_000;
  }

  /** Вызывается раз в несколько секунд и после «пробуждения» компьютера. */
  tickSchedules(): { fired: number; skipped: number } {
    const now = this.now(); let fired = 0; let skipped = 0;
    const due = this.db.prepare('SELECT workflow_id,node_id,next_run_at FROM schedule_state WHERE next_run_at <= ?').all(now) as { workflow_id: string; node_id: string; next_run_at: number }[];
    for (const d of due) {
      const w = this.store.getWorkflow(d.workflow_id); const n = w?.nodes.find((x) => x.id === d.node_id);
      if (!w || !w.active || !n) { this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=? AND node_id=?').run(d.workflow_id, d.node_id); continue; }
      const late = now - d.next_run_at; const missed = late > SCHEDULE_GRACE_MS;
      const policy = n.params.missedPolicy === 'runOnce' ? 'runOnce' : 'skip';
      let next: number;
      try {
        if (n.params.mode === 'cron') next = nextCronRun(String(n.params.cron), String(n.params.timezone || 'UTC'), now);
        else { const step = Math.max(1, Number(n.params.everyMinutes ?? 60)) * 60_000; next = d.next_run_at + (Math.floor(late / step) + 1) * step; }
      } catch (e) { console.error('schedule', e); this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=? AND node_id=?').run(d.workflow_id, d.node_id); continue; }
      this.db.prepare('UPDATE schedule_state SET next_run_at=? WHERE workflow_id=? AND node_id=?').run(next, d.workflow_id, d.node_id);
      if (missed && policy === 'skip') { skipped++; continue; }
      try {
        const id = this.store.createRun({ workflow: w, trigger: missed ? 'schedule (пропущенный запуск)' : 'schedule', triggerNodeId: n.id, triggerData: [{ json: { scheduledFor: iso(d.next_run_at), firedAt: iso(now), missed, lateBySeconds: Math.round(late / 1000), timezone: n.params.timezone ?? 'UTC' } }] });
        this.db.prepare('UPDATE schedule_state SET last_run_at=? WHERE workflow_id=? AND node_id=?').run(now, d.workflow_id, d.node_id);
        this.queue.enqueue(id); fired++;
      } catch (e) { console.error('schedule run', e); }
    }
    if (fired) this.wake();
    return { fired, skipped };
  }

  // ---------- webhook ----------
  handleWebhook(path: string, method: string, headers: Record<string, string | string[] | undefined>, query: Record<string, string>, body: unknown, ip: string): { status: number; body: unknown } {
    const bucket = this.failedWebhookAttempts.get(ip); const now = this.now();
    if (bucket && bucket.reset > now && bucket.n >= 20) return { status: 429, body: { error: 'Слишком много неверных попыток' } };
    for (const w of this.activeWorkflows()) for (const n of w.nodes) {
      if (n.type !== 'trigger.webhook' || n.params.path !== path) continue;
      const wm = String(n.params.method ?? 'POST');
      if (wm !== 'ANY' && wm !== method) return { status: 405, body: { error: `Ожидается метод ${wm}` } };
      const cred = n.params.secret ? this.store.getCredentialData(String(n.params.secret)) : undefined;
      const given = String(headers['x-webhook-secret'] ?? '');
      const expected = cred?.data.secret ?? '';
      const a = crypto.createHash('sha256').update(given).digest(); const b = crypto.createHash('sha256').update(expected).digest();
      if (!expected || !crypto.timingSafeEqual(a, b)) {
        const bk = this.failedWebhookAttempts.get(ip);
        if (!bk || bk.reset <= now) this.failedWebhookAttempts.set(ip, { n: 1, reset: now + 60_000 }); else bk.n++;
        return { status: 401, body: { error: 'Неверный секрет' } };
      }
      const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => !INTERNAL_SENSITIVE_HEADERS.test(k)));
      const id = this.store.createRun({ workflow: w, trigger: 'webhook', triggerNodeId: n.id, triggerData: this.redactor.value([{ json: { method, query, headers: safeHeaders, body } }]) });
      this.queue.enqueue(id); this.wake();
      return { status: 202, body: { accepted: true, runId: id } };
    }
    const bk = this.failedWebhookAttempts.get(ip);
    if (!bk || bk.reset <= now) this.failedWebhookAttempts.set(ip, { n: 1, reset: now + 60_000 }); else bk.n++;
    return { status: 404, body: { error: 'Webhook не найден или сценарий выключен' } };
  }

  webhookUrls(w: Workflow) {
    return w.nodes.filter((n) => n.type === 'trigger.webhook').map((n) => ({
      nodeId: n.id, local: `${this.localBaseUrl}/hook/${String(n.params.path)}`,
      public: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/+$/, '')}/hook/${String(n.params.path)}` : null,
    }));
  }

  // ---------- сервисное ----------
  status() {
    const wfs = this.store.listWorkflows();
    return {
      version: '0.1.0', workerId: this.queue.workerId, activeWorkflows: wfs.filter((w) => w.active).length, workflows: wfs.length,
      runsActive: this.active.size, queue: this.queue.counts(), schedules: (this.db.prepare('SELECT COUNT(*) c FROM schedule_state').get() as any).c,
      pollers: this.pollerStatuses(), localBaseUrl: this.localBaseUrl, publicBaseUrl: this.publicBaseUrl,
      waitingRuns: (this.db.prepare(`SELECT COUNT(*) c FROM runs WHERE status='waiting'`).get() as any).c,
    };
  }

  settings() {
    return {
      maxConcurrentRuns: this.store.getSetting('maxConcurrentRuns', 4), nodeParallelism: this.store.getSetting('nodeParallelism', 4),
      publicBaseUrl: this.store.getSetting('publicBaseUrl', ''), runRetentionDays: this.store.getSetting('runRetentionDays', 30),
    };
  }
  setSettings(p: Record<string, unknown>) {
    if (typeof p.publicBaseUrl === 'string' && p.publicBaseUrl) {
      try { const u = new URL(p.publicBaseUrl); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0; } catch { throw new EngineError('Публичный адрес должен быть URL вида https://example.com'); }
    }
    for (const [k, v] of Object.entries(p)) this.store.setSetting(k, v);
    this.publicBaseUrl = this.store.getSetting('publicBaseUrl', '');
    this.wake();
  }

  backupTo(target: string) { backupTo(this.db, target); }
}
