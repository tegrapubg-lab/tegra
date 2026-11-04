import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, session, shell, Tray, utilityProcess, nativeImage, type UtilityProcess } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { API_METHODS, APP_METHODS, type AppInfo } from '../shared/api';

// ---------- пути и конфигурация ----------
if (process.env.TEGRA_USER_DATA) app.setPath('userData', process.env.TEGRA_USER_DATA);
const userData = app.getPath('userData'); // Windows: %APPDATA%\Tegra Flow
const dataDir = path.join(userData, 'data');
const logsDir = path.join(userData, 'logs');
const backupsDir = path.join(userData, 'backups');
for (const d of [dataDir, logsDir, backupsDir]) fs.mkdirSync(d, { recursive: true });
const configFile = path.join(userData, 'config.json');

interface Config { closeToTray: boolean; autostart: boolean; port: number; trayNoticeShown: boolean; lastAutoBackup: number }
const defaultConfig: Config = { closeToTray: true, autostart: false, port: 47821, trayNoticeShown: false, lastAutoBackup: 0 };
let config: Config = { ...defaultConfig };
try { config = { ...defaultConfig, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch { /* первый запуск */ }
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

app.setAppUserModelId('com.tegra.flow');
const log = (...a: unknown[]) => { try { fs.appendFileSync(path.join(logsDir, 'main.log'), `${new Date().toISOString()} ${a.map(String).join(' ')}\n`); } catch { /* лог недоступен */ } };

// ---------- один экземпляр ----------
if (!app.requestSingleInstanceLock()) { app.exit(0); }
app.on('second-instance', () => showWindow());

// ---------- мастер-ключ (DPAPI через safeStorage на Windows) ----------
function loadMasterKey(): { hex: string; protectedByOs: boolean } {
  const encFile = path.join(userData, 'master.key.enc');
  const plainFile = path.join(userData, 'master.key');
  const canEncrypt = safeStorage.isEncryptionAvailable();
  if (fs.existsSync(encFile) && canEncrypt) return { hex: safeStorage.decryptString(fs.readFileSync(encFile)), protectedByOs: true };
  if (fs.existsSync(plainFile)) return { hex: fs.readFileSync(plainFile, 'utf8').trim(), protectedByOs: false };
  const hex = crypto.randomBytes(32).toString('hex');
  if (canEncrypt) fs.writeFileSync(encFile, safeStorage.encryptString(hex), { mode: 0o600 });
  else fs.writeFileSync(plainFile, hex, { mode: 0o600 });
  return { hex, protectedByOs: canEncrypt };
}

// ---------- процесс движка ----------
let engine: UtilityProcess | null = null;
let enginePort = 0;
let engineToken = '';
let engineReady: Promise<void> = Promise.resolve();
let quitting = false;
let restartTimes: number[] = [];
let masterKey: { hex: string; protectedByOs: boolean };

function startEngine(): Promise<void> {
  return new Promise((resolve, reject) => {
    engineToken = crypto.randomBytes(24).toString('hex');
    const child = utilityProcess.fork(path.join(__dirname, '../engine/main.js'), [], { serviceName: 'Tegra Flow Engine', stdio: 'pipe', execArgv: ['--no-warnings'] });
    engine = child;
    const logStream = fs.createWriteStream(path.join(logsDir, 'engine.log'), { flags: 'a' });
    child.stdout?.on('data', (d) => logStream.write(d)); child.stderr?.on('data', (d) => logStream.write(d));
    let settled = false;
    child.on('message', (m: any) => {
      if (m?.type === 'ready') { enginePort = m.port; settled = true; if (m.warning) log('engine warning:', m.warning); resolve(); }
      else if (m?.type === 'fatal') { settled = true; reject(new Error(m.error)); }
    });
    child.on('exit', (code) => {
      log('engine exit', code);
      if (engine === child) engine = null;
      if (!settled) { settled = true; reject(new Error(`Движок завершился при запуске (код ${code}). См. ${path.join(logsDir, 'engine.log')}`)); return; }
      if (quitting) return;
      // неожиданное падение: перезапуск (не чаще 5 раз в минуту)
      const now = Date.now(); restartTimes = restartTimes.filter((t) => now - t < 60_000); restartTimes.push(now);
      if (restartTimes.length > 5) { dialog.showErrorBox('Tegra Flow', 'Фоновый движок постоянно падает. Автоматизация остановлена. См. журнал: ' + logsDir); return; }
      log('перезапуск движка');
      engineReady = startEngine().then(() => send({ type: 'engine-restarted' })).catch((e) => log('перезапуск не удался', e));
    });
    child.postMessage({ type: 'init', config: { dataDir, apiToken: engineToken, masterKeyHex: masterKey.hex, port: config.port } });
  });
}

function stopEngine(): Promise<void> {
  const child = engine; if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill(); } catch { /* уже мёртв */ } resolve(); }, 10_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.postMessage({ type: 'shutdown' }); } catch { clearTimeout(t); resolve(); }
  });
}

