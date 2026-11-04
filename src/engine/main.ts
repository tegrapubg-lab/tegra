// Точка входа фонового процесса движка. Работает и под Electron (utilityProcess), и как обычный Node-процесс.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './engine';
import { generateMasterKey } from './secrets';
import { createServer } from './server';

interface InitConfig { dataDir: string; apiToken: string; masterKeyHex: string; port: number }

const parentPort = (process as unknown as { parentPort?: { on(e: string, cb: (m: any) => void): void; postMessage(m: unknown): void } }).parentPort;

function loadStandaloneConfig(): InitConfig {
  const dataDir = path.resolve(process.env.TEGRA_DATA_DIR || path.join(process.cwd(), '.tegra-dev'));
  fs.mkdirSync(dataDir, { recursive: true });
  let masterKeyHex = process.env.TEGRA_MASTER_KEY || '';
  if (!masterKeyHex) {
    // Серверный/отладочный режим: ключ лежит в файле (права 0600). В приложении Windows ключ защищён DPAPI.
    const f = path.join(dataDir, 'master.key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, generateMasterKey().toString('hex'), { mode: 0o600 });
    masterKeyHex = fs.readFileSync(f, 'utf8').trim();
  }
  return { dataDir, apiToken: process.env.TEGRA_API_TOKEN || crypto.randomBytes(24).toString('hex'), masterKeyHex, port: Number(process.env.TEGRA_PORT ?? 47821) };
}

function acquireLock(dataDir: string) {
  const lock = path.join(dataDir, 'engine.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
    if (alive) throw new Error(`Движок уже запущен (PID ${pid}). Одновременный запуск двух копий на одних данных запрещён.`);
  }
  fs.writeFileSync(lock, String(process.pid));
  return () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch { /* уже удалён */ } };
}

async function run(cfg: InitConfig) {
  const release = acquireLock(cfg.dataDir);
  const engine = new Engine({ dbPath: path.join(cfg.dataDir, 'tegra.sqlite'), masterKey: Buffer.from(cfg.masterKeyHex, 'hex') });
  const server = createServer(engine, { port: cfg.port, token: cfg.apiToken });

  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
  });
  let warning: string | undefined; let port: number;
  try { port = await listen(cfg.port); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    port = await listen(0);
    warning = `Порт ${cfg.port} занят, использован ${port}. Адреса webhook изменились.`;
  }
  engine.localBaseUrl = `http://127.0.0.1:${port}`;
  await engine.start();

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return; closing = true;
    server.close(); (server as any).closeAllConnections?.();
    await engine.stop();
    release();
    parentPort?.postMessage({ type: 'stopped' });
    process.exit(code);
  };
  parentPort?.on('message', (m: any) => { const msg = m?.data ?? m; if (msg?.type === 'shutdown') void shutdown(0); });
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('uncaughtException', (e) => { console.error('uncaughtException', e); });
  process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); });

  const ready = { type: 'ready', port, warning, pid: process.pid, token: parentPort ? undefined : cfg.apiToken };
  if (parentPort) parentPort.postMessage(ready); else console.log('TEGRA_READY ' + JSON.stringify(ready));
}

if (parentPort) {
  parentPort.on('message', (m: any) => {
    const msg = m?.data ?? m;
    if (msg?.type === 'init') run(msg.config as InitConfig).catch((e) => { parentPort.postMessage({ type: 'fatal', error: String(e?.message ?? e) }); process.exit(1); });
  });
} else {
  run(loadStandaloneConfig()).catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
}
