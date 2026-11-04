import type { Item, WaitInfo, WorkflowNode } from '../../shared/types';
import type { NodeSpec as Spec } from '../../shared/specs';
import type { ExprContext } from '../expr';
import type { LlmRegistry } from '../llm';

export interface CredentialData { id: string; name: string; type: string; data: Record<string, string> }

/** То, что движок предоставляет узлам. Узлы не знают о БД напрямую. */
export interface EngineServices {
  now(): number;
  getCredential(id: string): CredentialData;
  llm: LlmRegistry;
  /** Запуск вложенного сценария. Создаёт (идемпотентно) дочерний запуск и ставит его в очередь. */
  startChildRun(parentRunId: string, parentNodeId: string, workflowId: string, items: Item[]): string;
  /** Синхронный запуск сценария внутри процесса (инструмент агента). */
  runInline(workflowId: string, items: Item[], signal: AbortSignal, depth: number): Promise<{ status: string; items: Item[]; error?: string }>;
  workflowName(id: string): string | undefined;
  telegramApiBase(cred: CredentialData): string;
  redactor: { string(s: string): string };
}

export interface NodeExecContext {
  node: WorkflowNode;
  spec: Spec;
  runId: string;
  runDepth: number;
  /** Входные элементы по входам узла. */
  inputs: Record<string, Item[]>;
  /** Элементы основного входа (все входящие рёбра, добавлены по порядку). */
  items: Item[];
  triggerData: Item[];
  attempt: number;
  signal: AbortSignal;
  svc: EngineServices;
  /** Значение параметра для элемента index с раскрытием выражений. */
  param(name: string, index?: number): unknown;
  str(name: string, index?: number): string;
  num(name: string, index?: number, fallback?: number): number;
  bool(name: string): boolean;
  raw(name: string): unknown;
  exprCtx(index: number): ExprContext;
  log(msg: string): void;
}

export type ExecResult =
  | { outputs: Record<string, Item[]>; summary?: string }
  | { wait: WaitInfo & { resumeAt?: string | null }; summary?: string }
  | { skip: string };

export interface ResumeResult { outputs: Record<string, Item[]>; summary?: string }

export interface NodeImpl {
  spec: Spec;
  execute(ctx: NodeExecContext): Promise<ExecResult>;
  resume?(ctx: NodeExecContext, wait: WaitInfo, payload: Record<string, unknown>): Promise<ResumeResult>;
}

