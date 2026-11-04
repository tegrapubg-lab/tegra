import { describe, expect, it } from 'vitest';
import { edge, makeEngine, node, runToEnd, wf } from './helpers';
import { hasErrors, validateWorkflow } from '../src/shared/validate';

const setField = (name: string, value: string) => ({ mode: 'add', assignments: [{ name, value, type: 'string' }] });

describe('ветвление, объединение, списки', () => {
  it('IF → две ветки → Merge(append) объединяет оба результата', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('m', wf([
      node('t', 'trigger.manual'),
      node('s', 'core.set', { assignments: [{ name: 'n', value: '5', type: 'number' }] }),
      node('i', 'core.if', { conditions: [{ left: '{{ $json.n }}', op: 'gt', right: '3' }] }),
      node('a', 'core.set', setField('branch', 'yes')),
      node('b', 'core.set', setField('branch', 'no')),
      node('m', 'core.merge', { mode: 'append' }),
    ], [edge('t', 'main', 's'), edge('s', 'main', 'i'), edge('i', 'true', 'a'), edge('i', 'false', 'b'), edge('a', 'main', 'm', 'a'), edge('b', 'main', 'm', 'b')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    const st = Object.fromEntries(run.nodes.map((n) => [n.nodeId, n]));
    expect(st.b.status).toBe('skipped');
    // Merge без requireBoth проходит с одной живой веткой
    expect(st.m.outputs!.main.map((i) => i.json.branch)).toEqual(['yes']);
  });

  it('Merge с requireBoth пропускается, если одна ветка пуста', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('m2', wf([
      node('t', 'trigger.manual'),
      node('i', 'core.if', { conditions: [{ left: '1', op: 'equals', right: '1' }] }),
      node('a', 'core.set', setField('x', '1')), node('b', 'core.set', setField('x', '2')),
      node('m', 'core.merge', { mode: 'append', requireBoth: true }),
      node('after', 'core.set', setField('z', '1')),
    ], [edge('t', 'main', 'i'), edge('i', 'true', 'a'), edge('i', 'false', 'b'), edge('a', 'main', 'm', 'a'), edge('b', 'main', 'm', 'b'), edge('m', 'main', 'after')]));
    const run = await runToEnd(engine, w.id);
    const st = Object.fromEntries(run.nodes.map((n) => [n.nodeId, n]));
    expect(st.m.status).toBe('skipped');
    expect(st.after.status).toBe('skipped'); // пропуск распространяется
    expect(run.status).toBe('succeeded');
  });

  it('Merge zip склеивает поля попарно из двух параллельных веток', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('zip', wf([
      node('t', 'trigger.manual'),
      node('a', 'core.set', setField('left', 'L')), node('b', 'core.set', setField('right', 'R')),
      node('m', 'core.merge', { mode: 'zip' }),
    ], [edge('t', 'main', 'a'), edge('t', 'main', 'b'), edge('a', 'main', 'm', 'a'), edge('b', 'main', 'm', 'b')]));
    const run = await runToEnd(engine, w.id);
    expect(run.nodes.find((n) => n.nodeId === 'm')!.outputs!.main[0].json).toEqual({ left: 'L', right: 'R' });
  });

  it('Split + Switch + дальнейшая обработка списка', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('sp', wf([
      node('t', 'trigger.manual'),
      node('s', 'core.splitOut', { field: 'items' }),
      node('sw', 'core.switch', { value: '{{ $json.cat }}', rules: [{ op: 'equals', right: 'coat' }, { op: 'equals', right: 'shirt' }] }),
      node('c1', 'core.set', setField('t', 'coat')), node('c2', 'core.set', setField('t', 'shirt')), node('o', 'core.set', setField('t', 'other')),
    ], [edge('t', 'main', 's'), edge('s', 'main', 'sw'), edge('sw', 'case1', 'c1'), edge('sw', 'case2', 'c2'), edge('sw', 'other', 'o')]));
    const run = await runToEnd(engine, w.id, { items: [{ cat: 'coat' }, { cat: 'shirt' }, { cat: 'coat' }, { cat: 'hat' }] });
    const out = (id: string) => run.nodes.find((n) => n.nodeId === id)!.outputs!.main.map((i) => i.json.cat);
    expect(out('c1')).toEqual(['coat', 'coat']); expect(out('c2')).toEqual(['shirt']); expect(out('o')).toEqual(['hat']);
  });

  it('Repeat генерирует N элементов; пустой список не запускает узлы ниже', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('r', wf([
      node('t', 'trigger.manual'), node('r', 'core.repeat', { count: 4 }),
      node('e', 'core.splitOut', { field: 'nothing' }), node('after', 'core.set', setField('a', '1')),
    ], [edge('t', 'main', 'r'), edge('r', 'main', 'e'), edge('e', 'main', 'after')]));
    const run = await runToEnd(engine, w.id);
    expect(run.nodes.find((n) => n.nodeId === 'r')!.outputs!.main).toHaveLength(4);
    expect(run.nodes.find((n) => n.nodeId === 'after')!.status).toBe('skipped');
  });

  it('независимые ветки выполняются параллельно', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('par', wf([
      node('t', 'trigger.manual'),
      node('w1', 'core.wait', { mode: 'duration', amount: 0, unit: 'seconds' }), node('x', 'core.set', setField('a', '1')), node('y', 'core.set', setField('b', '1')),
    ], [edge('t', 'main', 'w1'), edge('t', 'main', 'x'), edge('t', 'main', 'y')]));
    const run = await runToEnd(engine, w.id);
    expect(run.status).toBe('succeeded');
    expect(run.nodes.filter((n) => n.status === 'succeeded')).toHaveLength(4);
  });

  it('выражения: цитаты узлов, арифметика, безопасность', async () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('ex', wf([
      node('t', 'trigger.manual'),
      node('s1', 'core.set', { assignments: [{ name: 'name', value: 'Ася', type: 'string' }] }, undefined, 'Первый'),
      node('s2', 'core.set', { assignments: [
        { name: 'hello', value: 'Привет, {{ $node["Первый"].json.name }}! {{ round(10 / 3, 2) }} {{ upper("ab") }}', type: 'string' },
        { name: 'tern', value: '{{ length("abc") > 2 ? "long" : "short" }}', type: 'string' },
        { name: 'def', value: '{{ $json.missing ?? "дефолт" }}', type: 'string' } ] }, undefined, 'Второй'),
    ], [edge('t', 'main', 's1'), edge('s1', 'main', 's2')]));
    const run = await runToEnd(engine, w.id);
    expect(run.nodes.find((n) => n.nodeId === 's2')!.outputs!.main[0].json).toMatchObject({ hello: 'Привет, Ася! 3.33 AB', tern: 'long', def: 'дефолт' });

    const bad = engine.createWorkflow('bad', wf([node('t', 'trigger.manual'), node('s', 'core.set', { assignments: [{ name: 'x', value: '{{ $json.constructor.constructor("return process")() }}', type: 'auto' }] })], [edge('t', 'main', 's')]));
    const r2 = await runToEnd(engine, bad.id);
    expect(r2.status).toBe('failed'); expect(r2.error).toMatch(/Лишние символы|запрещён|Неизвестн/i); expect(JSON.stringify(r2.nodes)).not.toContain('pid');
  });
});

