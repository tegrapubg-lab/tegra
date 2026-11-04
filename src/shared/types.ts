// Общее описание сценариев и данных. Используется UI, main и engine.

export interface Item {
  json: Record<string, unknown>;
}

export interface NodeSettings {
  /** Тайм-аут выполнения узла, мс (по умолчанию 60000). */
  timeoutMs?: number;
  /** Всего попыток (1 = без повторов). */
  maxAttempts?: number;
  /** Задержка между попытками, мс (максимум 300000). */
  retryDelayMs?: number;
  /** fail — остановить запуск; continue — передать элемент с полем error дальше. */
  onError?: 'fail' | 'continue';
}

export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  settings?: NodeSettings;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface WorkflowSettings {
  /** Сколько узлов одного запуска могут идти параллельно. */
  nodeParallelism?: number;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings?: WorkflowSettings;
}

export interface Workflow extends WorkflowDefinition {
  id: string;
  name: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface RunNodeState {
  nodeId: string;
  status: NodeStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  input: Item[] | null;
  outputs: Record<string, Item[]> | null;
  error: string | null;
  summary: string | null;
  wait: WaitInfo | null;
  log: string[];
}

export interface WaitInfo {
  kind: 'timer' | 'approval' | 'child';
  resumeAt?: string | null;
  message?: string;
  childRunId?: string;
  /** Что подставить, если ожидание закончилось по тайм-ауту (для подтверждения). */
  timeoutPayload?: Record<string, unknown>;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  trigger: string;
  triggerNodeId: string | null;
  parentRunId: string | null;
  depth: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  snapshot: WorkflowDefinition;
  nodes: RunNodeState[];
  triggerData: Item[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export interface CredentialInfo {
  id: string;
  name: string;
  type: string;
  /** Несекретные поля. */
  fields: Record<string, string>;
  /** Какие секретные поля заполнены (значения никогда не возвращаются). */
  secretSet: Record<string, boolean>;
  createdAt: string;
}

export interface ApprovalInfo {
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  nodeName: string;
  message: string;
  since: string;
  timeoutAt: string | null;
  itemsPreview: Item[];
}
