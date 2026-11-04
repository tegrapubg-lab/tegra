// Мини-cron (5 полей) с вычислением в часовом поясе IANA.
export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function parseField(src: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Cron: некорректное поле «${name}»: ${src}`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Cron: шаг должен быть ≥ 1 (${name})`);
    let lo = min; let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a; hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron: значение вне диапазона ${min}-${max} (${name})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('Cron должен состоять из 5 полей: минута час день месяц день_недели');
  const dow = parseField(f[4], 0, 7, 'день недели');
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: parseField(f[0], 0, 59, 'минута'), hour: parseField(f[1], 0, 23, 'час'),
    dom: parseField(f[2], 1, 31, 'день месяца'), month: parseField(f[3], 1, 12, 'месяц'), dow,
    domStar: f[2].startsWith('*'), dowStar: f[4].startsWith('*'),
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow };
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** Ближайший момент строго после afterMs, подходящий под cron в часовом поясе tz. */
export function nextCronRun(expr: string, tz: string, afterMs: number): number {
  const c = parseCron(expr);
  if (!isValidTimezone(tz)) throw new Error(`Неизвестный часовой пояс: ${tz}`);
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  for (let i = 0; i < 400_000; i++) {
    const p = localParts(t, tz);
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(p.dow) : c.dowStar ? c.dom.has(p.day) : c.dom.has(p.day) || c.dow.has(p.dow);
    if (!c.month.has(p.month) || !dayOk || !c.hour.has(p.hour)) { t += (60 - p.minute) * 60000; continue; }
    if (!c.minute.has(p.minute)) { t += 60000; continue; }
    return t;
  }
  throw new Error('Cron: не найдено ближайшее время запуска в пределах года');
}