async function engineFetch(verb: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  await engineReady;
  const res = await fetch(`http://127.0.0.1:${enginePort}${url}`, {
    method: verb, headers: { authorization: `Bearer ${engineToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text(); let j: any = null; try { j = JSON.parse(text); } catch { /* не JSON */ }
  if (!res.ok) { const e = new Error(j?.error ?? `Ошибка движка (${res.status})`) as Error & { issues?: unknown }; e.issues = j?.issues; throw e; }
  return j;
}

// ---------- окно ----------
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const send = (e: { type: string; data?: unknown }) => { if (win && !win.isDestroyed()) win.webContents.send('tegra:event', e); };

const RENDERER_INDEX = path.join(__dirname, '../renderer/index.html');
const isOurFrame = (url: string) => url.startsWith('file://') && decodeURIComponent(url).replace(/\\/g, '/').includes(RENDERER_INDEX.replace(/\\/g, '/'));

function createWindow(show: boolean) {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 600, show: false, backgroundColor: '#0f1220', title: 'Tegra Flow',
    icon: path.join(__dirname, '../../build/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !app.isPackaged || !!process.env.TEGRA_DEVTOOLS },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isOurFrame(url)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (show) win?.show(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (config.closeToTray) {
      win?.hide();
      if (!config.trayNoticeShown) {
        config.trayNoticeShown = true; saveConfig();
        new Notification({ title: 'Tegra Flow продолжает работать', body: 'Окно закрыто, но сценарии и расписания активны в системном трее. Чтобы выйти полностью, выберите «Выйти полностью» в меню значка.' }).show();
      }
    } else void requestQuit();
  });
  void win.loadFile(RENDERER_INDEX);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

// ---------- трей ----------
async function trayStatusLine(): Promise<string> {
  try { const s = await engineFetch('GET', '/api/status', undefined, 3000); return `Активных сценариев: ${s.activeWorkflows} · ожидают: ${s.waitingRuns}`; } catch { return 'Движок недоступен'; }
}
async function rebuildTray() {
  if (!tray) return;
  const status = await trayStatusLine();
  tray.setToolTip(`Tegra Flow — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Tegra Flow', click: () => showWindow() },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Автозапуск при входе в Windows', type: 'checkbox', checked: config.autostart, click: (i) => setAutostart(i.checked) },
    { label: 'Закрытие окна сворачивает в трей', type: 'checkbox', checked: config.closeToTray, click: (i) => { config.closeToTray = i.checked; saveConfig(); void rebuildTray(); } },
    { type: 'separator' },
    { label: 'Выйти полностью (остановить автоматизацию)…', click: () => void requestQuit() },
  ]));
}
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '../../build/tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  tray.on('right-click', () => void rebuildTray());
  void rebuildTray();
  setInterval(() => void rebuildTray(), 30_000);
}

function setAutostart(on: boolean) {
  config.autostart = on; saveConfig();
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'], name: 'Tegra Flow' });
  void rebuildTray();
}

