import crypto from 'node:crypto';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../shared/types';
import type { Engine } from './engine';

type P = Record<string, unknown>;
const n = (id: string, type: string, name: string, x: number, y: number, params: P = {}, settings?: WorkflowNode['settings']): WorkflowNode => ({ id, type, name, position: { x, y }, params, settings });
const e = (s: string, sh: string, t: string, th = 'main'): WorkflowEdge => ({ id: `${s}:${sh}->${t}:${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th });

export interface ExampleInfo { id: string; title: string; description: string; requires: string[] }
interface Example extends ExampleInfo { build(ctx: { engine: Engine; demoLlm: () => string; webhookSecret: () => { id: string; value: string } }): { name: string; def: WorkflowDefinition; extra?: { name: string; def: WorkflowDefinition }[] } }

export const EXAMPLES: Example[] = [
  {
    id: 'basic-e2e', title: 'Основной сценарий: данные → IF → HTTP', requires: ['интернет (jsonplaceholder.typicode.com)'],
    description: 'Ручной запуск → преобразование полей → IF по сумме заказа → HTTP-запрос или другая ветка. Проверка всей цепочки: интерфейс → очередь → исполнитель → SQLite.',
    build: () => ({
      name: 'Пример: заказ → IF → HTTP',
      def: {
        nodes: [
          n('t', 'trigger.manual', 'Ручной запуск', 40, 140),
          n('s', 'core.set', 'Данные заказа', 280, 140, { mode: 'add', assignments: [
            { name: 'name', value: 'Куртка', type: 'string' }, { name: 'price', value: '1500', type: 'number' }, { name: 'qty', value: '3', type: 'number' },
            { name: 'total', value: '{{ $json.price * $json.qty }}', type: 'number' } ] }),
          n('i', 'core.if', 'Крупный заказ?', 520, 140, { combinator: 'and', conditions: [{ left: '{{ $json.total }}', op: 'gt', right: '3000' }] }),
          n('h', 'http.request', 'HTTP: отправить заказ', 780, 60, { method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', bodyType: 'json', body: '{"title":"{{ $json.name }}","body":"Сумма {{ $json.total }}","userId":1}', headers: [], query: [] }, { maxAttempts: 3, retryDelayMs: 1000 }),
          n('o', 'core.set', 'Обычный заказ', 780, 240, { mode: 'add', assignments: [{ name: 'note', value: 'Сумма небольшая — HTTP-запрос не нужен', type: 'string' }] }),
        ],
        edges: [e('t', 'main', 's'), e('s', 'main', 'i'), e('i', 'true', 'h'), e('i', 'false', 'o')],
      },
    }),
  },
  {
    id: 'clothing-pipeline', title: 'Бизнес: одежда → маркетолог → сценарист → редактор → подтверждение → Telegram',
    requires: ['подключение «Провайдер ИИ» (в примере создаётся демо-провайдер без ключа)', 'Telegram-бот и chat id — для последнего шага'],
    description: 'Три ИИ-агента готовят описание и сценарий короткого видео, вы подтверждаете результат, затем текст уходит в Telegram. Монтаж видео и публикация в TikTok НЕ подключены — сценарий прямо сообщает об этом.',
    build: ({ demoLlm }) => {
      const cred = demoLlm();
      return {
        name: 'Одежда → ИИ-агенты → подтверждение → Telegram',
        def: {
          nodes: [
            n('t', 'trigger.manual', 'Ручной запуск', 40, 200),
            n('d', 'core.set', 'Данные об одежде', 260, 200, { mode: 'add', assignments: [
              { name: 'product', value: 'Женская весенняя куртка, водоотталкивающая, размеры S–XL', type: 'string' },
              { name: 'price', value: '750 TRY (оптовая 520 TRY)', type: 'string' },
              { name: 'audience', value: 'Женщины 20–40 из СНГ, покупают онлайн', type: 'string' },
              { name: 'chatId', value: 'ВСТАВЬТЕ_CHAT_ID', type: 'string' } ] }),
            n('a1', 'ai.agent', 'Агент-маркетолог', 500, 200, { credential: cred, system: 'Ты маркетолог интернет-магазина турецкой одежды. Выдели 3 главных преимущества товара и УТП для целевой аудитории. Пиши кратко.', prompt: 'Товар: {{ $json.product }}\nЦена: {{ $json.price }}\nАудитория: {{ $json.audience }}', tools: [], outputFormat: 'text', maxSteps: 3, maxToolCalls: 0, maxTotalTokens: 8000, temperature: 0.7, outputKey: 'marketing' }),
            n('a2', 'ai.agent', 'Агент-сценарист', 740, 200, { credential: cred, system: 'Ты сценарист коротких вертикальных видео (15–30 секунд). Напиши сценарий по кадрам: хук, показ товара, призыв к действию.', prompt: 'Материал маркетолога:\n{{ $json.marketing }}\n\nТовар: {{ $json.product }}', tools: [], outputFormat: 'text', maxSteps: 3, maxToolCalls: 0, maxTotalTokens: 8000, temperature: 0.8, outputKey: 'script' }),
            n('a3', 'ai.agent', 'Агент-редактор', 980, 200, { credential: cred, system: 'Ты редактор. Проверь сценарий на ясность, убери воду, исправь ошибки. Верни финальную версию.', prompt: 'Сценарий:\n{{ $json.script }}', tools: [], outputFormat: 'text', maxSteps: 3, maxToolCalls: 0, maxTotalTokens: 8000, temperature: 0.3, outputKey: 'final' }),
            n('ap', 'core.approval', 'Подтверждение пользователя', 1220, 200, { message: 'Проверьте финальный сценарий видео (поле final) и решите: отправить в Telegram или отклонить.', timeoutHours: 0, onTimeout: 'rejected' }),
            n('tg', 'telegram.send', 'Telegram: отправить результат', 1480, 120, { credential: '', chatId: '{{ $json.chatId }}', mode: 'text', text: 'Сценарий видео:\n\n{{ $json.final }}' }),
            n('tk', 'core.set', 'TikTok: НЕ подключено', 1720, 120, { mode: 'add', assignments: [
              { name: 'tiktok_status', value: 'not_connected', type: 'string' },
              { name: 'tiktok_note', value: 'Монтаж видео и публикация в TikTok не подключены. Видео не создавалось и не публиковалось.', type: 'string' } ] }),
            n('rj', 'core.set', 'Отклонено', 1480, 320, { mode: 'add', assignments: [{ name: 'outcome', value: 'Отклонено пользователем: {{ $json.decisionComment }}', type: 'string' }] }),
          ],
          edges: [e('t', 'main', 'd'), e('d', 'main', 'a1'), e('a1', 'main', 'a2'), e('a2', 'main', 'a3'), e('a3', 'main', 'ap'), e('ap', 'approved', 'tg'), e('tg', 'main', 'tk'), e('ap', 'rejected', 'rj')],
        },
      };
    },
  },
  {
    id: 'telegram-echo', title: 'Telegram: ответить на сообщение', requires: ['Telegram-бот (токен от @BotFather)'],
    description: 'Включите сценарий — бот получает сообщения через long polling и отвечает. Публичный сервер не нужен.',
    build: () => ({
      name: 'Telegram: эхо-бот',
      def: {
        nodes: [
          n('t', 'trigger.telegram', 'Telegram: сообщение', 40, 120, { credential: '', allowedChatIds: '' }),
          n('s', 'core.set', 'Ответ', 300, 120, { mode: 'add', assignments: [{ name: 'reply', value: 'Вы написали: {{ $json.text }}', type: 'string' }] }),
          n('m', 'telegram.send', 'Telegram: отправить', 560, 120, { credential: '', chatId: '{{ $json.chatId }}', mode: 'text', text: '{{ $json.reply }}' }),
        ],
        edges: [e('t', 'main', 's'), e('s', 'main', 'm')],
      },
    }),
  },
  {
    id: 'webhook-intake', title: 'Webhook: принять заказ', requires: [],
    description: 'Принимает POST на локальный адрес (только этот компьютер) с секретом в заголовке X-Webhook-Secret.',
    build: ({ webhookSecret }) => {
      const sec = webhookSecret();
      return {
        name: 'Webhook: приём заказа',
        def: {
          nodes: [
            n('t', 'trigger.webhook', 'Webhook', 40, 120, { path: crypto.randomBytes(12).toString('hex'), method: 'POST', secret: sec.id }),
            n('s', 'core.set', 'Разобрать заказ', 300, 120, { mode: 'add', assignments: [{ name: 'customer', value: '{{ $json.body.customer ?? "неизвестно" }}', type: 'string' }, { name: 'received', value: '{{ $now }}', type: 'string' }] }),
            n('r', 'core.result', 'Результат', 560, 120),
          ],
          edges: [e('t', 'main', 's'), e('s', 'main', 'r')],
        },
      };
    },
  },
  {
    id: 'schedule-http', title: 'Расписание: проверка сайта каждый час', requires: ['интернет'],
    description: 'Каждый час (часовой пояс Стамбула) проверяет доступность сайта. Если компьютер спал — пропущенный запуск пропускается (настраивается).',
    build: () => ({
      name: 'Расписание: проверка сайта',
      def: {
        nodes: [
          n('t', 'trigger.schedule', 'Расписание', 40, 120, { mode: 'interval', everyMinutes: 60, timezone: 'Europe/Istanbul', missedPolicy: 'skip' }),
          n('h', 'http.request', 'HTTP: проверить сайт', 300, 120, { method: 'GET', url: 'https://example.com', bodyType: 'none', headers: [], query: [], neverError: true }),
          n('i', 'core.if', 'Сайт доступен?', 560, 120, { combinator: 'and', conditions: [{ left: '{{ $json.status }}', op: 'equals', right: '200' }] }),
          n('ok', 'core.set', 'OK', 820, 60, { mode: 'add', assignments: [{ name: 'state', value: 'доступен', type: 'string' }] }),
          n('bad', 'core.set', 'Проблема', 820, 200, { mode: 'add', assignments: [{ name: 'state', value: 'недоступен', type: 'string' }] }),
        ],
        edges: [e('t', 'main', 'h'), e('h', 'main', 'i'), e('i', 'true', 'ok'), e('i', 'false', 'bad')],
      },
    }),
  },
];

export function listExamples(): ExampleInfo[] { return EXAMPLES.map(({ id, title, description, requires }) => ({ id, title, description, requires })); }

export function installExample(engine: Engine, id: string) {
  const ex = EXAMPLES.find((x) => x.id === id);
  if (!ex) throw new Error('Пример не найден');
  const created: { secrets: { name: string; value: string }[]; notes: string[] } = { secrets: [], notes: [] };
  const built = ex.build({
    engine,
    demoLlm: () => {
      const existing = engine.store.listCredentials().find((c) => c.type === 'llmProvider' && c.fields.provider === 'demo');
      if (existing) return existing.id;
      created.notes.push('Создано подключение «Демо-ИИ (без ключа)». Это не настоящая модель — замените его своим провайдером в узлах-агентах.');
      return engine.saveCredential(null, 'Демо-ИИ (без ключа)', 'llmProvider', { provider: 'demo', defaultModel: 'demo' });
    },
    webhookSecret: () => {
      const value = crypto.randomBytes(18).toString('hex');
      const cid = engine.saveCredential(null, `Секрет webhook (${new Date().toISOString().slice(0, 16)})`, 'webhookSecret', { secret: value });
      created.secrets.push({ name: 'Секрет webhook', value });
      return { id: cid, value };
    },
  });
  const wf = engine.createWorkflow(built.name, built.def);
  if (JSON.stringify(built.def).includes('"credential":""')) created.notes.push('Выберите подключение Telegram в узлах Telegram и укажите chat id.');
  return { workflow: wf, ...created };
}
