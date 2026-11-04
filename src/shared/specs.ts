// Спецификации узлов: единый источник для UI-форм, валидации и реестра движка.

export type FieldKind =
  | 'string' | 'text' | 'number' | 'boolean' | 'select' | 'json'
  | 'credential' | 'list' | 'tools' | 'workflow';

export interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  credentialType?: string;
  itemFields?: FieldSpec[];
  maxItems?: number;
  /** Показывать поле, только если другое поле равно значению(ям). */
  showIf?: { field: string; equals: unknown | unknown[] };
  min?: number;
  max?: number;
}

export type NodeCategory = 'trigger' | 'logic' | 'data' | 'flow' | 'integration' | 'ai';

export interface NodeSpec {
  type: string;
  label: string;
  category: NodeCategory;
  description: string;
  icon: string;
  inputs: string[];
  outputs: { id: string; label: string }[];
  params: FieldSpec[];
  isTrigger?: boolean;
}

const MAIN_IN = ['main'];
const MAIN_OUT = [{ id: 'main', label: 'Результат' }];

const opOptions = [
  { value: 'equals', label: 'равно' },
  { value: 'notEquals', label: 'не равно' },
  { value: 'contains', label: 'содержит' },
  { value: 'notContains', label: 'не содержит' },
  { value: 'startsWith', label: 'начинается с' },
  { value: 'endsWith', label: 'заканчивается на' },
  { value: 'gt', label: 'больше' },
  { value: 'gte', label: 'больше или равно' },
  { value: 'lt', label: 'меньше' },
  { value: 'lte', label: 'меньше или равно' },
  { value: 'exists', label: 'существует' },
  { value: 'notExists', label: 'не существует' },
  { value: 'isTrue', label: 'истина' },
  { value: 'isFalse', label: 'ложь' },
];

const conditionFields: FieldSpec[] = [
  { name: 'left', label: 'Значение', kind: 'string', placeholder: '{{ $json.price }}' },
  { name: 'op', label: 'Условие', kind: 'select', options: opOptions, default: 'equals' },
  { name: 'right', label: 'Сравнить с', kind: 'string' },
];

export const BUILTIN_TOOLS: { id: string; label: string; description: string }[] = [
  { id: 'current_time', label: 'Текущее время', description: 'Возвращает текущую дату и время (ISO).' },
  { id: 'calculator', label: 'Калькулятор', description: 'Считает арифметическое выражение (+ - * / % и скобки).' },
  { id: 'http_get', label: 'HTTP GET', description: 'Скачивает публичный URL (локальные адреса запрещены).' },
];

