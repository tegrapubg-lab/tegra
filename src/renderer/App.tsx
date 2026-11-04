import { useEffect, useState } from 'react';
import { api } from './api';
import { Editor } from './Editor';
import { ApprovalsPage, CredentialsPage, ExamplesPage, RunsPage, SettingsPage, WorkflowsPage } from './pages';
import { Toasts, toast, usePoll } from './ui';

type Page = 'workflows' | 'runs' | 'approvals' | 'credentials' | 'examples' | 'settings';
interface Nav { page: Page; workflowId: string | null }

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'workflows', label: 'Сценарии', icon: '◫' }, { id: 'runs', label: 'Запуски', icon: '☰' }, { id: 'approvals', label: 'Подтверждения', icon: '✋' },
  { id: 'credentials', label: 'Подключения', icon: '🔑' }, { id: 'examples', label: 'Примеры', icon: '✦' }, { id: 'settings', label: 'Настройки', icon: '⚙' },
];

function loadNav(): Nav { try { const n = JSON.parse(localStorage.getItem('tegra.nav') ?? 'null'); if (n && NAV.some((x) => x.id === n.page)) return n; } catch { /* нет сохранённого */ } return { page: 'workflows', workflowId: null }; }

export default function App() {
  const [nav, setNav] = useState<Nav>(loadNav);
  useEffect(() => { try { localStorage.setItem('tegra.nav', JSON.stringify(nav)); } catch { /* квота */ } }, [nav]);
  useEffect(() => window.tegra.onEvent((e) => { if (e.type === 'engine-restarted') toast('info', 'Фоновый движок был перезапущен — незавершённые запуски продолжены автоматически'); }), []);
  const approvals = usePoll(api.approvals, 3000, []);
  const go = (page: Page) => setNav({ page, workflowId: null });
  const openWf = (id: string) => setNav({ page: 'workflows', workflowId: id });

  return (
    <div className="app">
      <nav className="side">
        <div className="brand"><span className="logo">◉</span> Tegra Flow</div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${nav.page === n.id ? 'on' : ''}`} onClick={() => go(n.id)}>
            <span>{n.icon}</span>{n.label}{n.id === 'approvals' && (approvals.data?.length ?? 0) > 0 && <span className="pill">{approvals.data!.length}</span>}
          </button>
        ))}
        <div className="grow" />
        <div className="side-foot">Локальный режим · данные только на этом ПК</div>
      </nav>
      <main className="content">
        {nav.page === 'workflows' && (nav.workflowId ? <Editor key={nav.workflowId} id={nav.workflowId} onBack={() => setNav({ page: 'workflows', workflowId: null })} /> : <WorkflowsPage open={openWf} />)}
        {nav.page === 'runs' && <RunsPage />}
        {nav.page === 'approvals' && <ApprovalsPage />}
        {nav.page === 'credentials' && <CredentialsPage />}
        {nav.page === 'examples' && <ExamplesPage open={openWf} />}
        {nav.page === 'settings' && <SettingsPage />}
      </main>
      <Toasts />
    </div>
  );
}
