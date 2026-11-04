import { NODE_SPECS } from '../../shared/specs';
import { agentNode, llmNode } from './ai';
import { coreNodes } from './core';
import { httpNode } from './http';
import { telegramSendNode } from './telegram';
import type { NodeImpl } from './types';

export class NodeRegistry {
  private impls = new Map<string, NodeImpl>();
  register(impl: NodeImpl) { this.impls.set(impl.spec.type, impl); }
  get(type: string): NodeImpl | undefined { return this.impls.get(type); }
  all(): NodeImpl[] { return [...this.impls.values()]; }
}

export function createRegistry(): NodeRegistry {
  const r = new NodeRegistry();
  for (const n of [...coreNodes, httpNode, telegramSendNode, llmNode, agentNode]) r.register(n);
  for (const s of NODE_SPECS) if (!r.get(s.type)) throw new Error(`Нет исполнителя для узла ${s.type}`);
  return r;
}
