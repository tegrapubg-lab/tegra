import type { Item } from '../../shared/types';
import { BUILTIN_TOOLS, SPEC_BY_TYPE } from '../../shared/specs';
import { evalExpression } from '../expr';
import type { ChatMessage, LlmAdapter, ToolCall, ToolDef } from '../llm';
import { guardedFetch } from '../netguard';
import type { CredentialData, NodeExecContext, NodeImpl } from './types';

function adapterFor(ctx: NodeExecContext): { adapter: LlmAdapter; model: string; cred: CredentialData } {
  const cred = ctx.svc.getCredential(ctx.str('credential'));
  if (cred.type !== 'llmProvider') throw new Error('Выбранное подключение не является провайдером ИИ');
  const adapter = ctx.svc.llm.create({ provider: cred.data.provider || 'openai', baseUrl: cred.data.baseUrl, apiKey: cred.data.apiKey, defaultModel: cred.data.defaultModel });
  const model = ctx.str('model') || cred.data.defaultModel || (cred.data.provider === 'demo' ? 'demo' : '');
  if (!model) throw new Error('Не указана модель: заполните поле «Модель» узла или «Модель по умолчанию» в подключении');
  return { adapter, model, cred };
}

export const llmNode: NodeImpl = {
  spec: SPEC_BY_TYPE['ai.llm'],
  async execute(ctx) {
    const { adapter, model } = adapterFor(ctx);
    const outKey = ctx.str('outputKey') || 'text';
    const out: Item[] = [];
    let tokens = 0;
    for (let i = 0; i < ctx.items.length; i++) {
      const messages: ChatMessage[] = [];
      const system = ctx.str('system', i);
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: ctx.str('prompt', i) });
      const r = await adapter.chat({ model, messages, temperature: ctx.num('temperature', i, 0.7), maxTokens: ctx.num('maxTokens', i, 1024), signal: ctx.signal });
      tokens += r.usage.inputTokens + r.usage.outputTokens;
      out.push({ json: { ...ctx.items[i].json, [outKey]: r.content, ai: { model: r.model, usage: r.usage } } });
    }
    return { outputs: { main: out }, summary: `Ответов модели: ${out.length}, токенов: ${tokens}` };
  },
};

// ---------- Агент ----------

