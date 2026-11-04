import crypto from 'node:crypto';
import type { CredentialInfo, Item, NodeStatus, RunDetail, RunNodeState, RunStatus, RunSummary, WaitInfo, Workflow, WorkflowDefinition } from '../shared/types';
import { CRED_TYPE_BY_NAME } from '../shared/specs';
import type { Db } from './db';
import { decryptString, encryptString } from './secrets';

export const uid = () => crypto.randomUUID();
export const iso = (ms?: number) => new Date(ms ?? Date.now()).toISOString();
export const TERMINAL: RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface RunRow {
  id: string; workflow_id: string; workflow_name: string; status: RunStatus; trigger: string; trigger_node_id: string | null;
  parent_run_id: string | null; parent_node_id: string | null; depth: number; snapshot: string; trigger_data: string;
  error: string | null; cancel_requested: number; created_at: string; started_at: string | null; finished_at: string | null;
}

export interface NodeRow extends RunNodeState { resumeAt: number | null; resumePayload: Record<string, unknown> | null }

export class Store {
  constructor(public db: Db, private key: Buffer, private clock: () => number = Date.now) {}

  // ---------- workflows ----------
  private wfFromRow(r: any): Workflow {
    const def = JSON.parse(r.definition) as WorkflowDefinition;
    return { id: r.id, name: r.name, active: !!r.active, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, ...def };
  }
  listWorkflows(): (Omit<Workflow, 'nodes' | 'edges'> & { nodeCount: number; lastRun: { status: RunStatus; at: string } | null })[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as any[];
    const last = this.db.prepare('SELECT status, created_at FROM runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT 1');
    return rows.map((r) => {
      const w = this.wfFromRow(r); const l = last.get(r.id) as any;
      const { nodes, edges, ...rest } = w;
      return { ...rest, nodeCount: nodes.length, lastRun: l ? { status: l.status, at: l.created_at } : null };
    });
  }
  getWorkflow(id: string): Workflow | undefined {
    const r = this.db.prepare('SELECT * FROM workflows WHERE id=?').get(id);
    return r ? this.wfFromRow(r) : undefined;
  }
  createWorkflow(name: string, def: WorkflowDefinition): Workflow {
    const id = uid(); const now = iso(this.clock());
    this.db.prepare('INSERT INTO workflows(id,name,definition,active,version,created_at,updated_at) VALUES (?,?,?,0,1,?,?)').run(id, name, JSON.stringify(def), now, now);
    return this.getWorkflow(id)!;
  }
  updateWorkflow(id: string, patch: { name?: string; definition?: WorkflowDefinition }): Workflow | undefined {
    const cur = this.getWorkflow(id); if (!cur) return undefined;
    const def = patch.definition ?? { nodes: cur.nodes, edges: cur.edges, settings: cur.settings };
    this.db.prepare('UPDATE workflows SET name=?, definition=?, version=version+1, updated_at=? WHERE id=?').run(patch.name ?? cur.name, JSON.stringify(def), iso(this.clock()), id);
    return this.getWorkflow(id);
  }
  setActive(id: string, active: boolean) { this.db.prepare('UPDATE workflows SET active=? WHERE id=?').run(active ? 1 : 0, id); }
  deleteWorkflow(id: string) {
    this.db.prepare('DELETE FROM workflows WHERE id=?').run(id);
    this.db.prepare('DELETE FROM schedule_state WHERE workflow_id=?').run(id);
  }

