import { useState } from 'react';
import { SPEC_BY_TYPE } from '../shared/specs';
import type { RunDetail, RunNodeState } from '../shared/types';
import { call, fmtDuration, fmtTime } from './api';
import { Confirm, ItemsView, Json, StatusBadge, toast } from './ui';

export function NodeRunDetail({ st, nodeName, runId }: { st: RunNodeState; nodeName: string; runId: string }) {
  const [comment, setComment] = useState('');
  const decide = async (decision: 'approved' | 'rejected') => {
    try { await call('approvals.decide', { id: runId, nodeId: st.nodeId, decision, comment }); toast('ok', decision === 'approved' ? 'Запуск продолжен' : 'Отклонено'); }
    catch (e) { toast('err', (e as Error).message); }
  };
  return (
    <div className="node-detail">
      <div className="row"><b>{nodeName}</b><StatusBadge status={st.status} /><span className="muted">попыток: {st.attempt} · {fmtDuration(st.startedAt, st.finishedAt)}</span></div>
      {st.summary && <div className="summary">{st.summary}</div>}
      {st.error && <div className="errbox">{st.error}</div>}
      {st.status === 'waiting' && st.wait && (
        <div className="waitbox">
          {st.wait.kind === 'timer' && <>⏳ Ожидание до {fmtTime(st.wait.resumeAt)} (состояние сохранено в базе)</>}
          {st.wait.kind === 'child' && <>⧉ {st.wait.message}: ждём завершения вложенного запуска</>}
          {st.wait.kind === 'approval' && (
            <div>
              <div>✋ {st.wait.message}</div>
              {st.wait.resumeAt && <div className="muted">Тайм-аут решения: {fmtTime(st.wait.resumeAt)}</div>}
              <input placeholder="Комментарий (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="row"><button className="primary" onClick={() => decide('approved')}>Продолжить</button><button className="danger" onClick={() => decide('rejected')}>Отклонить</button></div>
            </div>
          )}
        </div>
      )}
      <details open={st.status !== 'skipped'}><summary>Входные данные</summary><ItemsView items={st.input} /></details>
      {st.outputs && Object.entries(st.outputs).map(([port, items]) => (
        <details key={port} open><summary>Выход «{port}» ({items.length})</summary><ItemsView items={items} /></details>
      ))}
      {st.log.length > 0 && <details><summary>Журнал ({st.log.length})</summary><pre className="json">{st.log.join('\n')}</pre></details>}
    </div>
  );
}

export function RunView({ run, selectedNode, onSelectNode, onChanged }: { run: RunDetail; selectedNode?: string | null; onSelectNode?: (id: string | null) => void; onChanged?: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const order = run.snapshot.nodes;
  const byId = new Map(run.nodes.map((n) => [n.nodeId, n]));
  const active = openId ?? selectedNode ?? null;
  const cancel = async () => { try { await call('runs.cancel', { id: run.id }); toast('info', 'Отмена запрошена'); onChanged?.(); } catch (e) { toast('err', (e as Error).message); } };
  const del = async () => { try { await call('runs.delete', { id: run.id }); onChanged?.(); } catch (e) { toast('err', (e as Error).message); } };
  return (
    <div className="runview">
      <div className="run-head">
        <div className="row"><StatusBadge status={run.status} /><b>{run.workflowName}</b><span className="muted">{run.trigger}</span></div>
        <div className="muted">Создан {fmtTime(run.createdAt)} · длительность {fmtDuration(run.startedAt, run.finishedAt)} · id {run.id.slice(0, 8)}{run.parentRunId ? ' · вложенный' : ''}</div>
        {run.error && <div className="errbox">{run.error}</div>}
        <div className="row">
          {(run.status === 'running' || run.status === 'waiting' || run.status === 'queued') && <button className="danger" onClick={cancel}>Отменить запуск</button>}
          {['succeeded', 'failed', 'cancelled'].includes(run.status) && <button onClick={() => setConfirmDel(true)}>Удалить из истории</button>}
        </div>
      </div>
      <div className="timeline">
        {order.map((n) => {
          const st = byId.get(n.id); if (!st) return null;
          const spec = SPEC_BY_TYPE[n.type];
          return (
            <div key={n.id} className={`tl-item ${active === n.id ? 'sel' : ''}`}>
              <div className="tl-row" onClick={() => { const next = active === n.id ? null : n.id; setOpenId(next); onSelectNode?.(next); }}>
                <span className={`dot st-${st.status}`} /><span className="tl-icon">{spec?.icon}</span>
                <span className="tl-name">{n.name}</span><span className="tl-sum">{st.summary ?? ''}</span>
                <span className="muted">{st.status === 'skipped' || st.status === 'pending' ? '' : fmtDuration(st.startedAt, st.finishedAt)}</span>
              </div>
              {active === n.id && <NodeRunDetail st={st} nodeName={n.name} runId={run.id} />}
            </div>
          );
        })}
      </div>
      {run.triggerData.length > 0 && <details><summary>Входные данные запуска</summary><ItemsView items={run.triggerData} /></details>}
      <details><summary>Снимок сценария на момент запуска (неизменяем)</summary><Json value={run.snapshot} max={8000} /></details>
      {confirmDel && <Confirm text="Удалить этот запуск из истории?" yes="Удалить" onNo={() => setConfirmDel(false)} onYes={() => { setConfirmDel(false); void del(); }} />}
    </div>
  );
}
