import { useState } from 'react';
import { CREDENTIAL_TYPES } from '../shared/specs';
import type { CredentialInfo } from '../shared/types';
import { api, call, fmtTime, type ExampleInfo, type InstallResult, type Settings } from './api';
import { CredentialDialog } from './ParamForm';
import { RunView } from './RunView';
import { Confirm, Modal, StatusBadge, copyText, toast, usePoll } from './ui';

// ---------- Сценарии ----------
export function WorkflowsPage({ open }: { open: (id: string) => void }) {
  const list = usePoll(api.workflows, 3000, []);
  const status = usePoll(api.status, 4000, []);
  const [del, setDel] = useState<{ id: string; name: string } | null>(null);
  const create = async () => { try { const w = await call<{ id: string }>('workflows.create', { name: 'Новый сценарий' }); open(w.id); } catch (e) { toast('err', (e as Error).message); } };
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast('ok', ok); list.reload(); } catch (e) { toast('err', (e as Error).message); } };
  const importFile = async () => {
    try {
      const r = await call<{ opened: boolean; content?: string }>('file.openJson');
      if (!r.opened) return;
      const w = await call<{ id: string }>('workflows.import', { data: JSON.parse(r.content!) });
      toast('ok', 'Сценарий импортирован. Выберите подключения в узлах — секреты не переносятся.'); open(w.id);
    } catch (e) { toast('err', (e as Error).message); }
  };
  const exportOne = (id: string, name: string) => act(async () => {
    const data = await call('workflows.export', { id });
    await call('file.saveJson', { defaultName: `${name}.json`, content: JSON.stringify(data, null, 2) });
  });
  const s = status.data;
  return (
    <div className="page">
      <div className="row"><h2 className="grow">Сценарии</h2><button onClick={importFile}>Импорт JSON</button><button className="primary" onClick={create}>＋ Новый сценарий</button></div>
      {s && <div className="statline">
        <span>Движок работает</span><span>Включено сценариев: <b>{s.activeWorkflows}</b></span><span>Выполняется: <b>{s.runsActive}</b></span><span>Ожидают: <b>{s.waitingRuns}</b></span><span>Расписаний: <b>{s.schedules}</b></span>
        {s.pollers.map((p) => <span key={p.tokenHash} className={p.lastError ? 'bad' : ''} title={p.lastError ?? ''}>Telegram «{p.credentialName}»: {p.lastError ? 'ошибка' : 'слушаем'}</span>)}
      </div>}
      {list.error && <div className="errbox">{list.error}</div>}
      {(list.data ?? []).length === 0 && list.data && (
        <div className="empty"><p>Сценариев пока нет.</p><p className="muted">Создайте сценарий или установите готовый пример на вкладке «Примеры» — например, «Одежда → ИИ-агенты → подтверждение → Telegram».</p></div>
      )}
      <div className="cards">
        {(list.data ?? []).map((w) => (
          <div key={w.id} className="card">
            <div className="row"><b className="grow ell" title={w.name}>{w.name}</b>{w.active && <span className="badge st-succeeded">включён</span>}</div>
            <div className="muted">Узлов: {w.nodeCount} · изменён {fmtTime(w.updatedAt)}</div>
            <div className="muted">Последний запуск: {w.lastRun ? <><StatusBadge status={w.lastRun.status} /> {fmtTime(w.lastRun.at)}</> : 'не было'}</div>
            <div className="row wrap">
              <button className="primary" onClick={() => open(w.id)}>Открыть</button>
              <button onClick={() => act(async () => { await call('workflows.run', { id: w.id }); }, 'Запущено — смотрите во вкладке «Запуски»')}>▶ Запустить</button>
              <button onClick={() => act(() => call('workflows.duplicate', { id: w.id }), 'Копия создана')}>Дублировать</button>
              <button onClick={() => exportOne(w.id, w.name)}>Экспорт</button>
              <button className="danger" onClick={() => setDel({ id: w.id, name: w.name })}>Удалить</button>
            </div>
          </div>
        ))}
      </div>
      {del && <Confirm text={`Удалить сценарий «${del.name}»? История его запусков останется.`} yes="Удалить" onNo={() => setDel(null)} onYes={() => { const d = del; setDel(null); void act(() => call('workflows.delete', { id: d.id }), 'Удалено'); }} />}
    </div>
  );
}

