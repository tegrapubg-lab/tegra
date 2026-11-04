import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Engine, type EngineOptions } from '../src/engine/engine';
import { generateMasterKey } from '../src/engine/secrets';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../src/shared/types';

export const key = generateMasterKey();
export function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tegra-test-')); }

export function makeEngine(opts: Partial<EngineOptions> & { dir?: string } = {}) {
  const dir = opts.dir ?? tmpDir();
  const engine = new Engine({ dbPath: path.join(dir, 'db.sqlite'), masterKey: opts.masterKey ?? key, background: false, ...opts });
  return { engine, dir };
}

export const node = (id: string, type: string, params: Record<string, unknown> = {}, settings?: WorkflowNode['settings'], name?: string): WorkflowNode =>
  ({ id, type, name: name ?? id, position: { x: 0, y: 0 }, params, settings });
export const edge = (s: string, sh: string, t: string, th = 'main'): WorkflowEdge => ({ id: `${s}-${sh}-${t}-${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th });
export const wf = (nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition => ({ nodes, edges });

export async function runToEnd(engine: Engine, workflowId: string, input?: unknown) {
  const runId = engine.startRun(workflowId, { input });
  await engine.drain();
  return engine.store.getRunDetail(runId)!;
}

/** Локальный тестовый HTTP-сервер. */
export async function mockServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); requests.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handler(req, body, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, requests, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(fn: () => T | Promise<T>, ms = 10000, step = 25): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn(); if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: тайм-аут');
    await sleep(step);
  }
}
