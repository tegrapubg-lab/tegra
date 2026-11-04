// Белый список методов API между интерфейсом, main и engine.
// UI вызывает window.tegra.call('имя', params). main проверяет имя и параметры,
// затем проксирует в HTTP API движка (токен знает только main).

export interface ApiMethod {
  verb: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Шаблон пути; :name подставляется из params. */
  path: string;
}

export const API_METHODS = {
  'status': { verb: 'GET', path: '/api/status' },
  'nodeTypes.list': { verb: 'GET', path: '/api/node-types' },
  'workflows.list': { verb: 'GET', path: '/api/workflows' },
  'workflows.get': { verb: 'GET', path: '/api/workflows/:id' },
  'workflows.create': { verb: 'POST', path: '/api/workflows' },
  'workflows.update': { verb: 'PUT', path: '/api/workflows/:id' },
  'workflows.delete': { verb: 'DELETE', path: '/api/workflows/:id' },
  'workflows.duplicate': { verb: 'POST', path: '/api/workflows/:id/duplicate' },
  'workflows.setActive': { verb: 'POST', path: '/api/workflows/:id/active' },
  'workflows.export': { verb: 'GET', path: '/api/workflows/:id/export' },
  'workflows.import': { verb: 'POST', path: '/api/workflows/import' },
  'workflows.validate': { verb: 'POST', path: '/api/workflows/validate' },
  'workflows.run': { verb: 'POST', path: '/api/workflows/:id/run' },
  'runs.list': { verb: 'GET', path: '/api/runs' },
  'runs.get': { verb: 'GET', path: '/api/runs/:id' },
  'runs.cancel': { verb: 'POST', path: '/api/runs/:id/cancel' },
  'runs.delete': { verb: 'DELETE', path: '/api/runs/:id' },
  'approvals.list': { verb: 'GET', path: '/api/approvals' },
  'approvals.decide': { verb: 'POST', path: '/api/runs/:id/nodes/:nodeId/decision' },
  'credentials.list': { verb: 'GET', path: '/api/credentials' },
  'credentials.create': { verb: 'POST', path: '/api/credentials' },
  'credentials.update': { verb: 'PUT', path: '/api/credentials/:id' },
  'credentials.delete': { verb: 'DELETE', path: '/api/credentials/:id' },
  'settings.get': { verb: 'GET', path: '/api/settings' },
  'settings.set': { verb: 'PUT', path: '/api/settings' },
  'examples.list': { verb: 'GET', path: '/api/examples' },
  'examples.install': { verb: 'POST', path: '/api/examples/:id/install' },
  'pollers.status': { verb: 'GET', path: '/api/pollers' },
} as const satisfies Record<string, ApiMethod>;

export type ApiMethodName = keyof typeof API_METHODS;

/** Методы, которые выполняет сам main (диалоги, трей, автозапуск, бэкап). */
export const APP_METHODS = [
  'app.info', 'app.setAutostart', 'app.setCloseToTray', 'app.quit', 'app.openDataDir',
  'file.saveJson', 'file.openJson', 'backup.create', 'backup.restore', 'app.openExternal',
] as const;
export type AppMethodName = (typeof APP_METHODS)[number];

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
  engineUrl: string;
  autostart: boolean;
  closeToTray: boolean;
  safeStorage: boolean;
  isPackaged: boolean;
}

export interface TegraBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(cb: (e: { type: string; data?: unknown }) => void): () => void;
}
