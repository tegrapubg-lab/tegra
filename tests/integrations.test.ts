import { afterEach, describe, expect, it } from 'vitest';
import type { AdapterFactory } from '../src/engine/llm';
import { edge, makeEngine, mockServer, node, runToEnd, waitFor, wf } from './helpers';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const TG_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

async function telegramMock() {
  const queue: any[] = []; let nextId = 100;
  const s = await mockServer((req, body, res) => {
    const method = req.url!.split('/').pop();
    const j = body && String(req.headers['content-type']).includes('json') ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (!req.url!.includes(`/bot${TG_TOKEN}/`)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); return; }
    if (method === 'getUpdates') { const off = j.offset ?? 0; res.end(JSON.stringify({ ok: true, result: queue.filter((u) => u.update_id >= off) })); return; }
    res.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
  });
  closers.push(s.close);
  const push = (text: string, chatId = 555) => queue.push({ update_id: queue.length + 1, message: { message_id: queue.length + 10, text, chat: { id: chatId, type: 'private' }, from: { id: 7, username: 'ali', first_name: 'Али' }, date: 1 } });
  return { ...s, push, sent: () => s.requests.filter((r) => /send(Message|Document)$/.test(r.url)) };
}

describe('Telegram', () => {
  it('long polling получает сообщения, запускает сценарий, ответ уходит через sendMessage; офсет сохраняется', async () => {
    const tg = await telegramMock();
    const { engine } = makeEngine({ telegramPollTimeoutSec: 0 });
    closers.push(() => engine.stop());
    const cid = engine.saveCredential(null, 'Бот', 'telegramBot', { token: TG_TOKEN, apiBase: tg.url });
    const w = engine.createWorkflow('echo', wf([
      node('t', 'trigger.telegram', { credential: cid }),
      node('s', 'core.set', { assignments: [{ name: 'reply', value: 'Вы написали: {{ $json.text }}', type: 'string' }] }),
      node('m', 'telegram.send', { credential: cid, chatId: '{{ $json.chatId }}', mode: 'text', text: '{{ $json.reply }}' }),
    ], [edge('t', 'main', 's'), edge('s', 'main', 'm')]));
    engine.setActive(w.id, true);
    tg.push('привет');
    await waitFor(() => engine.store.listRuns({ workflowId: w.id }).length === 1);
    await engine.drain();
    const run = engine.store.listRuns({ workflowId: w.id })[0];
    expect(run.status).toBe('succeeded'); expect(run.trigger).toBe('telegram');
    const sent = tg.sent();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toEqual({ chat_id: '555', text: 'Вы написали: привет' });
    // то же сообщение не обрабатывается повторно (офсет)
    await new Promise((r) => setTimeout(r, 1200));
    expect(engine.store.listRuns({ workflowId: w.id })).toHaveLength(1);
    expect((engine.db.prepare('SELECT next_offset FROM telegram_offsets').get() as any).next_offset).toBe(2);
    // токен не виден в статусе/выходе
    expect(JSON.stringify(engine.status())).not.toContain(TG_TOKEN);
    expect(engine.pollerStatuses()).toHaveLength(1);
  });

  it('один бот — один получатель: второй сценарий с тем же токеном включить нельзя', async () => {
    const tg = await telegramMock();
    const { engine } = makeEngine({ telegramPollTimeoutSec: 0 });
    closers.push(() => engine.stop());
    const c1 = engine.saveCredential(null, 'Бот 1', 'telegramBot', { token: TG_TOKEN, apiBase: tg.url });
    const c2 = engine.saveCredential(null, 'Бот 1 (дубль)', 'telegramBot', { token: TG_TOKEN, apiBase: tg.url });
    const mk = (cid: string, name: string) => engine.createWorkflow(name, wf([node('t', 'trigger.telegram', { credential: cid }), node('s', 'core.set', { assignments: [] })], [edge('t', 'main', 's')]));
    const a = mk(c1, 'A'); const b = mk(c2, 'B');
    engine.setActive(a.id, true);
    expect(() => engine.setActive(b.id, true)).toThrow(/уже принимает сообщения в сценарии «A»/);
    expect(engine.pollerStatuses()).toHaveLength(1);
    engine.setActive(a.id, false);
    await waitFor(() => engine.pollerStatuses().length === 0);
    engine.setActive(b.id, true); // теперь можно
    expect(engine.pollerStatuses()).toHaveLength(1);
  });

  it('allowedChatIds фильтрует чужие чаты; отправка файла (текст как документ) идёт multipart', async () => {
    const tg = await telegramMock();
    const { engine } = makeEngine({ telegramPollTimeoutSec: 0 });
    closers.push(() => engine.stop());
    const cid = engine.saveCredential(null, 'Бот', 'telegramBot', { token: TG_TOKEN, apiBase: tg.url });
    const w = engine.createWorkflow('f', wf([
      node('t', 'trigger.telegram', { credential: cid, allowedChatIds: '555' }),
      node('m', 'telegram.send', { credential: cid, chatId: '{{ $json.chatId }}', mode: 'documentText', text: 'Файл', fileName: 'report.txt', fileContent: 'Содержимое отчёта' }),
    ], [edge('t', 'main', 'm')]));
    engine.setActive(w.id, true);
    tg.push('чужой', 999); tg.push('свой', 555);
    await waitFor(() => engine.store.listRuns({ workflowId: w.id }).length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await engine.drain();
    const runs = engine.store.listRuns({ workflowId: w.id });
    expect(runs).toHaveLength(1);
    const doc = tg.sent().find((r) => r.url.endsWith('sendDocument'))!;
    expect(doc.headers['content-type']).toMatch(/multipart\/form-data/);
    expect(doc.body).toContain('Содержимое отчёта'); expect(doc.body).toContain('report.txt');
  });

  it('ошибка Telegram возвращается без токена', async () => {
    const tg = await telegramMock();
    const { engine } = makeEngine();
    const cid = engine.saveCredential(null, 'Плохой', 'telegramBot', { token: '999999:WRONGTOKENWRONGTOKENWRONGTOKEN12', apiBase: tg.url });
    const w = engine.createWorkflow('bad', wf([node('t', 'trigger.manual'), node('m', 'telegram.send', { credential: cid, chatId: '1', text: 'hi' })], [edge('t', 'main', 'm')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('failed'); expect(run.error).toContain('Unauthorized'); expect(JSON.stringify(run)).not.toContain('WRONGTOKEN');
  });
});

const scripted = (script: (call: number, req: any) => any): AdapterFactory => () => { let n = 0; return { async chat(req) { const r = script(n++, req); return { content: r.content ?? '', toolCalls: r.toolCalls ?? [], usage: r.usage ?? { inputTokens: 10, outputTokens: 5 }, model: 'scripted' }; } }; };

describe('ИИ-агенты', () => {
  const setup = (script: (call: number, req: any) => any) => {
    const { engine } = makeEngine();
    engine.llm.register('scripted', scripted(script));
    const cid = engine.saveCredential(null, 'S', 'llmProvider', { provider: 'scripted', defaultModel: 'm' });
    return { engine, cid };
  };
  const agentWf = (engine: ReturnType<typeof makeEngine>['engine'], params: Record<string, unknown>) =>
    engine.createWorkflow('agent', wf([node('t', 'trigger.manual'), node('a', 'ai.agent', { system: 'Ты помощник', prompt: 'Посчитай', outputFormat: 'text', ...params })], [edge('t', 'main', 'a')]));

  it('агент вызывает разрешённый инструмент, пишет трассу вызовов и возвращает ответ', async () => {
    const { engine, cid } = setup((n, req) => n === 0
      ? { toolCalls: [{ id: 'c1', name: 'calculator', arguments: { expression: '2 + 3 * 4' } }] }
      : { content: `Ответ: ${req.messages.at(-1).content}` });
    const run = await runToEnd(engine, agentWf(engine, { credential: cid, tools: ['calculator'], maxSteps: 4 }).id);
    expect(run.status).toBe('succeeded');
    const out = run.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json as any;
    expect(out.text).toBe('Ответ: 14');
    expect(out.agent.trace.filter((t: any) => t.type === 'tool')).toEqual([expect.objectContaining({ tool: 'calculator', result: '14', arguments: { expression: '2 + 3 * 4' } })]);
  });

  it('неразрешённый инструмент не выполняется (ошибка попадает в трассу, а не в систему)', async () => {
    const { engine, cid } = setup((n) => n === 0 ? { toolCalls: [{ id: 'c1', name: 'http_get', arguments: { url: 'https://example.com' } }] } : { content: 'готово' });
    const run = await runToEnd(engine, agentWf(engine, { credential: cid, tools: ['calculator'] }).id);
    const trace = (run.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json as any).agent.trace;
    expect(trace.find((t: any) => t.type === 'tool').error).toContain('не разрешён');
  });

  it('лимиты: шаги, вызовы инструментов, токены', async () => {
    const loop = (n: number) => ({ toolCalls: [{ id: 'c' + n, name: 'calculator', arguments: { expression: '1+1' } }] });
    let s = setup((n) => (n < 100 ? loop(n) : { content: 'x' }));
    let run = await runToEnd(s.engine, agentWf(s.engine, { credential: s.cid, tools: ['calculator'], maxSteps: 3, maxToolCalls: 50 }).id);
    expect(run.status).toBe('failed'); expect(run.error).toContain('не уложился в 3 шагов'); // упрямая модель не обходит лимит шагов
    s = setup((n) => (n < 100 ? loop(n) : { content: 'x' }));
    run = await runToEnd(s.engine, agentWf(s.engine, { credential: s.cid, tools: ['calculator'], maxSteps: 5, maxToolCalls: 2 }).id);
    const log = run.nodes.find((n) => n.nodeId === 'a')!.log.join('\n');
    expect(log).toContain('Лимит вызовов инструментов исчерпан'); // 3-й и дальнейшие вызовы отклонены
    expect(log.match(/инструмент calculator\(.*\) → 2/g)).toHaveLength(2); // выполнено ровно 2
    s = setup(() => ({ content: 'ok', usage: { inputTokens: 90000, outputTokens: 20000 } }));
    run = await runToEnd(s.engine, agentWf(s.engine, { credential: s.cid, maxTotalTokens: 1000 }).id);
    expect(run.status).toBe('failed'); expect(run.error).toContain('Лимит токенов');
  });

  it('формат JSON: ответ разбирается, при неверном JSON — одна попытка исправления', async () => {
    const { engine, cid } = setup((n) => (n === 0 ? { content: 'не json' } : { content: '```json\n{"title":"Куртка","tags":["весна"]}\n```' }));
    const run = await runToEnd(engine, agentWf(engine, { credential: cid, outputFormat: 'json' }).id);
    expect((run.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json as any).result).toEqual({ title: 'Куртка', tags: ['весна'] });
  });

  it('агент вызывает вложенный сценарий как инструмент', async () => {
    const { engine, cid } = setup((n, req) => {
      if (n === 0) return { toolCalls: [{ id: 'c', name: req.tools[0].name, arguments: { input: { n: 4 } } }] };
      return { content: 'сценарий вернул: ' + req.messages.at(-1).content };
    });
    const child = engine.createWorkflow('square', wf([node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'sq', value: '{{ $json.n * $json.n }}', type: 'number' }] }), node('r', 'core.result')], [edge('t', 'main', 's'), edge('s', 'main', 'r')]));
    const run = await runToEnd(engine, agentWf(engine, { credential: cid, tools: [`workflow:${child.id}`] }).id);
    expect((run.nodes.find((n) => n.nodeId === 'a')!.outputs!.main[0].json as any).text).toContain('"sq":16');
  });

  it('цепочка агентов: результат одного передаётся другому; демо-провайдер честно помечен', async () => {
    const { engine } = makeEngine();
    const cid = engine.saveCredential(null, 'Демо', 'llmProvider', { provider: 'demo' });
    const w = engine.createWorkflow('chain', wf([
      node('t', 'trigger.manual'),
      node('a1', 'ai.agent', { credential: cid, system: 'Маркетолог', prompt: 'Товар: {{ $json.product }}', outputKey: 'marketing' }, undefined, 'Маркетолог'),
      node('a2', 'ai.agent', { credential: cid, system: 'Сценарист', prompt: 'Бриф: {{ $json.marketing }}', outputKey: 'script' }, undefined, 'Сценарист'),
    ], [edge('t', 'main', 'a1'), edge('a1', 'main', 'a2')]));
    const run = await runToEnd(engine, w.id, { product: 'куртка' });
    expect(run.status).toBe('succeeded');
    const out = run.nodes.find((n) => n.nodeId === 'a2')!.outputs!.main[0].json as any;
    expect(out.script).toContain('ДЕМО-ОТВЕТ'); expect(out.script).toContain('Маркетолог'); // получил результат первого
    expect(out.marketing).toContain('куртка');
  });

  it('адаптер OpenAI-совместимого API: запрос, ключ в заголовке, инструменты; ключ не попадает в результат', async () => {
    const KEY = 'sk-test-KEY-1234567890';
    const s = await mockServer((req, body, res) => {
      const j = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: `эхо(${j.messages.at(-1).content}) key=${req.headers.authorization}` } }], usage: { prompt_tokens: 11, completion_tokens: 4 } }));
    }); closers.push(s.close);
    const { engine } = makeEngine();
    const cid = engine.saveCredential(null, 'OpenAI', 'llmProvider', { provider: 'openai', baseUrl: s.url + '/v1', apiKey: KEY, defaultModel: 'gpt-x' });
    const w = engine.createWorkflow('llm', wf([node('t', 'trigger.manual'), node('l', 'ai.llm', { credential: cid, system: 'S', prompt: 'привет {{ $json.name }}', maxTokens: 50 })], [edge('t', 'main', 'l')]));
    const run = await runToEnd(engine, w.id, { name: 'мир' });
    expect(s.requests[0].url).toBe('/v1/chat/completions'); expect(s.requests[0].headers.authorization).toBe('Bearer ' + KEY);
    const out = run.nodes.find((n) => n.nodeId === 'l')!.outputs!.main[0].json as any;
    expect(out.text).toContain('эхо(привет мир)'); expect(out.ai.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    expect(JSON.stringify(run)).not.toContain(KEY);
  });

  it('адаптер Anthropic: x-api-key, версия, разбор текста и tool_use', async () => {
    const s = await mockServer((req, body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'claude-x', content: [{ type: 'text', text: 'привет от claude' }], usage: { input_tokens: 3, output_tokens: 2 } }));
    }); closers.push(s.close);
    const { engine } = makeEngine();
    const cid = engine.saveCredential(null, 'A', 'llmProvider', { provider: 'anthropic', baseUrl: s.url, apiKey: 'ant-key-1234567', defaultModel: 'claude-x' });
    const w = engine.createWorkflow('a', wf([node('t', 'trigger.manual'), node('l', 'ai.llm', { credential: cid, system: 'S', prompt: 'hi' })], [edge('t', 'main', 'l')]));
    const run = await runToEnd(engine, w.id);
    expect(s.requests[0].url).toBe('/v1/messages'); expect(s.requests[0].headers['x-api-key']).toBe('ant-key-1234567'); expect(s.requests[0].headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(s.requests[0].body).system).toBe('S');
    expect((run.nodes.find((n) => n.nodeId === 'l')!.outputs!.main[0].json as any).text).toBe('привет от claude');
  });
});

