import type { AppInfo } from '../shared/api';
import type { ApprovalInfo, CredentialInfo, RunDetail, RunSummary, ValidationIssue, Workflow } from '../shared/types';

export const call = <T = any>(method: string, params?: unknown): Promise<T> => window.tegra.call(method, params) as Promise<T>;

export interface WorkflowListItem {
  id: string; name: string; active: boolean; version: number; createdAt: string; updatedAt: string; nodeCount: number;
  lastRun: { status: string; at: string } | null; settings?: unknown;
}
export interface WorkflowFull extends Workflow { webhooks: { nodeId: string; local: string; public: string | null }[] }
export interface EngineStatus {
  version: string; activeWorkflows: number; workflows: number; runsActive: number; queue: { queued: number; claimed: number };
  schedules: number; pollers: { tokenHash: string; running: boolean; lastPollAt: string | null; lastError: string | null; received: number; credentialName: string }[];
  localBaseUrl: string; publicBaseUrl: string; waitingRuns: number;
}
export interface Settings { maxConcurrentRuns: number; nodeParallelism: number; publicBaseUrl: string; runRetentionDays: number }
export interface ExampleInfo { id: string; title: string; description: string; requires: string[] }
export interface InstallResult { workflow: Workflow; secrets: { name: string; value: string }[]; notes: string[] }

export const api = {
  status: () => call<EngineStatus>('status'),
  info: () => call<AppInfo>('app.info'),
  workflows: () => call<WorkflowListItem[]>('workflows.list'),
  workflow: (id: string) => call<WorkflowFull>('workflows.get', { id }),
  runs: (workflowId?: string, limit = 60) => call<RunSummary[]>('runs.list', { workflowId, limit }),
  run: (id: string) => call<RunDetail>('runs.get', { id }),
  approvals: () => call<ApprovalInfo[]>('approvals.list'),
  credentials: () => call<CredentialInfo[]>('credentials.list'),
  validate: (definition: unknown) => call<ValidationIssue[]>('workflows.validate', { definition }),
};

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('ru-RU') : '—');
export const fmtDuration = (a: string | null, b: string | null) => {
  if (!a) return '—'; const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  return ms < 1000 ? `${ms} мс` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60_000)} мин ${Math.round((ms % 60_000) / 1000)} с`;
};
export const STATUS_RU: Record<string, string> = {
  queued: 'В очереди', running: 'Выполняется', waiting: 'Ожидает', succeeded: 'Успешно', failed: 'Ошибка', cancelled: 'Отменён', pending: 'Ожидает очереди', skipped: 'Пропущен',
};
