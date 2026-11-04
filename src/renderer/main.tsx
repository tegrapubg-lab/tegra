import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return <div style={{ padding: 32 }}><h2>Что-то пошло не так в интерфейсе</h2><pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.err.message}</pre><button onClick={() => location.reload()}>Перезагрузить окно</button><p>Данные и сценарии не затронуты — они хранятся в фоновом движке.</p></div>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<StrictMode><Boundary><App /></Boundary></StrictMode>);
