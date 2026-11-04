import type { Db } from './db';

export interface Job { id: number; runId: string }

/**
 * Устойчивая очередь заданий в SQLite.
 *  - одно активное задание на запуск (уникальный индекс по run_id);
 *  - захват атомарен (UPDATE ... WHERE id=(SELECT ...) RETURNING) и защищён lease;
 *  - если во время выполнения пришёл новый сигнал (resume), задание помечается rerun и выполнится ещё раз.
 */
export class JobQueue {
  constructor(private db: Db, public workerId: string, private now: () => number, private leaseMs = 30_000) {}

  enqueue(runId: string, delayMs = 0): void {
    const t = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.db.prepare('SELECT id,status FROM jobs WHERE run_id=?').get(runId) as { id: number; status: string } | undefined;
      if (!cur) this.db.prepare(`INSERT INTO jobs(run_id,status,available_at,rerun,created_at) VALUES (?, 'queued', ?, 0, ?)`).run(runId, t + delayMs, t);
      else if (cur.status === 'claimed') this.db.prepare('UPDATE jobs SET rerun=1 WHERE id=?').run(cur.id);
      else this.db.prepare('UPDATE jobs SET available_at=MIN(available_at, ?) WHERE id=?').run(t + delayMs, cur.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  claim(): Job | null {
    const t = this.now();
    const row = this.db.prepare(`UPDATE jobs SET status='claimed', locked_by=?, lease_until=?
      WHERE id = (SELECT id FROM jobs WHERE status='queued' AND available_at <= ? ORDER BY available_at, id LIMIT 1) AND status='queued'
      RETURNING id, run_id`).get(this.workerId, t + this.leaseMs, t) as { id: number; run_id: string } | undefined;
    return row ? { id: row.id, runId: row.run_id } : null;
  }

  heartbeat(jobId: number): boolean {
    const r = this.db.prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND locked_by=? AND status='claimed'`).run(this.now() + this.leaseMs, jobId, this.workerId);
    return Number(r.changes) > 0;
  }

  /** Завершить задание. Если был rerun — вернуть в очередь. Возвращает true, если задание повторится. */
  complete(jobId: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.db.prepare('SELECT rerun FROM jobs WHERE id=? AND locked_by=?').get(jobId, this.workerId) as { rerun: number } | undefined;
      let again = false;
      if (cur?.rerun) { this.db.prepare(`UPDATE jobs SET status='queued', rerun=0, locked_by=NULL, lease_until=NULL, available_at=? WHERE id=?`).run(this.now(), jobId); again = true; }
      else this.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
      this.db.exec('COMMIT');
      return again;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Вернуть в очередь задания с истёкшим lease (упавший исполнитель). */
  recoverExpired(forceAll = false): number {
    const r = this.db.prepare(`UPDATE jobs SET status='queued', locked_by=NULL, lease_until=NULL, available_at=? WHERE status='claimed' AND (? OR lease_until < ?)`).run(this.now(), forceAll ? 1 : 0, this.now());
    return Number(r.changes);
  }

  deleteForRun(runId: string) { this.db.prepare('DELETE FROM jobs WHERE run_id=?').run(runId); }
  counts(): { queued: number; claimed: number } {
    const rows = this.db.prepare('SELECT status, COUNT(*) c FROM jobs GROUP BY status').all() as { status: string; c: number }[];
    return { queued: rows.find((r) => r.status === 'queued')?.c ?? 0, claimed: rows.find((r) => r.status === 'claimed')?.c ?? 0 };
  }
}
