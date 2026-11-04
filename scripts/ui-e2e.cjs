// Сквозная проверка в настоящем Electron: окно, безопасность, сборка сценария мышью, запуск, просмотр результатов.
// Запуск: xvfb-run -a node scripts/ui-e2e.cjs <каталог для скриншотов>
const { _electron } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shots = process.argv[2] || path.join(os.tmpdir(), 'tegra-shots');
fs.mkdirSync(shots, { recursive: true });
const assert = (c, m) => { if (!c) { throw new Error('ПРОВАЛ: ' + m); } console.log('  ✓', m); };

(async () => {
  const hits = [];
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hits.push({ url: req.url, body: b }); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true, echo: JSON.parse(b || '{}') })); }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${mock.address().port}/orders`;

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tegra-ud-'));
  const launch = () => _electron.launch({ executablePath: require('electron'), args: [process.env.TEGRA_APP_PATH || '.', '--no-sandbox', '--disable-gpu'], cwd: path.resolve(__dirname, '..'), env: { ...process.env, TEGRA_USER_DATA: userData, TEGRA_DEVTOOLS: '1' } });
  let app = await launch();
  let win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await win.setViewportSize({ width: 1360, height: 860 });
  await win.waitForSelector('.brand', { timeout: 30000 });
  console.log('1. Окно и безопасность');
  const sec = await win.evaluate(() => ({ req: typeof require, proc: typeof process, bridge: Object.keys(window.tegra).sort().join(','), title: document.title }));
  assert(sec.req === 'undefined' && sec.proc === 'undefined', 'в интерфейсе нет Node (require/process недоступны)');
  assert(sec.bridge === 'call,onEvent', 'preload отдаёт только call и onEvent');
  const prefs = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { ci: p.contextIsolation, sb: p.sandbox, ni: p.nodeIntegration }; });
  assert(prefs.ci === true && prefs.sb === true && prefs.ni === false, 'contextIsolation=true, sandbox=true, nodeIntegration=false');
  let blocked = await win.evaluate(() => window.tegra.call('fs.readFile', { path: '/etc/passwd' }).then(() => 'ok', (e) => e.message));
  assert(/Неизвестный метод/.test(blocked), 'неразрешённый IPC-метод отклонён: ' + blocked);
  await win.screenshot({ path: path.join(shots, '01-workflows-empty.png') });

  console.log('2. Создание сценария мышью');
  await win.click('text=＋ Новый сценарий');
  await win.waitForSelector('.react-flow__renderer');
  await win.fill('.ed-name', 'UI: заказ → IF → HTTP');
  const add = async (label) => { await win.click(`.pal-item:has-text("${label}")`); await win.waitForTimeout(150); };
  const nodeBy = (name) => win.locator(`.react-flow__node:has(.fn-head b:text-is("${name}"))`);
  // триггер уже есть. Выбираем его и добавляем цепочку
  await win.click('.react-flow__node >> nth=0');
  await add('Поля (создать/изменить)');
  await add('IF (условие)');
  await add('HTTP-запрос');
  await win.click('.react-flow__node:has(.fn-head b:text-is("IF (условие)"))', { position: { x: 20, y: 15 } });
  await add('Поля (создать/изменить)');
  assert((await win.locator('.react-flow__node').count()) === 5, 'на холсте 5 узлов');

  const drag = async (fromNode, fromHandle, toNode, toHandle) => {
    const a = await nodeBy(fromNode).locator(`.react-flow__handle.source[data-handleid="${fromHandle}"]`).boundingBox();
    const b = await nodeBy(toNode).locator(`.react-flow__handle.target[data-handleid="${toHandle}"]`).boundingBox();
    await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await win.mouse.down();
    await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 }); await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 }); await win.mouse.up();
  };
  await drag('Ручной запуск', 'main', 'Поля (создать/изменить)', 'main');
  await drag('Поля (создать/изменить)', 'main', 'IF (условие)', 'main');
  await drag('IF (условие)', 'true', 'HTTP-запрос', 'main');
  await drag('IF (условие)', 'false', 'Поля (создать/изменить) 2', 'main');
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(shots, '02-canvas-wired.png') });
  console.log('  edges:', await win.locator('.react-flow__edge').count());
  assert((await win.locator('.react-flow__edge').count()) === 4, 'соединены 4 связи');
  await win.screenshot({ path: path.join(shots, '02-canvas-wired.png') });

  console.log('3. Настройка узлов, проверка обязательных параметров');
  await win.screenshot({ path: path.join(shots, '02b-before-config.png') }); console.log('  top:', (await win.locator('.ed-top').innerText()).replace(/\n/g, ' | '));
  assert(await win.locator('.ed-top .badge.st-failed').count() === 1, 'до настройки редактор показывает ошибки валидации');
  await nodeBy('Поля (создать/изменить)').click({ position: { x: 20, y: 15 } });
  await win.click('.props >> text=＋ Добавить');
  const row = win.locator('.props .list-row').first();
  await row.locator('input').nth(0).fill('total');
  await row.locator('input').nth(1).fill('{{ $json.n * 2 }}');
  await row.locator('select').selectOption('number');
  await nodeBy('IF (условие)').click({ position: { x: 20, y: 15 } });
  await win.click('.props >> text=＋ Добавить');
  const crow = win.locator('.props .list-row').first();
  await crow.locator('input').nth(0).fill('{{ $json.total }}');
  await crow.locator('select').selectOption('gt');
  await crow.locator('input').nth(1).fill('40');
  await nodeBy('HTTP-запрос').click({ position: { x: 20, y: 15 } });
  await win.locator('.props label.field:has(span:text-is("Метод")) select').selectOption('POST');
  await win.locator('.props label.field:has(span:text-is("URL *")) input').fill(mockUrl);
  await win.locator('.props label.field:has(span:text-is("Тело")) select').selectOption('json');
  await win.locator('.props label.field:has(span:text-is("Содержимое тела")) textarea').fill('{"total": {{ $json.total }}}');
  await win.locator('.props label.field:has(span:text-is("Разрешить локальные и приватные адреса")) input').check();
  await nodeBy('Поля (создать/изменить) 2').click({ position: { x: 20, y: 15 } });
  await win.click('.props >> text=＋ Добавить');
  const orow = win.locator('.props .list-row').first();
  await orow.locator('input').nth(0).fill('note'); await orow.locator('input').nth(1).fill('мало');
  await win.waitForTimeout(300);
  assert(await win.locator('.ed-top .badge.st-succeeded').count() === 1, 'после настройки проверка пройдена');
  await win.keyboard.press('Control+s'); await win.waitForSelector('.dirty:has-text("сохранено")', { timeout: 5000 });
  assert(true, 'сценарий сохранён (Ctrl+S)');
  await win.screenshot({ path: path.join(shots, '03-configured.png') });

  console.log('4. Запуск с данными через очередь и фоновый исполнитель');
  await win.click('text=с данными…');
  await win.locator('.modal textarea').fill('{"n": 21}');
  await win.click('.modal >> text=Запустить');
  await win.waitForSelector('.ed-bottom .badge.st-succeeded', { timeout: 20000 });
  assert(hits.length === 1 && JSON.parse(hits[0].body).total === 42, 'HTTP-запрос реально ушёл: ' + hits[0]?.body);
  assert((await win.locator('.fnode.st-succeeded').count()) === 4, 'на холсте 4 успешных узла');
  assert((await win.locator('.fnode.st-skipped').count()) === 1, 'ложная ветка IF пропущена');
  await win.click('.tl-row:has-text("HTTP-запрос")');
  await win.waitForSelector('.ed-bottom .node-detail');
  const detail = await win.locator('.ed-bottom .node-detail').innerText();
  assert(/"accepted": true/.test(detail) && /"status": 201/.test(detail), 'в панели виден вход/выход HTTP-узла');
  await win.screenshot({ path: path.join(shots, '04-run-result.png') });

  console.log('5. Персистентность: перезапуск приложения');
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  app = await launch(); win = await app.firstWindow(); await win.setViewportSize({ width: 1360, height: 860 });
  await win.waitForSelector('.react-flow__renderer', { timeout: 30000 });
  assert((await win.locator('.react-flow__node').count()) === 5, 'после перезапуска редактор восстановил последний сценарий (5 узлов)');
  assert((await win.inputValue('.ed-name')) === 'UI: заказ → IF → HTTP', 'имя сценария сохранено');
  await win.click('text=История');
  await win.waitForSelector('.ed-bottom .tbl tbody tr .badge.st-succeeded');
  assert(true, 'история запусков сохранена в SQLite');
  await win.screenshot({ path: path.join(shots, '05-after-restart.png') });

  console.log('6. Закрытие окна не останавливает движок (трей)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await new Promise((r) => setTimeout(r, 800));
  const st = await app.evaluate(({ BrowserWindow }) => ({ n: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0]?.isVisible() }));
  assert(st.n === 1 && st.visible === false, 'окно скрыто, приложение живо');
  const eng = await app.evaluate(async () => { const r = await fetch('http://127.0.0.1:47821/api/status').catch(() => null); return r ? r.status : 'no'; });
  assert(eng === 401, 'движок продолжает отвечать (401 без токена) при скрытом окне');

  console.log('7. Полный выход: корректное завершение фонового процесса');
  const lock = path.join(userData, 'data', 'engine.lock');
  assert(fs.existsSync(lock), 'до выхода движок держит замок данных');
  const proc = app.process();
  const exited = new Promise((r) => proc.on('exit', r));
  await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.tegra.call('app.quit')").catch(() => {}); });
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('приложение не завершилось за 20 с')), 20000))]);
  assert(!fs.existsSync(lock), 'после полного выхода замок снят, фоновый процесс завершён штатно');
  mock.close();
  console.log('\nUI E2E: ВСЁ ПРОШЛО. Скриншоты:', shots);
  process.exit(0);
})().catch((e) => { console.error('\n' + (e.stack || e)); process.exit(1); });