// ---------- выход ----------
async function requestQuit(): Promise<void> {
  if (quitting) return;
  let active = 0; let waiting = 0;
  try { const s = await engineFetch('GET', '/api/status', undefined, 3000); active = s.activeWorkflows + s.runsActive; waiting = s.waitingRuns; } catch { /* движок недоступен */ }
  if (active > 0 || waiting > 0) {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() && win.isVisible() ? win : (undefined as any), {
      type: 'warning', buttons: ['Выйти и остановить автоматизацию', 'Отмена'], defaultId: 1, cancelId: 1, title: 'Полный выход',
      message: 'При полном выходе автоматизация будет остановлена.',
      detail: `Активных сценариев: ${active - 0}. Ожидающих запусков: ${waiting}.\nРасписания, webhook и получение сообщений Telegram не будут работать, пока вы снова не откроете приложение. Чтобы сценарии продолжали работать, просто закройте окно — приложение уйдёт в системный трей.`,
    });
    if (r.response !== 0) return;
  }
  await doQuit();
}
async function doQuit() {
  quitting = true;
  await stopEngine();
  tray?.destroy();
  app.exit(0);
}
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); void doQuit(); } });
app.on('window-all-closed', () => { /* остаёмся в трее */ });

// ---------- IPC ----------
const paramsSchema = z.record(z.string(), z.unknown()).optional();