// ---------- Запуски ----------
export function RunsPage() {
  const [wfFilter, setWfFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const wfs = usePoll(api.workflows, 10000, []);
  const runs = usePoll(() => api.runs(wfFilter || undefined, 100), 1500, [wfFilter]);
  const detail = usePoll(() => (sel ? api.run(sel) : Promise.resolve(null)), 800, [sel], !!sel);
  return (
    <div className="page split">
      <div className="left">
        <div className="row"><h2 className="grow">Запуски</h2>
          <select value={wfFilter} onChange={(e) => setWfFilter(e.target.value)}><option value="">Все сценарии</option>{(wfs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
        <div className="table-wrap"><table className="tbl hover"><thead><tr><th>Статус</th><th>Сценарий</th><th>Источник</th><th>Создан</th></tr></thead>
          <tbody>{(runs.data ?? []).map((r) => <tr key={r.id} className={sel === r.id ? 'sel' : ''} onClick={() => setSel(r.id)}><td><StatusBadge status={r.status} /></td><td className="ell">{r.workflowName}</td><td>{r.trigger}</td><td>{fmtTime(r.createdAt)}</td></tr>)}
            {(runs.data ?? []).length === 0 && <tr><td colSpan={4} className="muted">Запусков ещё не было</td></tr>}</tbody></table></div>
      </div>
      <div className="right">{detail.data ? <RunView run={detail.data} onChanged={() => { runs.reload(); detail.reload(); }} /> : <p className="muted">Выберите запуск слева, чтобы увидеть входные и выходные данные каждого шага.</p>}</div>
    </div>
  );
}

// ---------- Подтверждения ----------
export function ApprovalsPage() {
  const list = usePoll(api.approvals, 1500, []);
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = async (a: { runId: string; nodeId: string }, d: 'approved' | 'rejected') => {
    try { await call('approvals.decide', { id: a.runId, nodeId: a.nodeId, decision: d, comment: comments[a.runId + a.nodeId] ?? '' }); toast('ok', d === 'approved' ? 'Продолжено' : 'Отклонено'); list.reload(); }
    catch (e) { toast('err', (e as Error).message); list.reload(); }
  };
  return (
    <div className="page">
      <h2>Подтверждения</h2>
      <p className="muted">Запуски, остановленные в узле «Ждать решения пользователя». Состояние сохранено в базе: можно закрыть приложение и решить позже.</p>
      {(list.data ?? []).length === 0 && <div className="empty">Нет запусков, ожидающих решения.</div>}
      <div className="cards">
        {(list.data ?? []).map((a) => {
          const k = a.runId + a.nodeId;
          return (
            <div key={k} className="card wide">
              <div className="row"><b className="grow">{a.workflowName}</b><span className="muted">с {fmtTime(a.since)}</span></div>
              <div className="approval-msg">✋ {a.message}</div>
              {a.timeoutAt && <div className="muted">Если не ответить, решение по умолчанию будет принято {fmtTime(a.timeoutAt)}</div>}
              <details open><summary>Данные ({a.itemsPreview.length})</summary>
                {a.itemsPreview.map((it, i) => <div key={i} className="kv">{Object.entries(it.json).filter(([key]) => !['agent', 'ai'].includes(key)).map(([key, v]) => <div key={key}><b>{key}:</b> <span className="pre">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>)}</div>)}</details>
              <input placeholder="Комментарий (необязательно)" value={comments[k] ?? ''} onChange={(e) => setComments({ ...comments, [k]: e.target.value })} />
              <div className="row"><button className="primary" onClick={() => decide(a, 'approved')}>Продолжить</button><button className="danger" onClick={() => decide(a, 'rejected')}>Отклонить</button></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Подключения ----------
export function CredentialsPage() {
  const list = usePoll(api.credentials, 5000, []);
  const [dlg, setDlg] = useState<{ type: string; existing?: CredentialInfo } | null>(null);
  const [pick, setPick] = useState(false);
  const [del, setDel] = useState<CredentialInfo | null>(null);
  return (
    <div className="page">
      <div className="row"><h2 className="grow">Подключения и ключи</h2><button className="primary" onClick={() => setPick(true)}>＋ Добавить</button></div>
      <p className="muted">API-ключи и токены вводятся только здесь. Они шифруются на диске, не попадают в экспорт сценариев, журналы и историю запусков.</p>
      {(list.data ?? []).length === 0 && <div className="empty">Подключений нет. Добавьте Telegram-бота или провайдера ИИ (есть «Демо» без ключа).</div>}
      <table className="tbl"><thead><tr><th>Название</th><th>Тип</th><th>Параметры</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((c) => (
          <tr key={c.id}><td>{c.name}{c.broken && <span className="badge st-failed" title="Данные созданы на другом компьютере или профиле — введите секреты заново">не читается</span>}</td>
            <td>{CREDENTIAL_TYPES.find((t) => t.type === c.type)?.label ?? c.type}</td>
            <td className="muted">{Object.entries(c.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')} {Object.entries(c.secretSet).map(([k, v]) => `${k}: ${v ? '••••' : '—'}`).join(' · ')}</td>
            <td className="row end"><button onClick={() => setDlg({ type: c.type, existing: c })}>Изменить</button><button className="danger" onClick={() => setDel(c)}>Удалить</button></td></tr>))}</tbody></table>
      {pick && <Modal title="Тип подключения" onClose={() => setPick(false)}><div className="col">{CREDENTIAL_TYPES.map((t) => <button key={t.type} onClick={() => { setPick(false); setDlg({ type: t.type }); }}>{t.label}</button>)}</div></Modal>}
      {dlg && <CredentialDialog type={dlg.type} existing={dlg.existing} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); list.reload(); }} />}
      {del && <Confirm text={`Удалить подключение «${del.name}»? Узлы, которые его используют, перестанут работать.`} yes="Удалить" onNo={() => setDel(null)} onYes={async () => { const d = del; setDel(null); try { await call('credentials.delete', { id: d.id }); list.reload(); } catch (e) { toast('err', (e as Error).message); } }} />}
    </div>
  );
}

// ---------- Примеры ----------
export function ExamplesPage({ open }: { open: (id: string) => void }) {
  const list = usePoll(() => call<ExampleInfo[]>('examples.list'), 60_000, []);
  const [res, setRes] = useState<InstallResult | null>(null);
  const install = async (id: string) => { try { setRes(await call<InstallResult>('examples.install', { id })); } catch (e) { toast('err', (e as Error).message); } };
  return (
    <div className="page">
      <h2>Примеры сценариев</h2>
      <div className="cards">
        {(list.data ?? []).map((e) => (
          <div key={e.id} className="card wide"><b>{e.title}</b><p>{e.description}</p>
            {e.requires.length > 0 && <p className="muted">Потребуется: {e.requires.join('; ')}</p>}
            <div className="row"><button className="primary" onClick={() => install(e.id)}>Установить пример</button></div></div>
        ))}
      </div>
      {res && (
        <Modal title={`Установлено: ${res.workflow.name}`} onClose={() => setRes(null)}>
          {res.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
          {res.secrets.map((s) => <div key={s.name}><p><b>{s.name}</b> (показывается один раз — сохраните):</p><div className="row"><code className="grow">{s.value}</code><button className="small" onClick={() => copyText(s.value)}>Копировать</button></div></div>)}
          <div className="row end"><button onClick={() => setRes(null)}>Закрыть</button><button className="primary" onClick={() => { const id = res.workflow.id; setRes(null); open(id); }}>Открыть сценарий</button></div>
        </Modal>
      )}
    </div>
  );
}

// ---------- Настройки ----------
export function SettingsPage() {
  const info = usePoll(api.info, 10_000, []);
  const st = usePoll(() => call<Settings>('settings.get'), 30_000, []);
  const status = usePoll(api.status, 5000, []);
  const [form, setForm] = useState<Partial<Settings>>({});
  const [quit, setQuit] = useState(false);
  const merged = { ...st.data, ...form } as Settings;
  const saveSettings = async () => {
    try { await call('settings.set', form); setForm({}); st.reload(); toast('ok', 'Настройки сохранены'); } catch (e) { toast('err', (e as Error).message); }
  };
  const i = info.data;
  const run = async (fn: () => Promise<any>, okText: string) => { try { const r = await fn(); if (r && (r.saved === false || r.restored === false)) return; toast('ok', okText); info.reload(); } catch (e) { toast('err', (e as Error).message); } };
  return (
    <div className="page narrow">
      <h2>Настройки</h2>
      <section className="panel"><h3>Приложение</h3>
        <label className="field inline"><input type="checkbox" checked={!!i?.autostart} onChange={(e) => run(() => call('app.setAutostart', { value: e.target.checked }), e.target.checked ? 'Автозапуск включён (приложение стартует свёрнутым в трей)' : 'Автозапуск выключен')} /><span>Запускать при входе в Windows (свёрнутым в трей)</span></label>
        <label className="field inline"><input type="checkbox" checked={!!i?.closeToTray} onChange={(e) => run(() => call('app.setCloseToTray', { value: e.target.checked }), 'Сохранено')} /><span>Кнопка «закрыть окно» сворачивает в трей (автоматизация продолжает работать)</span></label>
        <p className="hint">Закрытие окна ≠ выход. Пока значок в трее, активные сценарии, расписания, webhook и Telegram работают. «Выйти полностью» останавливает всю автоматизацию.</p>
        <button className="danger" onClick={() => setQuit(true)}>Выйти полностью…</button>
        {i && <p className="muted">Версия {i.version} · {i.platform} · данные: <code>{i.dataDir}</code> <button className="small" onClick={() => call('app.openDataDir')}>Открыть папку</button></p>}
        {i && <p className={i.safeStorage ? 'muted' : 'errbox'}>{i.safeStorage ? '🔒 Мастер-ключ шифрования защищён средствами ОС (Windows DPAPI).' : '⚠ Защита ключа средствами ОС недоступна: ключ хранится в файле профиля пользователя.'}</p>}
      </section>
      <section className="panel"><h3>Движок</h3>
        <label className="field"><span>Одновременных запусков</span><input type="number" min={1} max={32} value={merged.maxConcurrentRuns ?? 4} onChange={(e) => setForm({ ...form, maxConcurrentRuns: Number(e.target.value) })} /></label>
        <label className="field"><span>Параллельных узлов в одном запуске</span><input type="number" min={1} max={16} value={merged.nodeParallelism ?? 4} onChange={(e) => setForm({ ...form, nodeParallelism: Number(e.target.value) })} /></label>
        <label className="field"><span>Хранить историю запусков, дней</span><input type="number" min={1} max={3650} value={merged.runRetentionDays ?? 30} onChange={(e) => setForm({ ...form, runRetentionDays: Number(e.target.value) })} /></label>
        <label className="field"><span>Публичный адрес webhook (необязательно)</span><input placeholder="https://my-tunnel.example.com" value={merged.publicBaseUrl ?? ''} onChange={(e) => setForm({ ...form, publicBaseUrl: e.target.value })} /></label>
        <p className="hint">Локальный адрес webhook {status.data?.localBaseUrl ?? ''} доступен <b>только на этом компьютере</b>. Для приёма запросов из интернета настройте собственный туннель (Cloudflare Tunnel, ngrok и т.п.) на этот порт и впишите его адрес сюда — он будет показан в узле Webhook. Приложение само ничего не публикует.</p>
        <button className="primary" disabled={Object.keys(form).length === 0} onClick={saveSettings}>Сохранить</button>
      </section>
      <section className="panel"><h3>Резервные копии</h3>
        <p className="muted">Копия включает сценарии, историю и подключения (секреты остаются зашифрованными). Автокопия делается раз в сутки в папку backups (хранятся последние 7). Секреты читаются только на этом компьютере и в этом профиле Windows.</p>
        <div className="row"><button onClick={() => run(() => call('backup.create'), 'Копия сохранена')}>Создать копию…</button><button onClick={() => run(() => call('backup.restore'), 'Данные восстановлены')}>Восстановить из копии…</button></div>
      </section>
      {quit && <Confirm text="Выйти полностью? Автоматизация (расписания, webhook, Telegram) будет остановлена до следующего запуска приложения." yes="Выйти" onNo={() => setQuit(false)} onYes={() => { setQuit(false); void call('app.quit'); }} />}
    </div>
  );
}