export const NODE_SPECS: NodeSpec[] = [
  {
    type: 'trigger.manual', label: 'Ручной запуск', category: 'trigger', icon: '▶',
    description: 'Запускает сценарий кнопкой. Можно передать входные данные JSON.',
    inputs: [], outputs: MAIN_OUT, isTrigger: true, params: [],
  },
  {
    type: 'trigger.webhook', label: 'Webhook', category: 'trigger', icon: '🔗', isTrigger: true,
    description: 'Запуск по HTTP-запросу на локальный адрес. Секрет обязателен.',
    inputs: [], outputs: MAIN_OUT,
    params: [
      { name: 'path', label: 'Идентификатор адреса', kind: 'string', required: true, help: 'Генерируется автоматически. Уникален для узла.' },
      { name: 'method', label: 'Метод', kind: 'select', default: 'POST', options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }, { value: 'ANY', label: 'Любой' }] },
      { name: 'secret', label: 'Секрет', kind: 'credential', credentialType: 'webhookSecret', required: true, help: 'Передаётся заголовком X-Webhook-Secret.' },
    ],
  },
  {
    type: 'trigger.schedule', label: 'Расписание', category: 'trigger', icon: '⏰', isTrigger: true,
    description: 'Запуск по интервалу или cron-выражению с учётом часового пояса.',
    inputs: [], outputs: MAIN_OUT,
    params: [
      { name: 'mode', label: 'Тип', kind: 'select', default: 'interval', options: [{ value: 'interval', label: 'Каждые N минут' }, { value: 'cron', label: 'Cron (5 полей)' }] },
      { name: 'everyMinutes', label: 'Интервал, минут', kind: 'number', default: 60, min: 1, max: 525600, showIf: { field: 'mode', equals: 'interval' } },
      { name: 'cron', label: 'Cron', kind: 'string', placeholder: '0 9 * * 1-5', help: 'минута час день месяц день_недели', showIf: { field: 'mode', equals: 'cron' } },
      { name: 'timezone', label: 'Часовой пояс', kind: 'string', default: 'Europe/Istanbul', placeholder: 'Europe/Istanbul' },
      { name: 'missedPolicy', label: 'Пропущенные запуски (сон, выключение)', kind: 'select', default: 'skip', options: [{ value: 'skip', label: 'Пропустить' }, { value: 'runOnce', label: 'Выполнить один раз после возобновления' }] },
    ],
  },
  {
    type: 'trigger.telegram', label: 'Telegram: сообщение', category: 'trigger', icon: '✈', isTrigger: true,
    description: 'Получает сообщения бота через long polling (публичный сервер не нужен).',
    inputs: [], outputs: MAIN_OUT,
    params: [
      { name: 'credential', label: 'Бот Telegram', kind: 'credential', credentialType: 'telegramBot', required: true },
      { name: 'allowedChatIds', label: 'Разрешённые chat id', kind: 'string', placeholder: '123456, -100987', help: 'Пусто — принимать от всех, кто пишет боту.' },
    ],
  },
  {
    type: 'core.set', label: 'Поля (создать/изменить)', category: 'data', icon: '✎',
    description: 'Создаёт или преобразует поля. Значения поддерживают выражения {{ }}.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'mode', label: 'Режим', kind: 'select', default: 'add', options: [{ value: 'add', label: 'Добавить к существующим' }, { value: 'only', label: 'Оставить только эти поля' }] },
      {
        name: 'assignments', label: 'Поля', kind: 'list', maxItems: 100,
        itemFields: [
          { name: 'name', label: 'Имя', kind: 'string', required: true },
          { name: 'value', label: 'Значение', kind: 'string' },
          { name: 'type', label: 'Тип', kind: 'select', default: 'auto', options: [{ value: 'auto', label: 'авто' }, { value: 'string', label: 'строка' }, { value: 'number', label: 'число' }, { value: 'boolean', label: 'логическое' }, { value: 'json', label: 'JSON' }] },
        ],
      },
    ],
  },
  {
    type: 'core.if', label: 'IF (условие)', category: 'logic', icon: '⑂',
    description: 'Направляет каждый элемент в ветку «Да» или «Нет».',
    inputs: MAIN_IN, outputs: [{ id: 'true', label: 'Да' }, { id: 'false', label: 'Нет' }],
    params: [
      { name: 'combinator', label: 'Объединение условий', kind: 'select', default: 'and', options: [{ value: 'and', label: 'И' }, { value: 'or', label: 'ИЛИ' }] },
      { name: 'conditions', label: 'Условия', kind: 'list', required: true, maxItems: 20, itemFields: conditionFields },
    ],
  },
  {
    type: 'core.switch', label: 'Switch (выбор ветки)', category: 'logic', icon: '⇶',
    description: 'До 4 правил; элемент уходит в первую подошедшую ветку, иначе в «Другое».',
    inputs: MAIN_IN,
    outputs: [{ id: 'case1', label: '1' }, { id: 'case2', label: '2' }, { id: 'case3', label: '3' }, { id: 'case4', label: '4' }, { id: 'other', label: 'Другое' }],
    params: [
      { name: 'value', label: 'Проверяемое значение', kind: 'string', required: true, placeholder: '{{ $json.category }}' },
      {
        name: 'rules', label: 'Правила (по порядку, ветки 1–4)', kind: 'list', required: true, maxItems: 4,
        itemFields: [
          { name: 'op', label: 'Условие', kind: 'select', options: opOptions, default: 'equals' },
          { name: 'right', label: 'Сравнить с', kind: 'string' },
        ],
      },
    ],
  },
  {
    type: 'core.splitOut', label: 'Разделить список', category: 'data', icon: '⋮',
    description: 'Превращает массив из поля в отдельные элементы.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'field', label: 'Поле с массивом', kind: 'string', required: true, placeholder: 'items' },
      { name: 'keepParent', label: 'Сохранить остальные поля в «parent»', kind: 'boolean', default: false },
    ],
  },
  {
    type: 'core.merge', label: 'Объединение веток', category: 'flow', icon: '⨝',
    description: 'Явно объединяет две ветки: добавлением или попарно.',
    inputs: ['a', 'b'], outputs: MAIN_OUT,
    params: [
      { name: 'mode', label: 'Режим', kind: 'select', default: 'append', options: [{ value: 'append', label: 'Добавить (A, затем B)' }, { value: 'zip', label: 'Попарно (поля A + поля B)' }] },
      { name: 'requireBoth', label: 'Требовать данные из обеих веток', kind: 'boolean', default: false, help: 'Если одна ветка пуста/пропущена — узел пропускается.' },
    ],
  },
  {
    type: 'core.repeat', label: 'Повторить N раз', category: 'flow', icon: '↻',
    description: 'Генерирует N элементов {index}. Безопасная замена циклам (циклы в графе запрещены).',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [{ name: 'count', label: 'Количество', kind: 'number', required: true, default: 3, min: 1, max: 1000 }],
  },
  {
    type: 'core.wait', label: 'Ожидание', category: 'flow', icon: '⏳',
    description: 'Приостанавливает запуск; состояние сохраняется в базе, процесс не занят.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'mode', label: 'Режим', kind: 'select', default: 'duration', options: [{ value: 'duration', label: 'Подождать' }, { value: 'until', label: 'До даты и времени' }] },
      { name: 'amount', label: 'Сколько', kind: 'number', default: 10, min: 0, showIf: { field: 'mode', equals: 'duration' } },
      { name: 'unit', label: 'Единица', kind: 'select', default: 'seconds', options: [{ value: 'seconds', label: 'секунд' }, { value: 'minutes', label: 'минут' }, { value: 'hours', label: 'часов' }, { value: 'days', label: 'дней' }], showIf: { field: 'mode', equals: 'duration' } },
      { name: 'until', label: 'Дата и время (ISO)', kind: 'string', placeholder: '2026-12-01T09:00:00+03:00', showIf: { field: 'mode', equals: 'until' } },
    ],
  },
  {
    type: 'core.subworkflow', label: 'Вложенный сценарий', category: 'flow', icon: '⧉',
    description: 'Запускает другой сценарий; входные элементы передаются в его стартовый узел.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [{ name: 'workflowId', label: 'Сценарий', kind: 'workflow', required: true }],
  },
  {
    type: 'core.result', label: 'Результат сценария', category: 'flow', icon: '⚑',
    description: 'Отмечает данные, которые сценарий возвращает вызывающему (вложенный сценарий, агент).',
    inputs: MAIN_IN, outputs: MAIN_OUT, params: [],
  },
  {
    type: 'core.approval', label: 'Ждать решения пользователя', category: 'flow', icon: '✋',
    description: 'Останавливает запуск до нажатия «Продолжить» или «Отклонить» в разделе «Подтверждения».',
    inputs: MAIN_IN, outputs: [{ id: 'approved', label: 'Продолжить' }, { id: 'rejected', label: 'Отклонить' }],
    params: [
      { name: 'message', label: 'Сообщение пользователю', kind: 'text', required: true, default: 'Проверьте результат и подтвердите.' },
      { name: 'timeoutHours', label: 'Тайм-аут решения, часов (0 — без)', kind: 'number', default: 0, min: 0, max: 8760 },
      { name: 'onTimeout', label: 'При тайм-ауте', kind: 'select', default: 'rejected', options: [{ value: 'rejected', label: 'Отклонить' }, { value: 'approved', label: 'Продолжить' }] },
    ],
  },
  {
    type: 'http.request', label: 'HTTP-запрос', category: 'integration', icon: '🌐',
    description: 'Выполняет HTTP-запрос для каждого элемента. Локальные адреса запрещены, пока не включено явно.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'method', label: 'Метод', kind: 'select', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ value: m, label: m })) },
      { name: 'url', label: 'URL', kind: 'string', required: true, placeholder: 'https://api.example.com/items/{{ $json.id }}' },
      { name: 'headers', label: 'Заголовки', kind: 'list', maxItems: 50, itemFields: [{ name: 'key', label: 'Имя', kind: 'string' }, { name: 'value', label: 'Значение', kind: 'string' }] },
      { name: 'query', label: 'Параметры запроса', kind: 'list', maxItems: 50, itemFields: [{ name: 'key', label: 'Имя', kind: 'string' }, { name: 'value', label: 'Значение', kind: 'string' }] },
      { name: 'bodyType', label: 'Тело', kind: 'select', default: 'none', options: [{ value: 'none', label: 'Нет' }, { value: 'json', label: 'JSON' }, { value: 'text', label: 'Текст' }, { value: 'form', label: 'Форма (urlencoded)' }] },
      { name: 'body', label: 'Содержимое тела', kind: 'text', showIf: { field: 'bodyType', equals: ['json', 'text', 'form'] }, help: 'Для формы: key=value&key2=value2. Поддерживает {{ }}.' },
      { name: 'auth', label: 'Авторизация', kind: 'credential', credentialType: 'httpAuth' },
      { name: 'idempotency', label: 'Стабильный Idempotency-Key для повторов', kind: 'boolean', default: false },
      { name: 'neverError', label: 'Не считать HTTP 4xx/5xx ошибкой', kind: 'boolean', default: false },
      { name: 'followRedirects', label: 'Следовать перенаправлениям (до 5, с проверкой)', kind: 'boolean', default: true },
      { name: 'allowPrivate', label: 'Разрешить локальные и приватные адреса', kind: 'boolean', default: false, help: 'Явное решение пользователя. По умолчанию доступ запрещён (защита от SSRF).' },
      { name: 'maxResponseKb', label: 'Макс. размер ответа, КБ', kind: 'number', default: 5120, min: 1, max: 25600 },
    ],
  },
  {
    type: 'telegram.send', label: 'Telegram: отправить', category: 'integration', icon: '📨',
    description: 'Отправляет текст или файл в чат Telegram.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'credential', label: 'Бот Telegram', kind: 'credential', credentialType: 'telegramBot', required: true },
      { name: 'chatId', label: 'Chat ID', kind: 'string', required: true, placeholder: '{{ $json.chatId }}' },
      { name: 'mode', label: 'Что отправить', kind: 'select', default: 'text', options: [{ value: 'text', label: 'Текст' }, { value: 'documentUrl', label: 'Файл по URL' }, { value: 'documentText', label: 'Текст как файл' }] },
      { name: 'text', label: 'Текст / подпись', kind: 'text', showIf: { field: 'mode', equals: ['text', 'documentUrl', 'documentText'] } },
      { name: 'fileUrl', label: 'URL файла', kind: 'string', showIf: { field: 'mode', equals: 'documentUrl' } },
      { name: 'fileName', label: 'Имя файла', kind: 'string', default: 'result.txt', showIf: { field: 'mode', equals: 'documentText' } },
      { name: 'fileContent', label: 'Содержимое файла', kind: 'text', showIf: { field: 'mode', equals: 'documentText' } },
    ],
  },
  {
    type: 'ai.llm', label: 'Языковая модель', category: 'ai', icon: '✦',
    description: 'Один вызов языковой модели через подключаемый адаптер.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'credential', label: 'Провайдер ИИ', kind: 'credential', credentialType: 'llmProvider', required: true },
      { name: 'model', label: 'Модель', kind: 'string', placeholder: 'пусто — модель из подключения' },
      { name: 'system', label: 'Системная инструкция', kind: 'text' },
      { name: 'prompt', label: 'Запрос', kind: 'text', required: true, placeholder: 'Опиши товар: {{ $json.name }}' },
      { name: 'temperature', label: 'Температура', kind: 'number', default: 0.7, min: 0, max: 2 },
      { name: 'maxTokens', label: 'Макс. токенов ответа', kind: 'number', default: 1024, min: 1, max: 32000 },
      { name: 'outputKey', label: 'Поле результата', kind: 'string', default: 'text' },
    ],
  },
  {
    type: 'ai.agent', label: 'ИИ-агент', category: 'ai', icon: '🤖',
    description: 'Агент с ограниченным набором инструментов, лимитом шагов, времени и расхода токенов.',
    inputs: MAIN_IN, outputs: MAIN_OUT,
    params: [
      { name: 'credential', label: 'Провайдер ИИ', kind: 'credential', credentialType: 'llmProvider', required: true },
      { name: 'model', label: 'Модель', kind: 'string', placeholder: 'пусто — модель из подключения' },
      { name: 'system', label: 'Системная инструкция', kind: 'text', required: true },
      { name: 'prompt', label: 'Задача', kind: 'text', required: true, placeholder: '{{ $json.text }}' },
      { name: 'tools', label: 'Доступные инструменты', kind: 'tools', help: 'Агент не может вызвать ничего, что не отмечено.' },
      { name: 'outputFormat', label: 'Формат результата', kind: 'select', default: 'text', options: [{ value: 'text', label: 'Текст' }, { value: 'json', label: 'JSON-объект' }] },
      { name: 'maxSteps', label: 'Макс. шагов (вызовов модели)', kind: 'number', default: 6, min: 1, max: 30 },
      { name: 'maxToolCalls', label: 'Макс. вызовов инструментов', kind: 'number', default: 10, min: 0, max: 100 },
      { name: 'maxTotalTokens', label: 'Лимит токенов на запуск агента', kind: 'number', default: 20000, min: 100, max: 1000000 },
      { name: 'temperature', label: 'Температура', kind: 'number', default: 0.5, min: 0, max: 2 },
      { name: 'outputKey', label: 'Поле результата', kind: 'string', default: 'text' },
    ],
  },
];