async function handleApp(method: (typeof APP_METHODS)[number], p: Record<string, any>): Promise<unknown> {
  switch (method) {
    case 'app.info': {
      const info: AppInfo = { version: app.getVersion(), platform: process.platform, dataDir, engineUrl: `http://127.0.0.1:${enginePort}`, autostart: config.autostart, closeToTray: config.closeToTray, safeStorage: masterKey.protectedByOs, isPackaged: app.isPackaged };
      return info;
    }
    case 'app.setAutostart': setAutostart(!!p.value); return { ok: true };
    case 'app.setCloseToTray': config.closeToTray = !!p.value; saveConfig(); void rebuildTray(); return { ok: true };
    case 'app.quit': void requestQuit(); return { ok: true };
    case 'app.openDataDir': await shell.openPath(userData); return { ok: true };
    case 'app.openExternal': { const u = String(p.url ?? ''); if (!/^https?:\/\//.test(u)) throw new Error('Разрешены только http(s) ссылки'); await shell.openExternal(u); return { ok: true }; }
    case 'file.saveJson': {
      const content = String(p.content ?? ''); if (content.length > 10_000_000) throw new Error('Файл слишком большой');
      const r = await dialog.showSaveDialog(win!, { defaultPath: String(p.defaultName ?? 'workflow.json').replace(/[\\/:*?"<>|]/g, '_'), filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { saved: false };
      fs.writeFileSync(r.filePath, content, 'utf8'); return { saved: true, path: r.filePath };
    }
    case 'file.openJson': {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { opened: false };
      const st = fs.statSync(r.filePaths[0]); if (st.size > 10_000_000) throw new Error('Файл больше 10 МБ');
      return { opened: true, name: path.basename(r.filePaths[0]), content: fs.readFileSync(r.filePaths[0], 'utf8') };
    }
    case 'backup.create': {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const r = await dialog.showSaveDialog(win!, { defaultPath: `tegra-flow-backup-${stamp}.sqlite`, filters: [{ name: 'Резервная копия Tegra Flow', extensions: ['sqlite'] }] });
      if (r.canceled || !r.filePath) return { saved: false };
      await engineFetch('POST', '/api/backup', { path: r.filePath });
      return { saved: true, path: r.filePath };
    }
    case 'backup.restore': return restoreBackup();
  }
}

async function restoreBackup() {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Резервная копия Tegra Flow', extensions: ['sqlite'] }] });
  if (r.canceled || !r.filePaths[0]) return { restored: false };
  const file = r.filePaths[0];
  // проверка: это база Tegra Flow, а не произвольный файл
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const v = db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number };
    const wf = db.prepare('SELECT COUNT(*) c FROM workflows').get() as { c: number };
    db.close();
    if (!v?.v) throw new Error('нет версий схемы');
    if (v.v > 1) throw new Error(`копия создана более новой версией приложения (схема ${v.v})`);
    const c = await dialog.showMessageBox(win!, { type: 'warning', buttons: ['Восстановить', 'Отмена'], defaultId: 1, cancelId: 1, title: 'Восстановление', message: `Заменить текущие данные копией? (сценариев в копии: ${wf.c})`, detail: 'Текущая база будет сохранена в папке backups. Подключения (секреты) расшифруются только на этом же компьютере и в этом же профиле Windows. Автоматизация на время восстановления остановится.' });
    if (c.response !== 0) return { restored: false };
  } catch (e) { throw new Error(`Файл не является резервной копией Tegra Flow: ${(e as Error).message}`); }
  await stopEngine();
  const db = path.join(dataDir, 'tegra.sqlite');
  const keep = path.join(backupsDir, `pre-restore-${Date.now()}.sqlite`);
  if (fs.existsSync(db)) fs.copyFileSync(db, keep);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(db + ext, { force: true });
  fs.copyFileSync(file, db);
  engineReady = startEngine();
  await engineReady;
  win?.webContents.reload();
  return { restored: true, previousSavedAs: keep };
}

ipcMain.handle('tegra:call', async (event, method: unknown, params: unknown) => {
  try {
    if (!event.senderFrame || !isOurFrame(event.senderFrame.url)) throw new Error('Недопустимый источник запроса');
    if (typeof method !== 'string') throw new Error('Некорректный метод');
    const p = paramsSchema.parse(params) ?? {};
    if (JSON.stringify(p).length > 12_000_000) throw new Error('Слишком большой запрос');
    if ((APP_METHODS as readonly string[]).includes(method)) return { ok: true, data: await handleApp(method as (typeof APP_METHODS)[number], p) };
    if (!Object.hasOwn(API_METHODS, method)) throw new Error(`Неизвестный метод «${method.slice(0, 60)}»`);
    const def = API_METHODS[method as keyof typeof API_METHODS];
    const rest: Record<string, unknown> = { ...p };
    const url = def.path.replace(/:(\w+)/g, (_m, k: string) => { const v = rest[k]; delete rest[k]; if (typeof v !== 'string' || !v || v.length > 200) throw new Error(`Не указан параметр ${k}`); return encodeURIComponent(v); });
    if (def.verb === 'GET' || def.verb === 'DELETE') {
      const q = new URLSearchParams(Object.entries(rest).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      return { ok: true, data: await engineFetch(def.verb, url + (q.size ? `?${q}` : '')) };
    }
    return { ok: true, data: await engineFetch(def.verb, url, rest) };
  } catch (e) {
    const err = e as Error & { issues?: unknown };
    return { ok: false, error: err.message || 'Ошибка', issues: err.issues };
  }
});

// ---------- запуск ----------
async function autoBackup() {
  if (Date.now() - config.lastAutoBackup < 24 * 3600_000) return;
  try {
    await engineFetch('POST', '/api/backup', { path: path.join(backupsDir, `auto-${new Date().toISOString().slice(0, 10)}.sqlite`) });
    config.lastAutoBackup = Date.now(); saveConfig();
    const autos = fs.readdirSync(backupsDir).filter((f) => f.startsWith('auto-')).sort();
    for (const f of autos.slice(0, Math.max(0, autos.length - 7))) fs.rmSync(path.join(backupsDir, f), { force: true });
  } catch (e) { log('autobackup failed', e); }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"] } }));
  try {
    masterKey = loadMasterKey();
    engineReady = startEngine();
    await engineReady;
  } catch (e) {
    log('fatal start', e);
    dialog.showErrorBox('Tegra Flow не удалось запустить', String((e as Error).message));
    app.exit(1); return;
  }
  const hidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  createWindow(!hidden);
  createTray();
  void autoBackup();
  if (config.autostart) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'], name: 'Tegra Flow' });
});