describe('валидация графа', () => {
  it('запрещает циклы, висящие ссылки и дубликаты имён', () => {
    const cyc = validateWorkflow(wf([node('t', 'trigger.manual'), node('a', 'core.set', setField('a', '1')), node('b', 'core.set', setField('b', '1'))],
      [edge('t', 'main', 'a'), edge('a', 'main', 'b'), edge('b', 'main', 'a')]));
    expect(cyc.some((i) => i.message.includes('цикл'))).toBe(true);
    const dup = validateWorkflow(wf([node('t', 'trigger.manual'), node('a', 'core.set', setField('a', '1'), undefined, 'X'), node('b', 'core.set', setField('b', '1'), undefined, 'X')], []));
    expect(hasErrors(dup)).toBe(true);
    const nope = validateWorkflow(wf([node('t', 'trigger.manual')], [edge('t', 'main', 'ghost')]));
    expect(hasErrors(nope)).toBe(true);
    const noTrigger = validateWorkflow(wf([node('a', 'core.set', setField('a', '1'))], []));
    expect(noTrigger.some((i) => i.message.includes('триггер'))).toBe(true);
    const missingParam = validateWorkflow(wf([node('t', 'trigger.manual'), node('h', 'http.request', {})], [edge('t', 'main', 'h')]));
    expect(missingParam.some((i) => i.message.includes('URL'))).toBe(true);
  });

  it('движок отказывается запускать невалидный сценарий понятным сообщением', () => {
    const { engine } = makeEngine();
    const w = engine.createWorkflow('v', wf([node('t', 'trigger.manual'), node('h', 'http.request', {})], [edge('t', 'main', 'h')]));
    expect(() => engine.startRun(w.id)).toThrow(/обязательно/);
  });
});
