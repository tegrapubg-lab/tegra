import {
  addEdge, Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS, NODE_SPECS, SPEC_BY_TYPE, type NodeCategory } from '../shared/specs';
import type { RunDetail, WorkflowDefinition, WorkflowNode, NodeSettings } from '../shared/types';
import { hasErrors, validateWorkflow } from '../shared/validate';
import { api, call, fmtTime, type EngineStatus, type WorkflowFull } from './api';
import { ParamForm } from './ParamForm';
import { NodeRunDetail, RunView } from './RunView';
import { Json, Modal, StatusBadge, copyText, toast, usePoll } from './ui';

interface NodeData extends Record<string, unknown> { type: string; name: string; params: Record<string, unknown>; settings?: NodeSettings; status?: string; summary?: string | null; issues?: number }
type FNode = Node<NodeData, 'flow'>;

const uid = () => crypto.randomUUID();
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

function FlowNode({ data, selected }: NodeProps<FNode>) {
  const spec = SPEC_BY_TYPE[data.type];
  if (!spec) return <div className="fnode invalid">Неизвестный узел {data.type}</div>;
  const multiOut = spec.outputs.length > 1; const multiIn = spec.inputs.length > 1;
  return (
    <div className={`fnode cat-${spec.category} st-${data.status ?? 'idle'} ${selected ? 'selected' : ''} ${data.issues ? 'invalid' : ''}`}>
      {!multiIn && spec.inputs.map((i) => <Handle key={i} type="target" position={Position.Left} id={i} />)}
      <div className="fn-head"><span className="fn-icon">{spec.icon}</span><b title={data.name}>{data.name}</b>{data.issues ? <span className="fn-warn" title="Есть ошибки в настройках">!</span> : null}</div>
      <div className="fn-sub">{spec.label}</div>
      {data.summary && <div className="fn-sum" title={data.summary}>{data.summary}</div>}
      {multiIn && <div className="fn-ports in">{spec.inputs.map((i) => <div key={i} className="fn-port"><Handle type="target" position={Position.Left} id={i} /><span>{i.toUpperCase()}</span></div>)}</div>}
      {multiOut && <div className="fn-ports out">{spec.outputs.map((o) => <div key={o.id} className="fn-port"><span>{o.label}</span><Handle type="source" position={Position.Right} id={o.id} /></div>)}</div>}
      {!multiOut && spec.outputs.map((o) => <Handle key={o.id} type="source" position={Position.Right} id={o.id} />)}
    </div>
  );
}
const nodeTypes = { flow: FlowNode };

const toFNode = (n: WorkflowNode): FNode => ({ id: n.id, type: 'flow', position: n.position, data: { type: n.type, name: n.name, params: n.params ?? {}, settings: n.settings } });
const toEdge = (e: WorkflowDefinition['edges'][number]): Edge => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed } });
const toDef = (nodes: FNode[], edges: Edge[]): WorkflowDefinition => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, name: n.data.name, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, params: n.data.params, ...(n.data.settings && Object.keys(n.data.settings).length ? { settings: n.data.settings } : {}) })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'main', target: e.target, targetHandle: e.targetHandle ?? 'main' })),
});

function defaultParams(type: string): Record<string, unknown> {
  const spec = SPEC_BY_TYPE[type]; const p: Record<string, unknown> = {};
  for (const f of spec.params) if (f.default !== undefined) p[f.name] = structuredClone(f.default);
  if (type === 'trigger.webhook') p.path = hex(12);
  return p;
}

