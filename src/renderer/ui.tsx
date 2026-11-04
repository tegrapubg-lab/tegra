import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STATUS_RU } from './api';

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge st-${status}`}>{STATUS_RU[status] ?? status}</span>;
}

export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = [], enabled = true): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const my = ++tick.current;
      try { const d = await fn(); if (alive && my === tick.current) { setData(d); setError(null); } }
      catch (e) { if (alive) setError((e as Error).message); }
      if (alive) timer = setTimeout(run, ms);
    };
    void run();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms, enabled, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string };
let pushToast: (t: Omit<Toast, 'id'>) => void = () => {};
export const toast = (kind: Toast['kind'], text: string) => pushToast({ kind, text });
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setList((l) => [...l.slice(-4), { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.kind === 'err' ? 9000 : 4000);
    };
  }, []);
  return <div className="toasts">{list.map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>{t.text}</div>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Закрыть">✕</button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Json({ value, max = 20000 }: { value: unknown; max?: number }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return <pre className="json">{text.length > max ? text.slice(0, max) + `\n… (показано ${max} из ${text.length} символов)` : text}</pre>;
}

export function ItemsView({ items }: { items: { json: Record<string, unknown> }[] | null | undefined }) {
  const [mode, setMode] = useState<'json' | 'table'>('json');
  if (!items) return <div className="muted">нет данных</div>;
  if (items.length === 0) return <div className="muted">пусто (0 элементов)</div>;
  const shown = items.slice(0, 100);
  const cols = [...new Set(shown.flatMap((i) => Object.keys(i.json)))].slice(0, 12);
  return (
    <div>
      <div className="seg">
        <button className={mode === 'json' ? 'on' : ''} onClick={() => setMode('json')}>JSON</button>
        <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Таблица</button>
        <span className="muted"> элементов: {items.length}{items.length > shown.length ? ` (показано ${shown.length})` : ''}</span>
      </div>
      {mode === 'json' ? <Json value={shown.map((i) => i.json)} /> : (
        <div className="table-wrap"><table className="tbl"><thead><tr><th>#</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((it, i) => <tr key={i}><td>{i + 1}</td>{cols.map((c) => { const v = it.json[c]; return <td key={c}>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}</td>; })}</tr>)}</tbody></table></div>
      )}
    </div>
  );
}

export function Confirm({ text, onYes, onNo, yes = 'Да' }: { text: string; onYes: () => void; onNo: () => void; yes?: string }) {
  return <Modal title="Подтверждение" onClose={onNo}><p>{text}</p><div className="row end"><button onClick={onNo}>Отмена</button><button className="danger" onClick={onYes}>{yes}</button></div></Modal>;
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); toast('ok', 'Скопировано'); } catch { toast('err', 'Не удалось скопировать'); }
}
