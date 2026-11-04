import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron } from '../src/engine/cron';
import { edge, makeEngine, node, wf } from './helpers';

describe('cron и часовые пояса', () => {
  it('рабочие дни в 09:00 по Стамбулу (UTC+3)', () => {
    const fri = Date.parse('2026-05-01T12:00:00Z'); // пятница
    expect(new Date(nextCronRun('0 9 * * 1-5', 'Europe/Istanbul', fri)).toISOString()).toBe('2026-05-04T06:00:00.000Z'); // понедельник
    expect(new Date(nextCronRun('0 9 * * 1-5', 'Europe/Istanbul', Date.parse('2026-05-04T05:00:00Z'))).toISOString()).toBe('2026-05-04T06:00:00.000Z');
  });
  it('шаги, списки, летнее время Нью-Йорка', () => {
    expect(new Date(nextCronRun('*/15 * * * *', 'UTC', Date.parse('2026-05-01T10:07:00Z'))).toISOString()).toBe('2026-05-01T10:15:00.000Z');
    expect(new Date(nextCronRun('0 9 * * *', 'America/New_York', Date.parse('2026-01-15T00:00:00Z'))).toISOString()).toBe('2026-01-15T14:00:00.000Z'); // зима UTC-5
    expect(new Date(nextCronRun('0 9 * * *', 'America/New_York', Date.parse('2026-07-15T00:00:00Z'))).toISOString()).toBe('2026-07-15T13:00:00.000Z'); // лето UTC-4
    expect(new Date(nextCronRun('0 0 29 2 *', 'UTC', Date.parse('2026-05-01T00:00:00Z'))).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
  it('некорректные выражения отклоняются', () => {
    expect(() => parseCron('* * *')).toThrow(/5 полей/);
    expect(() => parseCron('61 * * * *')).toThrow(/диапазона/);
    expect(() => nextCronRun('* * * * *', 'Mars/Base', 0)).toThrow(/часовой пояс/);
  });
});

function scheduled(missedPolicy: 'skip' | 'runOnce', cron?: string) {
  let now = Date.parse('2026-05-01T05:59:00Z');
  const { engine, dir } = makeEngine({ now: () => now });
  const trig = node('t', 'trigger.schedule', cron ? { mode: 'cron', cron, timezone: 'Europe/Istanbul', missedPolicy } : { mode: 'interval', everyMinutes: 10, timezone: 'Europe/Istanbul', missedPolicy });
  const w = engine.createWorkflow('sch', wf([trig, node('s', 'core.set', { assignments: [{ name: 'x', value: '{{ $json.missed }}', type: 'auto' }] })], [edge('t', 'main', 's')]));
  engine.setActive(w.id, true);
  return { engine, w, dir, advance: (ms: number) => { now += ms; }, set: (iso: string) => { now = Date.parse(iso); } };
}

describe('расписания', () => {
  it('cron в часовом поясе: срабатывает ровно в 09:00 по Стамбулу', async () => {
    const t = scheduled('skip', '0 9 * * *');
    expect(t.engine.tickSchedules()).toEqual({ fired: 0, skipped: 0 });
    t.set('2026-05-01T06:00:20Z'); // 09:00:20 Istanbul
    expect(t.engine.tickSchedules()).toEqual({ fired: 1, skipped: 0 });
    await t.engine.drain();
    const run = t.engine.store.listRuns({ workflowId: t.w.id })[0];
    expect(run.trigger).toBe('schedule'); expect(run.status).toBe('succeeded');
    t.set('2026-05-01T06:01:00Z'); expect(t.engine.tickSchedules().fired).toBe(0); // повторно не срабатывает
    t.set('2026-05-02T06:00:10Z'); expect(t.engine.tickSchedules().fired).toBe(1);
  });

  it('после сна: policy=skip пропускает накопившиеся запуски', () => {
    const t = scheduled('skip');
    t.advance(10 * 60_000 + 1000); expect(t.engine.tickSchedules().fired).toBe(1); // нормальный запуск
    t.advance(5 * 3600_000); // ноутбук проспал 5 часов
    expect(t.engine.tickSchedules()).toEqual({ fired: 0, skipped: 1 });
    expect(t.engine.store.listRuns({ workflowId: t.w.id })).toHaveLength(1);
    const next = (t.engine.db.prepare('SELECT next_run_at FROM schedule_state').get() as any).next_run_at;
    expect(next).toBeGreaterThan(Date.parse('2026-05-01T05:59:00Z') + 5 * 3600_000);
    t.advance(11 * 60_000); expect(t.engine.tickSchedules().fired).toBe(1); // расписание продолжило работу
  });

  it('после сна: policy=runOnce выполняет один раз (а не 30)', async () => {
    const t = scheduled('runOnce');
    t.advance(5 * 3600_000);
    expect(t.engine.tickSchedules()).toEqual({ fired: 1, skipped: 0 });
    await t.engine.drain();
    const runs = t.engine.store.listRuns({ workflowId: t.w.id });
    expect(runs).toHaveLength(1); expect(runs[0].trigger).toContain('пропущенный');
    const d = t.engine.store.getRunDetail(runs[0].id)!;
    expect(d.triggerData[0].json).toMatchObject({ missed: true });
    expect(d.nodes.find((n) => n.nodeId === 's')!.outputs!.main[0].json.x).toBe(true);
  });

  it('расписание переживает перезапуск приложения (состояние в БД)', async () => {
    const t = scheduled('skip');
    await t.engine.stop();
    const { Engine } = await import('../src/engine/engine');
    const { key } = await import('./helpers');
    const e2 = new Engine({ dbPath: `${t.dir}/db.sqlite`, masterKey: key, background: false, now: () => Date.parse('2026-05-01T06:10:30Z') });
    await e2.start();
    expect(e2.tickSchedules().fired).toBe(1);
    await e2.stop();
  });

  it('выключенный сценарий не запускается, расписание удаляется', () => {
    const t = scheduled('skip');
    t.engine.setActive(t.w.id, false);
    t.advance(3600_000);
    expect(t.engine.tickSchedules()).toEqual({ fired: 0, skipped: 0 });
    expect((t.engine.db.prepare('SELECT COUNT(*) c FROM schedule_state').get() as any).c).toBe(0);
  });
});