  // ---------- runs ----------
  createRun(p: { workflow: Workflow; trigger: string; triggerNodeId: string | null; triggerData: Item[]; parent?: { runId: string; nodeId: string }; depth?: number }): string {
    const id = uid();
    const snapshot: WorkflowDefinition = { nodes: p.workflow.nodes, edges: p.workflow.edges, settings: p.workflow.settings };
    this.db.prepare(`INSERT INTO runs(id,workflow_id,workflow_name,status,trigger,trigger_node_id,parent_run_id,parent_node_id,depth,snapshot,trigger_data,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, p.workflow.id, p.workflow.name, 'queued', p.trigger, p.triggerNodeId, p.parent?.runId ?? null, p.parent?.nodeId ?? null, p.depth ?? 0, JSON.stringify(snapshot), JSON.stringify(p.triggerData), iso(this.clock()));
    return id;
  }
  getRunRow(id: string): RunRow | undefined { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as RunRow | undefined; }
  findChildRun(parentRunId: string, parentNodeId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE parent_run_id=? AND parent_node_id=?').get(parentRunId, parentNodeId) as RunRow | undefined;
  }
  updateRun(id: string, f: Partial<Pick<RunRow, 'status' | 'error' | 'started_at' | 'finished_at' | 'cancel_requested'>>) {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE runs SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => f[k] as any), id);
  }
  private summaryFromRow(r: RunRow): RunSummary {
    return { id: r.id, workflowId: r.workflow_id, workflowName: r.workflow_name, status: r.status, trigger: r.trigger, triggerNodeId: r.trigger_node_id, parentRunId: r.parent_run_id, depth: r.depth, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at };
  }
  listRuns(opts: { workflowId?: string; limit?: number; status?: string } = {}): RunSummary[] {
    const where: string[] = []; const args: any[] = [];
    if (opts.workflowId) { where.push('workflow_id=?'); args.push(opts.workflowId); }
    if (opts.status) { where.push('status=?'); args.push(opts.status); }
    const sql = `SELECT id,workflow_id,workflow_name,status,trigger,trigger_node_id,parent_run_id,parent_node_id,depth,'' as snapshot,'' as trigger_data,error,cancel_requested,created_at,started_at,finished_at FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 50, 500)) as unknown as RunRow[]).map((r) => this.summaryFromRow(r));
  }
  getRunDetail(id: string): RunDetail | undefined {
    const r = this.getRunRow(id); if (!r) return undefined;
    return { ...this.summaryFromRow(r), snapshot: JSON.parse(r.snapshot), triggerData: JSON.parse(r.trigger_data), nodes: this.getRunNodes(id) };
  }
  deleteRun(id: string) {
    this.db.prepare('DELETE FROM run_nodes WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM jobs WHERE run_id=?').run(id);
    this.db.prepare('DELETE FROM runs WHERE id=?').run(id);
  }
  pruneRuns(olderThanIso: string): number {
    const ids = this.db.prepare(`SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('succeeded','failed','cancelled')`).all(olderThanIso) as { id: string }[];
    for (const { id } of ids) this.deleteRun(id);
    return ids.length;
  }

  // ---------- run_nodes ----------
  ensureRunNodes(runId: string, nodeIds: string[]) {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO run_nodes(run_id,node_id,status) VALUES (?,?, 'pending')`);
    for (const n of nodeIds) ins.run(runId, n);
  }
  private nodeFromRow(r: any): NodeRow {
    return {
      nodeId: r.node_id, status: r.status as NodeStatus, attempt: r.attempt, startedAt: r.started_at, finishedAt: r.finished_at,
      input: r.input ? JSON.parse(r.input) : null, outputs: r.outputs ? JSON.parse(r.outputs) : null, error: r.error, summary: r.summary,
      wait: r.wait ? (JSON.parse(r.wait) as WaitInfo) : null, log: JSON.parse(r.log || '[]'),
      resumeAt: r.resume_at, resumePayload: r.resume_payload ? JSON.parse(r.resume_payload) : null,
    };
  }
  getRunNodes(runId: string): NodeRow[] {
    return (this.db.prepare('SELECT * FROM run_nodes WHERE run_id=?').all(runId) as any[]).map((r) => this.nodeFromRow(r));
  }
  saveNode(runId: string, n: NodeRow) {
    this.db.prepare(`UPDATE run_nodes SET status=?,attempt=?,started_at=?,finished_at=?,input=?,outputs=?,error=?,summary=?,wait=?,resume_at=?,resume_payload=?,log=? WHERE run_id=? AND node_id=?`)
      .run(n.status, n.attempt, n.startedAt, n.finishedAt, n.input ? JSON.stringify(n.input) : null, n.outputs ? JSON.stringify(n.outputs) : null, n.error, n.summary,
        n.wait ? JSON.stringify(n.wait) : null, n.resumeAt, n.resumePayload ? JSON.stringify(n.resumePayload) : null, JSON.stringify(n.log), runId, n.nodeId);
  }
  /** Восстановление после падения: узлы в статусе running возвращаются в pending. */
  resetRunningNodes(runId: string): number {
    const r = this.db.prepare(`UPDATE run_nodes SET status='pending', log=json_insert(log,'$[#]','Восстановлено после перезапуска: узел будет выполнен заново (доставка внешних действий — как минимум один раз)') WHERE run_id=? AND status='running'`).run(runId);
    return Number(r.changes);
  }
  setResumePayload(runId: string, nodeId: string, payload: Record<string, unknown>): boolean {
    const r = this.db.prepare(`UPDATE run_nodes SET resume_payload=? WHERE run_id=? AND node_id=? AND status='waiting' AND resume_payload IS NULL`).run(JSON.stringify(payload), runId, nodeId);
    return Number(r.changes) > 0;
  }
  dueTimers(nowMs: number): { runId: string; nodeId: string; wait: WaitInfo }[] {
    const rows = this.db.prepare(`SELECT run_id,node_id,wait FROM run_nodes WHERE status='waiting' AND resume_payload IS NULL AND resume_at IS NOT NULL AND resume_at <= ?`).all(nowMs) as any[];
    return rows.map((r) => ({ runId: r.run_id, nodeId: r.node_id, wait: JSON.parse(r.wait) as WaitInfo }));
  }
  waitingApprovals(): { run: RunRow; node: NodeRow }[] {
    const rows = this.db.prepare(`SELECT rn.*, r.id as rid FROM run_nodes rn JOIN runs r ON r.id=rn.run_id WHERE rn.status='waiting' AND json_extract(rn.wait,'$.kind')='approval' AND rn.resume_payload IS NULL AND r.status='waiting' ORDER BY rn.started_at`).all() as any[];
    return rows.map((r) => ({ run: this.getRunRow(r.run_id)!, node: this.nodeFromRow(r) }));
  }
  runsWithPendingResume(): string[] {
    return (this.db.prepare(`SELECT DISTINCT run_id FROM run_nodes WHERE status='waiting' AND resume_payload IS NOT NULL`).all() as any[]).map((r) => r.run_id);
  }

  // ---------- credentials ----------
  credentialFields(type: string, data: Record<string, string>): { fields: Record<string, string>; secretSet: Record<string, boolean> } {
    const spec = CRED_TYPE_BY_NAME[type]; const fields: Record<string, string> = {}; const secretSet: Record<string, boolean> = {};
    for (const f of spec?.fields ?? []) {
      if (f.secret) secretSet[f.name] = !!data[f.name]; else if (data[f.name] !== undefined) fields[f.name] = data[f.name];
    }
    return { fields, secretSet };
  }
  listCredentials(): CredentialInfo[] {
    return (this.db.prepare('SELECT * FROM credentials ORDER BY name').all() as any[]).map((r) => {
      try {
        const data = JSON.parse(decryptString(this.key, r.data)) as Record<string, string>;
        return { id: r.id, name: r.name, type: r.type, createdAt: r.created_at, ...this.credentialFields(r.type, data) } as CredentialInfo;
      } catch {
        return { id: r.id, name: r.name, type: r.type, createdAt: r.created_at, fields: {}, secretSet: {}, broken: true } as CredentialInfo;
      }
    });
  }
  getCredentialData(id: string): { id: string; name: string; type: string; data: Record<string, string> } | undefined {
    const r = this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as any;
    return r ? { id: r.id, name: r.name, type: r.type, data: JSON.parse(decryptString(this.key, r.data)) } : undefined;
  }
  saveCredential(id: string | null, name: string, type: string, data: Record<string, string>): string {
    const now = iso(this.clock()); const enc = encryptString(this.key, JSON.stringify(data));
    if (id) { this.db.prepare('UPDATE credentials SET name=?, type=?, data=?, updated_at=? WHERE id=?').run(name, type, enc, now, id); return id; }
    const nid = uid();
    this.db.prepare('INSERT INTO credentials(id,name,type,data,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(nid, name, type, enc, now, now);
    return nid;
  }
  deleteCredential(id: string) { this.db.prepare('DELETE FROM credentials WHERE id=?').run(id); }
  allSecretValues(): string[] {
    const out: string[] = [];
    for (const r of this.db.prepare('SELECT type,data FROM credentials').all() as any[]) {
      let data: Record<string, string>; try { data = JSON.parse(decryptString(this.key, r.data)); } catch { continue; }
      for (const f of CRED_TYPE_BY_NAME[r.type]?.fields ?? []) if (f.secret && data[f.name]) out.push(data[f.name]);
    }
    return out;
  }

  // ---------- settings ----------
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
    if (!r) return fallback;
    try { return JSON.parse(r.value) as T; } catch { return fallback; }
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
}