describe('бизнес-пример: одежда → маркетолог → сценарист → редактор → подтверждение → Telegram', () => {
  it('работает целиком; публикация в TikTok честно помечена как не подключённая', async () => {
    const { installExample } = await import('../src/engine/examples');
    const tg = await telegramMock();
    const { engine } = makeEngine();
    const inst = installExample(engine, 'clothing-pipeline');
    expect(inst.notes.join(' ')).toContain('Демо-ИИ');
    // пользователь выбирает Telegram-бота и chat id
    const cid = engine.saveCredential(null, 'Бот', 'telegramBot', { token: TG_TOKEN, apiBase: tg.url });
    const w = engine.store.getWorkflow(inst.workflow.id)!;
    for (const n of w.nodes) { if (n.type === 'telegram.send') n.params.credential = cid; if (n.id === 'd') (n.params.assignments as any[]).find((a) => a.name === 'chatId').value = '777'; }
    engine.updateWorkflow(w.id, { definition: { nodes: w.nodes, edges: w.edges } });

    const runId = engine.startRun(w.id); await engine.drain();
    let run = engine.store.getRunDetail(runId)!;
    expect(run.status).toBe('waiting'); // остановились на подтверждении, процесс свободен
    const out = (id: string) => run.nodes.find((n) => n.nodeId === id)!;
    expect((out('a3').outputs!.main[0].json as any).final).toContain('ДЕМО-ОТВЕТ'); // цепочка агентов отработала
    expect((out('a2').outputs!.main[0].json as any).script).toContain('сценарист'); expect((out('a2').outputs!.main[0].json as any).script).toContain('маркетолог'); // получил результат предыдущего агента
    expect(out('ap').status).toBe('waiting');
    expect(tg.sent()).toHaveLength(0); // до подтверждения ничего не отправлено

    engine.decideApproval(runId, 'ap', 'approved', 'ок'); await engine.drain();
    run = engine.store.getRunDetail(runId)!;
    expect(run.status).toBe('succeeded');
    expect(tg.sent()).toHaveLength(1);
    expect(JSON.parse(tg.sent()[0].body).chat_id).toBe('777');
    expect(JSON.parse(tg.sent()[0].body).text).toContain('Сценарий видео');
    const tk = (out('tk').outputs!.main[0].json) as any;
    expect(tk.tiktok_status).toBe('not_connected');
    expect(tk.tiktok_note).toContain('не публиковалось');

    // отклонение: в Telegram ничего не уходит
    const r2 = engine.startRun(w.id); await engine.drain();
    engine.decideApproval(r2, 'ap', 'rejected', 'переделать'); await engine.drain();
    const run2 = engine.store.getRunDetail(r2)!;
    expect(run2.status).toBe('succeeded'); expect(tg.sent()).toHaveLength(1);
    expect(run2.nodes.find((n) => n.nodeId === 'rj')!.outputs!.main[0].json.outcome).toContain('переделать');
    expect(run2.nodes.find((n) => n.nodeId === 'tg')!.status).toBe('skipped');
  });

  it('все примеры устанавливаются и проходят валидацию (кроме выбора Telegram-бота)', async () => {
    const { EXAMPLES, installExample } = await import('../src/engine/examples');
    const { engine } = makeEngine();
    for (const ex of EXAMPLES) {
      const r = installExample(engine, ex.id);
      const errs = engine.validate(r.workflow).filter((i) => i.level === 'error');
      expect(errs.every((e) => /Бот Telegram|Chat ID|подключени/i.test(e.message)), `${ex.id}: ${errs.map((e) => e.message).join('; ')}`).toBe(true);
    }
  });
});
