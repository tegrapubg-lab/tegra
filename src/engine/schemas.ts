import { z } from 'zod';

const node = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  params: z.record(z.string(), z.unknown()).default({}),
  settings: z.object({
    timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    retryDelayMs: z.number().int().min(0).max(300_000).optional(),
    onError: z.enum(['fail', 'continue']).optional(),
  }).optional(),
});
const edge = z.object({
  id: z.string().min(1).max(200), source: z.string().min(1).max(100), sourceHandle: z.string().min(1).max(50),
  target: z.string().min(1).max(100), targetHandle: z.string().min(1).max(50),
});

export const definitionSchema = z.object({
  nodes: z.array(node).max(500),
  edges: z.array(edge).max(2000),
  settings: z.object({ nodeParallelism: z.number().int().min(1).max(16).optional() }).optional(),
});

export const workflowCreateSchema = z.object({ name: z.string().trim().min(1).max(200), definition: definitionSchema.optional() });
export const workflowUpdateSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), definition: definitionSchema.optional() });
export const runSchema = z.object({ triggerNodeId: z.string().optional(), input: z.unknown().optional() });
export const credentialSchema = z.object({
  name: z.string().trim().min(1).max(100), type: z.string().min(1).max(50),
  data: z.record(z.string(), z.string().max(10_000)),
});
export const exportSchema = z.object({
  format: z.literal('tegra-flow'), version: z.number().int().min(1).max(1),
  name: z.string().trim().min(1).max(200), definition: definitionSchema,
});
export const settingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
  nodeParallelism: z.number().int().min(1).max(16).optional(),
  publicBaseUrl: z.string().max(300).optional(),
  runRetentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();