function EditorInner({ id, onBack }: { id: string; onBack: () => void }) {
  const rf = useReactFlow<FNode, Edge>();
  const [wf, setWf] = useState<WorkflowFull | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ name: string; definition: WorkflowDefinition; at: number } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [bottom, setBottom] = useState<'run' | 'history' | 'closed'>('closed');
  const [inputDlg, setInputDlg] = useState(false);
  const [inputText, setInputText] = useState('{\n  "name": "пример"\n}');
  const [selRunNode, setSelRunNode] = useState<string | null>(null);
  const loaded = useRef(false);

  const creds = usePoll(api.credentials, 60_000, []);
  const wfs = usePoll(api.workflows, 15_000, []);
  const status = usePoll<EngineStatus>(api.status, 5000, []);
  const history = usePoll(() => api.runs(id, 40), 2000, [id], bottom === 'history' || bottom === 'run');

  // rf/onBack меняют идентичность между рендерами — держим их в ref, чтобы загрузка зависела только от id
  const rfRef = useRef(rf); rfRef.current = rf;
  const backRef = useRef(onBack); backRef.current = onBack;
  const load = useCallback(async () => {
    const rf = rfRef.current;
    const w = await api.workflow(id);
    setWf(w); setName(w.name);
    const base = { nodes: w.nodes.map(toFNode), edges: w.edges.map(toEdge) };
    setNodes(base.nodes); setEdges(base.edges); setDirty(false); loaded.current = true;
    try {
      const d = JSON.parse(localStorage.getItem(`tegra.draft.${id}`) ?? 'null');
      if (d && d.baseVersion === w.version && JSON.stringify(d.definition) !== JSON.stringify(toDef(base.nodes, base.edges))) setDraft(d);
      else localStorage.removeItem(`tegra.draft.${id}`);
      const vp = JSON.parse(localStorage.getItem(`tegra.vp.${id}`) ?? 'null');
      if (vp) setTimeout(() => rf.setViewport(vp), 0); else setTimeout(() => rf.fitView({ padding: 0.3, maxZoom: 1 }), 50);
    } catch { /* повреждённый черновик */ }
  }, [id, setEdges, setNodes]);
  useEffect(() => { loaded.current = false; void load().catch((e) => { toast('err', (e as Error).message); backRef.current(); }); }, [load]);

  // черновик: переживает перезапуск приложения
  useEffect(() => {
    if (!dirty || !wf) return;
    const t = setTimeout(() => { try { localStorage.setItem(`tegra.draft.${id}`, JSON.stringify({ name, definition: toDef(nodes, edges), baseVersion: wf.version, at: Date.now() })); } catch { /* квота */ } }, 500);
    return () => clearTimeout(t);
  }, [nodes, edges, name, dirty, wf, id]);

  const def = useMemo(() => toDef(nodes, edges), [nodes, edges]);
  const issues = useMemo(() => validateWorkflow(def), [def]);
  const issueCount = useMemo(() => { const m = new Map<string, number>(); for (const i of issues) if (i.level === 'error' && i.nodeId) m.set(i.nodeId, (m.get(i.nodeId) ?? 0) + 1); return m; }, [issues]);

  const run = usePoll<RunDetail | null>(() => (runId ? api.run(runId) : Promise.resolve(null)), 700, [runId], !!runId);
  const runDetail = run.data ?? null;
  useEffect(() => { if (runDetail && ['succeeded', 'failed', 'cancelled'].includes(runDetail.status)) { const t = setTimeout(() => history.reload(), 200); return () => clearTimeout(t); } }, [runDetail?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const runStates = useMemo(() => new Map((runDetail?.nodes ?? []).map((s) => [s.nodeId, s])), [runDetail]);

  const shownNodes = useMemo(() => nodes.map((n) => {
    const st = runStates.get(n.id);
    return { ...n, data: { ...n.data, status: st?.status, summary: st?.summary ?? null, issues: issueCount.get(n.id) ?? 0 } };
  }), [nodes, runStates, issueCount]);

  const markDirty = () => setDirty(true);
  const onConnect = useCallback((c: Connection) => { setEdges((es) => addEdge({ ...c, id: `${c.source}:${c.sourceHandle}->${c.target}:${c.targetHandle}`, markerEnd: { type: MarkerType.ArrowClosed } }, es)); markDirty(); }, [setEdges]);
  const isValidConnection = useCallback((c: Edge | Connection) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const t = nodes.find((n) => n.id === c.target); if (!t || SPEC_BY_TYPE[t.data.type]?.isTrigger) return false;
    // запрет цикла: из target нельзя дойти до source
    const seen = new Set<string>(); const stack = [c.target];
    while (stack.length) { const cur = stack.pop()!; if (cur === c.source) return false; if (seen.has(cur)) continue; seen.add(cur); for (const e of edges) if (e.source === cur) stack.push(e.target); }
    return true;
  }, [nodes, edges]);

  const uniqueName = (base: string) => { const names = new Set(nodes.map((n) => n.data.name)); if (!names.has(base)) return base; let i = 2; while (names.has(`${base} ${i}`)) i++; return `${base} ${i}`; };
  const addNode = (type: string, pos?: { x: number; y: number }) => {
    const spec = SPEC_BY_TYPE[type];
    let p = pos;
    if (!p) {
      const sel = nodes.find((n) => n.id === selected);
      p = sel ? { x: sel.position.x + 260, y: sel.position.y } : rf.screenToFlowPosition({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 150 });
      while (nodes.some((n) => Math.abs(n.position.x - p!.x) < 200 && Math.abs(n.position.y - p!.y) < 90)) p = { x: p.x, y: p.y + 110 };
    }
    const n: FNode = { id: uid(), type: 'flow', position: p, data: { type, name: uniqueName(spec.label), params: defaultParams(type) } };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...n, selected: true }]); setSelected(n.id); markDirty();
    // новый узел не должен оказаться за границей видимой области
    if (!pos) setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1, duration: 150 }), 30);
  };

  const patchNode = (nid: string, fn: (d: NodeData) => NodeData) => { setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: fn(n.data) } : n))); markDirty(); };

  const save = async (silent = false): Promise<boolean> => {
    setSaving(true);
    try {
      const w = await call<WorkflowFull>('workflows.update', { id, name, definition: toDef(nodes, edges) });
      setWf(w); setDirty(false); localStorage.removeItem(`tegra.draft.${id}`); setDraft(null);
      if (!silent) toast('ok', 'Сценарий сохранён');
      return true;
    } catch (e) { toast('err', (e as Error).message); return false; } finally { setSaving(false); }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void save(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); });

  const start = async (input?: unknown) => {
    if (hasErrors(issues)) { toast('err', 'Исправьте ошибки: ' + (issues.find((i) => i.level === 'error')?.message ?? '')); return; }
    if (dirty && !(await save(true))) return;
    try {
      const r = await call<{ runId: string }>('workflows.run', { id, input });
      setRunId(r.runId); setBottom('run'); setSelRunNode(null);
    } catch (e) { toast('err', (e as Error).message); }
  };

  const toggleActive = async () => {
    if (!wf) return;
    if (dirty && !(await save(true))) return;
    try { setWf(await call<WorkflowFull>('workflows.setActive', { id, active: !wf.active })); toast('ok', wf.active ? 'Сценарий выключен' : 'Сценарий включён: триггеры работают, пока приложение запущено (в т.ч. в трее)'); }
    catch (e) { toast('err', (e as Error).message); }
  };

  const exportJson = async () => {
    try {
      if (dirty && !(await save(true))) return;
      const data = await call('workflows.export', { id });
      await call('file.saveJson', { defaultName: `${name || 'workflow'}.json`, content: JSON.stringify(data, null, 2) });
    } catch (e) { toast('err', (e as Error).message); }
  };

  const selNode = nodes.find((n) => n.id === selected) ?? null;
  const ctx = { credentials: creds.data ?? [], workflows: wfs.data ?? [], selfId: id, reloadCredentials: creds.reload };
  const grouped = (['trigger', 'logic', 'data', 'flow', 'integration', 'ai'] as NodeCategory[]).map((c) => ({ c, items: NODE_SPECS.filter((s) => s.category === c) }));
  const nodeIssues = selNode ? issues.filter((i) => i.nodeId === selNode.id) : [];

  if (!wf) return <div className="page"><p className="muted">Загрузка…</p></div>;
  return (
    <div className="editor">
      <div className="ed-top">
        <button onClick={onBack}>← Сценарии</button>
        <input className="ed-name" value={name} onChange={(e) => { setName(e.target.value); markDirty(); }} aria-label="Название сценария" />
        <span className={`dirty ${dirty ? 'on' : ''}`}>{dirty ? '● не сохранено' : 'сохранено'}</span>
        <div className="grow" />
        {issues.some((i) => i.level === 'error') ? <span className="badge st-failed" title={issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n')}>Ошибок: {issues.filter((i) => i.level === 'error').length}</span> : <span className="badge st-succeeded">Проверка пройдена</span>}
        <button onClick={() => void save()} disabled={saving || !dirty}>Сохранить</button>
        <button className="primary" onClick={() => void start()}>▶ Запустить</button>
        <button onClick={() => setInputDlg(true)} title="Запустить с входными данными JSON">с данными…</button>
        <button className={wf.active ? 'on-btn' : ''} onClick={toggleActive}>{wf.active ? '● Включён' : '○ Выключен'}</button>
        <button onClick={exportJson}>Экспорт</button>
        <button onClick={() => setBottom(bottom === 'closed' ? 'history' : 'closed')}>История</button>
      </div>
      {draft && (
        <div className="banner">Найдены несохранённые изменения от {fmtTime(new Date(draft.at).toISOString())} (редактор был закрыт). 
          <button className="small" onClick={() => { setName(draft.name); setNodes(draft.definition.nodes.map(toFNode)); setEdges(draft.definition.edges.map(toEdge)); setDirty(true); setDraft(null); }}>Восстановить</button>
          <button className="small" onClick={() => { localStorage.removeItem(`tegra.draft.${id}`); setDraft(null); }}>Отбросить</button></div>
      )}
      <div className="ed-main">
        <aside className="palette">
          <div className="pal-title">Узлы <small className="muted">клик или перетащите</small></div>
          {grouped.map(({ c, items }) => (
            <div key={c}><div className="pal-cat">{CATEGORY_LABELS[c]}</div>
              {items.map((s) => <div key={s.type} className={`pal-item cat-${c}`} draggable title={s.description} onClick={() => addNode(s.type)} onDragStart={(e) => { e.dataTransfer.setData('application/tegra-node', s.type); e.dataTransfer.effectAllowed = 'move'; }}><span>{s.icon}</span>{s.label}</div>)}
            </div>
          ))}
        </aside>
        <div className="canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }} onDrop={(e) => { const t = e.dataTransfer.getData('application/tegra-node'); if (t) { e.preventDefault(); addNode(t, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })); } }}>
          <ReactFlow<FNode, Edge>
            nodes={shownNodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(ch) => { onNodesChange(ch); if (ch.some((c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false))) markDirty(); }}
            onEdgesChange={(ch) => { onEdgesChange(ch); if (ch.some((c) => c.type === 'remove')) markDirty(); }}
            onConnect={onConnect} isValidConnection={isValidConnection}
            onSelectionChange={({ nodes: sel }) => setSelected(sel[0]?.id ?? null)}
            onMoveEnd={(_, vp) => { try { localStorage.setItem(`tegra.vp.${id}`, JSON.stringify(vp)); } catch { /* квота */ } }}
            deleteKeyCode={['Delete', 'Backspace']} fitView={false} minZoom={0.2} maxZoom={1.8} proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ width: 130, height: 80 }} nodeColor={(n) => ((n.data as NodeData).issues ? '#ef4444' : '#6366f1')} />
          </ReactFlow>
          {nodes.length === 0 && <div className="empty-hint">Добавьте узел из панели слева</div>}
        </div>
        <aside className="props">
          {!selNode ? (
            <div>
              <h3>Сценарий</h3>
              {wf.webhooks.length > 0 && <WebhookInfo wf={wf} nodes={nodes} status={status.data} />}
              <h4>Проверка</h4>
              {issues.length === 0 ? <p className="muted">Ошибок нет.</p> : <ul className="issues">{issues.map((i, k) => <li key={k} className={i.level} onClick={() => i.nodeId && (setSelected(i.nodeId), setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === i.nodeId }))))}>{i.level === 'error' ? '⛔' : '⚠'} {i.message}</li>)}</ul>}
              <h4>Правила выполнения</h4>
              <ul className="rules">
                <li>Узел запускается, когда выполнены все входящие связи; ветки без данных пропускаются.</li>
                <li>Несколько связей в один вход — элементы объединяются подряд; для явного слияния используйте «Объединение веток».</li>
                <li>Циклы запрещены. Повторение — узлы «Повторить N раз», «Разделить список».</li>
                <li>Внешние действия (HTTP, Telegram) при повторах могут выполниться более одного раза — для HTTP включите Idempotency-Key.</li>
              </ul>
            </div>
          ) : (
            <div>
              <div className="row"><h3 className="grow">{SPEC_BY_TYPE[selNode.data.type]?.icon} {SPEC_BY_TYPE[selNode.data.type]?.label}</h3>
                <button className="icon-btn" title="Дублировать узел" onClick={() => { const n: FNode = { ...selNode, id: uid(), selected: false, position: { x: selNode.position.x + 40, y: selNode.position.y + 60 }, data: { ...structuredClone(selNode.data), name: uniqueName(selNode.data.name), params: selNode.data.type === 'trigger.webhook' ? { ...selNode.data.params, path: hex(12) } : structuredClone(selNode.data.params) } }; setNodes((ns) => [...ns, n]); markDirty(); }}>⧉</button>
                <button className="icon-btn" title="Удалить узел" onClick={() => { setNodes((ns) => ns.filter((n) => n.id !== selNode.id)); setEdges((es) => es.filter((e) => e.source !== selNode.id && e.target !== selNode.id)); setSelected(null); markDirty(); }}>🗑</button></div>
              <p className="muted">{SPEC_BY_TYPE[selNode.data.type]?.description}</p>
              <label className="field"><span>Название узла</span><input value={selNode.data.name} onChange={(e) => patchNode(selNode.id, (d) => ({ ...d, name: e.target.value }))} /></label>
              {nodeIssues.length > 0 && <ul className="issues">{nodeIssues.map((i, k) => <li key={k} className={i.level}>{i.level === 'error' ? '⛔' : '⚠'} {i.message.replace(`${selNode.data.name}: `, '')}</li>)}</ul>}
              <ParamForm fields={SPEC_BY_TYPE[selNode.data.type]?.params ?? []} params={selNode.data.params} ctx={ctx} onChange={(k, v) => patchNode(selNode.id, (d) => ({ ...d, params: { ...d.params, [k]: v } }))} />
              {selNode.data.type === 'trigger.webhook' && <WebhookInfo wf={wf} nodes={nodes} status={status.data} only={selNode.id} />}
              {selNode.data.type === 'trigger.telegram' && <p className="hint">Сообщения принимаются через long polling: публичный адрес и сервер не нужны. Один бот может принимать сообщения только в одном включённом сценарии. Работает, пока сценарий включён и приложение запущено (в т.ч. в трее).</p>}
              {selNode.data.type === 'trigger.schedule' && <p className="hint">Если компьютер спал или приложение было закрыто, пропущенные запуски обрабатываются по настройке «Пропущенные запуски».</p>}
              {!SPEC_BY_TYPE[selNode.data.type]?.isTrigger && (
                <details><summary>Надёжность узла</summary>
                  <label className="field"><span>Тайм-аут, сек</span><input type="number" min={1} max={3600} value={(selNode.data.settings?.timeoutMs ?? (selNode.data.type === 'ai.agent' ? 300000 : 60000)) / 1000} onChange={(e) => patchNode(selNode.id, (d) => ({ ...d, settings: { ...d.settings, timeoutMs: Math.max(100, Number(e.target.value) * 1000) } }))} /></label>
                  <label className="field"><span>Попыток (1 = без повторов)</span><input type="number" min={1} max={10} value={selNode.data.settings?.maxAttempts ?? 1} onChange={(e) => patchNode(selNode.id, (d) => ({ ...d, settings: { ...d.settings, maxAttempts: Math.min(10, Math.max(1, Number(e.target.value))) } }))} /></label>
                  <label className="field"><span>Задержка между попытками, мс (удваивается)</span><input type="number" min={0} max={300000} value={selNode.data.settings?.retryDelayMs ?? 1000} onChange={(e) => patchNode(selNode.id, (d) => ({ ...d, settings: { ...d.settings, retryDelayMs: Math.max(0, Number(e.target.value)) } }))} /></label>
                  <label className="field"><span>При ошибке</span><select value={selNode.data.settings?.onError ?? 'fail'} onChange={(e) => patchNode(selNode.id, (d) => ({ ...d, settings: { ...d.settings, onError: e.target.value as 'fail' | 'continue' } }))}><option value="fail">Остановить запуск</option><option value="continue">Продолжить, передав ошибку как данные</option></select></label>
                </details>
              )}
              {runStates.get(selNode.id) && <><h4>Последний запуск</h4><NodeRunDetail st={runStates.get(selNode.id)!} nodeName={selNode.data.name} runId={runDetail!.id} /></>}
            </div>
          )}
        </aside>
      </div>
      {bottom !== 'closed' && (
        <div className="ed-bottom">
          <div className="row"><div className="seg"><button className={bottom === 'run' ? 'on' : ''} onClick={() => setBottom('run')}>Текущий запуск</button><button className={bottom === 'history' ? 'on' : ''} onClick={() => setBottom('history')}>История запусков</button></div><div className="grow" /><button className="icon-btn" onClick={() => setBottom('closed')}>✕</button></div>
          {bottom === 'run' && (runDetail ? <RunView run={runDetail} selectedNode={selRunNode} onSelectNode={(nid) => { setSelRunNode(nid); if (nid) { setSelected(nid); setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nid }))); } }} onChanged={() => { run.reload(); history.reload(); }} /> : <p className="muted">Нажмите «Запустить» или выберите запуск в истории.</p>)}
          {bottom === 'history' && (
            <div className="table-wrap"><table className="tbl hover"><thead><tr><th>Статус</th><th>Запуск</th><th>Источник</th><th>Время</th><th>Ошибка</th></tr></thead>
              <tbody>{(history.data ?? []).map((r) => <tr key={r.id} onClick={() => { setRunId(r.id); setBottom('run'); }}><td><StatusBadge status={r.status} /></td><td>{r.id.slice(0, 8)}</td><td>{r.trigger}</td><td>{fmtTime(r.createdAt)}</td><td className="ell">{r.error}</td></tr>)}
                {(history.data ?? []).length === 0 && <tr><td colSpan={5} className="muted">Запусков ещё не было</td></tr>}</tbody></table></div>
          )}
        </div>
      )}
      {inputDlg && (
        <Modal title="Запуск с входными данными" onClose={() => setInputDlg(false)}>
          <p className="muted">JSON-объект или массив объектов. Попадёт в стартовый узел как элементы данных.</p>
          <textarea rows={9} value={inputText} onChange={(e) => setInputText(e.target.value)} spellCheck={false} />
          <div className="row end"><button onClick={() => setInputDlg(false)}>Отмена</button><button className="primary" onClick={() => { try { const v = JSON.parse(inputText); setInputDlg(false); void start(v); } catch { toast('err', 'Некорректный JSON'); } }}>Запустить</button></div>
        </Modal>
      )}
    </div>
  );
}

