// Подключаемые адаптеры языковых моделей. Ключи берутся из подключений (расшифровываются в движке).
import { guardedFetch } from './netguard';

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatRequest {
  model: string; messages: ChatMessage[]; tools?: ToolDef[]; temperature?: number; maxTokens?: number; json?: boolean; signal?: AbortSignal;
}
export interface ChatResult { content: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number }; model: string }
export interface LlmAdapter { chat(req: ChatRequest): Promise<ChatResult> }
export interface LlmConfig { provider: string; baseUrl?: string; apiKey?: string; defaultModel?: string }
export type AdapterFactory = (cfg: LlmConfig) => LlmAdapter;

const MAX_RESPONSE = 4 * 1024 * 1024;

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  // Адрес провайдера задан пользователем явно в подключении, поэтому локальные адреса (Ollama, LM Studio) разрешены.
  const res = await guardedFetch({ url, method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), allowPrivate: true, maxBytes: MAX_RESPONSE, signal });
  const text = res.body.toString('utf8');
  if (res.status >= 400) {
    let msg = text.slice(0, 400);
    try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? msg; } catch { /* текст как есть */ }
    throw new Error(`Провайдер ИИ вернул ${res.status}: ${msg}`);
  }
  try { return JSON.parse(text); } catch { throw new Error('Провайдер ИИ вернул не-JSON ответ'); }
}

export const openaiAdapter: AdapterFactory = (cfg) => ({
  async chat(req) {
    const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const messages = req.messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) };
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = { model: req.model, messages, temperature: req.temperature, max_tokens: req.maxTokens };
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.json) body.response_format = { type: 'json_object' };
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const j = await postJson(`${base}/chat/completions`, headers, body, req.signal);
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error('Провайдер ИИ вернул пустой ответ');
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(t.function?.arguments || '{}'); } catch { /* пустые аргументы */ }
      return { id: String(t.id), name: String(t.function?.name), arguments: args };
    });
    return { content: msg.content ?? '', toolCalls, usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 }, model: j.model ?? req.model };
  },
});

export const anthropicAdapter: AdapterFactory = (cfg) => ({
  async chat(req) {
    const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const msgs: unknown[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant') {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const t of m.toolCalls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments });
        msgs.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        const last = msgs[msgs.length - 1] as { role: string; content: unknown[] } | undefined;
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block); else msgs.push({ role: 'user', content: [block] });
      } else msgs.push({ role: 'user', content: m.content });
    }
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages: msgs, temperature: req.temperature };
    if (system) body.system = system;
    if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const j = await postJson(`${base}/v1/messages`, { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' }, body, req.signal);
    const blocks: any[] = j.content ?? [];
    return {
      content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), arguments: b.input ?? {} })),
      usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
      model: j.model ?? req.model,
    };
  },
});

/** Демо-провайдер: детерминированный шаблонный ответ без сети. Это НЕ настоящая модель. */
export const demoAdapter: AdapterFactory = () => ({
  async chat(req) {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const role = sys.split('\n')[0].slice(0, 80);
    const text = `[ДЕМО-ОТВЕТ, без настоящей модели] Роль: ${role || 'не задана'}. Вход: ${user.replace(/\s+/g, ' ').slice(0, 300)}`;
    const content = req.json ? JSON.stringify({ demo: true, role, input: user.slice(0, 300) }) : text;
    return { content, toolCalls: [], usage: { inputTokens: Math.ceil((sys.length + user.length) / 4), outputTokens: Math.ceil(content.length / 4) }, model: 'demo' };
  },
});

export class LlmRegistry {
  private factories = new Map<string, AdapterFactory>([['openai', openaiAdapter], ['anthropic', anthropicAdapter], ['demo', demoAdapter]]);
  register(provider: string, f: AdapterFactory) { this.factories.set(provider, f); }
  create(cfg: LlmConfig): LlmAdapter {
    const f = this.factories.get(cfg.provider);
    if (!f) throw new Error(`Неизвестный тип провайдера ИИ «${cfg.provider}»`);
    return f(cfg);
  }
}