export const SPEC_BY_TYPE: Record<string, NodeSpec> = Object.fromEntries(NODE_SPECS.map((s) => [s.type, s]));

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  trigger: 'Триггеры', logic: 'Логика', data: 'Данные', flow: 'Поток', integration: 'Интеграции', ai: 'ИИ',
};

// ---------- Типы подключений (секреты) ----------

export interface CredentialFieldSpec {
  name: string; label: string; secret?: boolean; required?: boolean;
  kind?: 'string' | 'select'; options?: { value: string; label: string }[]; placeholder?: string; default?: string;
}
export interface CredentialTypeSpec { type: string; label: string; fields: CredentialFieldSpec[] }

export const CREDENTIAL_TYPES: CredentialTypeSpec[] = [
  { type: 'webhookSecret', label: 'Секрет webhook', fields: [{ name: 'secret', label: 'Секрет', secret: true, required: true }] },
  { type: 'telegramBot', label: 'Telegram-бот', fields: [{ name: 'token', label: 'Токен бота (от @BotFather)', secret: true, required: true }, { name: 'apiBase', label: 'Адрес API (оставьте пустым)', placeholder: 'https://api.telegram.org' }] },
  {
    type: 'llmProvider', label: 'Провайдер ИИ',
    fields: [
      { name: 'provider', label: 'Тип', kind: 'select', required: true, default: 'openai', options: [{ value: 'openai', label: 'OpenAI-совместимый (OpenAI, OpenRouter, Ollama, LM Studio, Gemini-compat…)' }, { value: 'anthropic', label: 'Anthropic (Claude)' }, { value: 'demo', label: 'Демо (без ключа, не настоящая модель)' }] },
      { name: 'baseUrl', label: 'Базовый URL', placeholder: 'https://api.openai.com/v1' },
      { name: 'apiKey', label: 'API-ключ', secret: true },
      { name: 'defaultModel', label: 'Модель по умолчанию', placeholder: 'gpt-4o-mini' },
    ],
  },
  {
    type: 'httpAuth', label: 'Авторизация HTTP',
    fields: [
      { name: 'scheme', label: 'Схема', kind: 'select', required: true, default: 'bearer', options: [{ value: 'bearer', label: 'Bearer-токен' }, { value: 'basic', label: 'Basic (логин/пароль)' }, { value: 'header', label: 'Свой заголовок' }] },
      { name: 'headerName', label: 'Имя заголовка (для «Свой заголовок»)', placeholder: 'X-API-Key' },
      { name: 'token', label: 'Токен / значение', secret: true },
      { name: 'username', label: 'Логин (Basic)' },
      { name: 'password', label: 'Пароль (Basic)', secret: true },
    ],
  },
];
export const CRED_TYPE_BY_NAME: Record<string, CredentialTypeSpec> = Object.fromEntries(CREDENTIAL_TYPES.map((c) => [c.type, c]));