function WebhookInfo({ wf, nodes, status, only }: { wf: WorkflowFull; nodes: FNode[]; status?: EngineStatus; only?: string }) {
  const hooks = nodes.filter((n) => n.data.type === 'trigger.webhook' && (!only || n.id === only));
  const base = status?.localBaseUrl ?? '';
  return (
    <div className="hint">
      {hooks.map((h) => {
        const url = `${base}/hook/${String(h.data.params.path ?? '')}`;
        const pub = status?.publicBaseUrl ? `${status.publicBaseUrl.replace(/\/+$/, '')}/hook/${String(h.data.params.path ?? '')}` : null;
        return (
          <div key={h.id}>
            <b>{h.data.name}</b>
            <div className="row"><code className="grow">{url}</code><button className="small" onClick={() => copyText(url)}>Копировать</button></div>
            <div className="local-note">🔒 Локальный адрес: доступен только на этом компьютере, из интернета НЕ доступен.</div>
            {pub ? <div className="row"><code className="grow">{pub}</code><button className="small" onClick={() => copyText(pub)}>Копировать</button></div>
              : <div className="muted">Публичного подключения нет. Чтобы принимать запросы извне, настройте свой туннель (например Cloudflare Tunnel) на порт приложения и укажите публичный адрес в «Настройки». Приложение само ничего не открывает в интернет.</div>}
            <div className="muted">Метод {String(h.data.params.method ?? 'POST')}, заголовок <code>X-Webhook-Secret</code>. {wf.active ? 'Сценарий включён.' : 'Сценарий выключен — запросы отклоняются (404).'}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Editor(props: { id: string; onBack: () => void }) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>;
}
export { Json };