interface TraceEntry { step: number; type: 'model' | 'tool'; tool?: string; arguments?: unknown; result?: string; error?: string; content?: string; tokens?: number }

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… [обрезано, всего ${s.length} симв.]` : s);

function toolDefs(ids: string[], svc: NodeExecContext['svc']): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const id of ids) {
    if (id === 'current_time') defs.push({ name: 'current_time', description: 'Текущая дата и время в формате ISO.', parameters: { type: 'object', properties: {} } });
    else if (id === 'calculator') defs.push({ name: 'calculator', description: 'Вычисляет арифметическое выражение, например (2+3)*4.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } });
    else if (id === 'http_get') defs.push({ name: 'http_get', description: 'Скачивает публичную страницу или JSON по URL (только публичные адреса).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } });
    else if (id.startsWith('workflow:')) {
      const name = svc.workflowName(id.slice(9));
      if (name) defs.push({ name: 'workflow_' + id.slice(9).replace(/[^\w]/g, '_'), description: `Запускает сценарий «${name}». Передайте входные данные объектом input.`, parameters: { type: 'object', properties: { input: { type: 'object' } } } });
    }
  }
  return defs;
}

async function runTool(call: ToolCall, ids: string[], ctx: NodeExecContext): Promise<string> {
  const args = call.arguments ?? {};
  if (call.name === 'current_time' && ids.includes('current_time')) return new Date(ctx.svc.now()).toISOString();
  if (call.name === 'calculator' && ids.includes('calculator')) {
    const v = evalExpression(String(args.expression ?? ''), { json: {}, index: 0, node: () => undefined, runId: '', now: new Date() });
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Выражение не дало числа');
    return String(v);
  }
  if (call.name === 'http_get' && ids.includes('http_get')) {
    const res = await guardedFetch({ url: String(args.url ?? ''), method: 'GET', allowPrivate: false, maxBytes: 300 * 1024, signal: ctx.signal });
    return `HTTP ${res.status}\n` + cut(res.body.toString('utf8'), 6000);
  }
  if (call.name.startsWith('workflow_')) {
    const id = ids.find((x) => x.startsWith('workflow:') && 'workflow_' + x.slice(9).replace(/[^\w]/g, '_') === call.name);
    if (id) {
      const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
      const r = await ctx.svc.runInline(id.slice(9), [{ json: input }], ctx.signal, ctx.runDepth + 1);
      if (r.status !== 'succeeded') throw new Error(`Сценарий завершился со статусом «${r.status}»${r.error ? ': ' + r.error : ''}`);
      return cut(JSON.stringify(r.items.map((x) => x.json)), 6000);
    }
  }
  throw new Error(`Инструмент «${call.name}» не разрешён для этого агента`);
}

function parseJsonLoose(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

export const agentNode: NodeImpl = {
  spec: SPEC_BY_TYPE['ai.agent'],
  async execute(ctx) {
    const { adapter, model } = adapterFor(ctx);
    const toolIds = (ctx.raw('tools') as string[] | undefined) ?? [];
    for (const id of toolIds) if (!BUILTIN_TOOLS.some((t) => t.id === id) && !id.startsWith('workflow:')) throw new Error(`Неизвестный инструмент «${id}»`);
    const defs = toolDefs(toolIds, ctx.svc);
    const maxSteps = Math.min(Math.max(ctx.num('maxSteps', 0, 6), 1), 30);
    const maxToolCalls = ctx.num('maxToolCalls', 0, 10);
    const maxTokens = ctx.num('maxTotalTokens', 0, 20000);
    const json = ctx.str('outputFormat') === 'json';
    const outKey = ctx.str('outputKey') || 'text';
    const out: Item[] = [];
    let totalTokens = 0; let toolCalls = 0; let totalSteps = 0;

    for (let idx = 0; idx < ctx.items.length; idx++) {
      const trace: TraceEntry[] = [];
      const messages: ChatMessage[] = [
        { role: 'system', content: ctx.str('system', idx) + (json ? '\n\nОтвечай только одним корректным JSON-объектом без пояснений.' : '') },
        { role: 'user', content: ctx.str('prompt', idx) },
      ];
      let final = ''; let repaired = false;
      for (let step = 1; ; step++) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Отменено');
        if (step > maxSteps) throw new Error(`Агент не уложился в ${maxSteps} шагов`);
        const last = step === maxSteps;
        const r = await adapter.chat({ model, messages, tools: last || !defs.length ? undefined : defs, temperature: ctx.num('temperature', idx, 0.5), json, signal: ctx.signal, maxTokens: 2048 });
        totalSteps++;
        const used = r.usage.inputTokens + r.usage.outputTokens;
        totalTokens += used;
        trace.push({ step, type: 'model', content: cut(r.content, 1500), tokens: used });
        ctx.log(`Шаг ${step}: ответ модели, токенов ${used}${r.toolCalls.length ? `, запрошено инструментов: ${r.toolCalls.length}` : ''}`);
        if (totalTokens > maxTokens) throw new Error(`Лимит токенов агента исчерпан (${totalTokens} > ${maxTokens})`);
        if (r.toolCalls.length === 0) {
          final = r.content;
          if (json) {
            try { parseJsonLoose(final); } catch {
              if (repaired) throw new Error('Агент вернул некорректный JSON');
              repaired = true;
              messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: 'Это не корректный JSON. Верни только JSON-объект.' });
              continue;
            }
          }
          break;
        }
        messages.push({ role: 'assistant', content: r.content, toolCalls: r.toolCalls });
        for (const call of r.toolCalls) {
          let result: string; let error: string | undefined;
          if (toolCalls >= maxToolCalls) { error = 'Лимит вызовов инструментов исчерпан'; result = error; }
          else {
            toolCalls++;
            try { result = await runTool(call, toolIds, ctx); } catch (e) { error = (e as Error).message; result = 'Ошибка: ' + error; }
          }
          trace.push({ step, type: 'tool', tool: call.name, arguments: call.arguments, result: cut(result, 2000), error });
          ctx.log(`Шаг ${step}: инструмент ${call.name}(${cut(JSON.stringify(call.arguments ?? {}), 200)}) → ${error ? 'ОШИБКА: ' + error : cut(result, 200)}`);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        }
      }
      const item: Record<string, unknown> = { ...ctx.items[idx].json, [outKey]: final, agent: { model, steps: trace.filter((t) => t.type === 'model').length, toolCalls: trace.filter((t) => t.type === 'tool').length, tokens: totalTokens, trace } };
      if (json) item.result = parseJsonLoose(final);
      out.push({ json: item });
    }
    return { outputs: { main: out }, summary: `Агент: шагов ${totalSteps}, вызовов инструментов ${toolCalls}, токенов ${totalTokens}` };
  },
};
