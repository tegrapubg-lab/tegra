// Ограниченный мост между интерфейсом и main: два метода и больше ничего.
import { contextBridge, ipcRenderer } from 'electron';

type Envelope = { ok: true; data: unknown } | { ok: false; error: string; issues?: unknown };

contextBridge.exposeInMainWorld('tegra', {
  async call(method: string, params?: unknown): Promise<unknown> {
    if (typeof method !== 'string' || method.length > 80) throw new Error('Некорректный метод');
    const r = (await ipcRenderer.invoke('tegra:call', method, params)) as Envelope;
    if (!r.ok) { const e = new Error(r.error) as Error & { issues?: unknown }; e.issues = r.issues; throw e; }
    return r.data;
  },
  onEvent(cb: (e: { type: string; data?: unknown }) => void): () => void {
    if (typeof cb !== 'function') throw new Error('callback required');
    const handler = (_: unknown, e: { type: string; data?: unknown }) => cb(e);
    ipcRenderer.on('tegra:event', handler);
    return () => ipcRenderer.removeListener('tegra:event', handler);
  },
});
