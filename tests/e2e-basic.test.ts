import { afterAll, describe, expect, it } from 'vitest';
import { edge, makeEngine, mockServer, node, runToEnd, wf } from './helpers';

describe('основной сценарий: ручной запуск → поля → IF → HTTP → результат', () => {
  const srv = mockServer((req, body, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ echoed: JSON.parse(body || '{}'), ok: true })); });
  afterAll(async () => (await srv).close());

  it('исполняется через очередь, сохраняется в SQLite и показывает данные каждого шага', async () => {
    const s = await srv;
    const { engine } = makeEngine();
    const w = engine.createWorkflow('e2e', wf([
      node('t', 'trigger.manual'),
      node('s', 'core.set', { mode: 'add', assignments: [{ name: 'price', value: '1500', type: 'number' }, { name: 'qty', value: '3', type: 'number' }, { name: 'total', value: '{{ $json.price * $json.qty }}', type: 'number' }] }),
      node('i', 'core.if', { combinator: 'and', conditions: [{ left: '{{ $json.total }}', op: 'gt', right: '3000' }] }),
      node('h', 'http.request', { method: 'POST', url: s.url + '/orders', bodyType: 'json', body: '{"total": {{ $json.total }}}', allowPrivate: true }),
      node('o', 'core.set', { assignments: [{ name: 'note', value: 'мало', type: 'string' }] }),
    ], [edge('t', 'main', 's'), edge('s', 'main', 'i'), edge('i', 'true', 'h'), edge('i', 'false', 'o')]));

    const run = await runToEnd(engine, w.id);
    expect(run.error).toBeNull();
    expect(run.status).toBe('succeeded');
    const st = Object.fromEntries(run.nodes.map((n) => [n.nodeId, n]));
    expect(st.s.outputs!.main[0].json).toMatchObject({ price: 1500, qty: 3, total: 4500 });
    expect(st.i.outputs!.true).toHaveLength(1);
    expect(st.h.status).toBe('succeeded');
    expect((st.h.outputs!.main[0].json as any).body).toEqual({ echoed: { total: 4500 }, ok: true });
    expect(st.o.status).toBe('skipped'); // ложная ветка не выполнялась
    expect(s.requests[0].body).toBe('{"total": 4500}');
    expect(st.h.input![0].json).toMatchObject({ total: 4500 });
    // данные лежат в SQLite
    const row = engine.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as any;
    expect(row.status).toBe('succeeded');
    // очередь пуста
    expect(engine.queue.counts()).toEqual({ queued: 0, claimed: 0 });
  });
});
