import { useState } from 'react';
import { BUILTIN_TOOLS, CRED_TYPE_BY_NAME, type FieldSpec } from '../shared/specs';
import { isFieldVisible } from '../shared/validate';
import type { CredentialInfo } from '../shared/types';
import { call, type WorkflowListItem } from './api';
import { Modal, toast } from './ui';

export interface FormCtx { credentials: CredentialInfo[]; workflows: WorkflowListItem[]; selfId?: string; reloadCredentials: () => void }

export function CredentialDialog({ type, existing, onClose, onSaved }: { type: string; existing?: CredentialInfo; onClose: () => void; onSaved: (id: string) => void }) {
  const spec = CRED_TYPE_BY_NAME[type];
  const [name, setName] = useState(existing?.name ?? spec.label);
  const [vals, setVals] = useState<Record<string, string>>(() => ({ ...Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? ''])), ...(existing?.fields ?? {}) }));
  const [busy, setBusy] = useState(false);
  const gen = (field: string) => setVals((v) => ({ ...v, [field]: [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('') }));
  const save = async () => {
    setBusy(true);
    try {
      const r = existing ? await call<{ id: string }>('credentials.update', { id: existing.id, name, type, data: vals }) : await call<{ id: string }>('credentials.create', { name, type, data: vals });
      toast('ok', 'Подключение сохранено'); onSaved(r.id);
    } catch (e) { toast('err', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={existing ? `Изменить: ${existing.name}` : `Новое подключение: ${spec.label}`} onClose={onClose}>
      <label className="field"><span>Название</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {spec.fields.map((f) => (
        <label key={f.name} className="field">
          <span>{f.label}{f.required && !existing ? ' *' : ''}</span>
          {f.kind === 'select' ? (
            <select value={vals[f.name]} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          ) : (
            <div className="row">
              <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={vals[f.name] ?? ''} placeholder={f.secret && existing?.secretSet[f.name] ? '••••••• (оставьте пустым, чтобы не менять)' : f.placeholder}
                onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
              {type === 'webhookSecret' && <button type="button" onClick={() => gen(f.name)}>Сгенерировать</button>}
            </div>
          )}
        </label>
      ))}
      {type === 'webhookSecret' && <p className="muted">Сохраните значение секрета у себя: после сохранения оно не показывается. Его передают заголовком <code>X-Webhook-Secret</code>.</p>}
      <p className="muted">Секреты шифруются (AES-256-GCM); мастер-ключ защищён средствами Windows (DPAPI) и не покидает этот компьютер.</p>
      <div className="row end"><button onClick={onClose}>Отмена</button><button className="primary" disabled={busy} onClick={save}>Сохранить</button></div>
    </Modal>
  );
}

function Scalar({ f, value, onChange, ctx }: { f: FieldSpec; value: unknown; onChange: (v: unknown) => void; ctx: FormCtx }) {
  const [dlg, setDlg] = useState(false);
  const str = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  switch (f.kind) {
    case 'boolean': return <input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(e.target.checked)} />;
    case 'select': return <select value={str} onChange={(e) => onChange(e.target.value)}>{!f.required && !f.options!.some((o) => o.value === str) && <option value={str}>{str || '—'}</option>}{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
    case 'text': case 'json': return <textarea rows={f.kind === 'json' ? 4 : 3} value={str} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
    case 'number': return <input type="text" inputMode="decimal" value={str} placeholder={f.placeholder} onChange={(e) => { const t = e.target.value; onChange(t.trim() !== '' && !t.includes('{{') && Number.isFinite(Number(t)) ? Number(t) : t); }} />;
    case 'credential': {
      const options = ctx.credentials.filter((c) => c.type === f.credentialType);
      return (
        <div className="row">
          <select className={str && !options.some((c) => c.id === str) ? 'stale' : ''} value={str} onChange={(e) => onChange(e.target.value)}><option value="">— не выбрано —</option>{str && !options.some((c) => c.id === str) && <option value={str}>⚠ подключение удалено — выберите заново</option>}{options.map((c) => <option key={c.id} value={c.id}>{c.name}{c.broken ? ' (не читается)' : ''}</option>)}</select>
          <button type="button" title="Создать подключение" onClick={() => setDlg(true)}>＋</button>
          {dlg && <CredentialDialog type={f.credentialType!} onClose={() => setDlg(false)} onSaved={(id) => { setDlg(false); ctx.reloadCredentials(); onChange(id); }} />}
        </div>
      );
    }
    case 'workflow': return <select value={str} onChange={(e) => onChange(e.target.value)}><option value="">— не выбрано —</option>{ctx.workflows.filter((w) => w.id !== ctx.selfId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>;
    default: return <input type="text" value={str} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }
}

export function Field({ f, params, onChange, ctx }: { f: FieldSpec; params: Record<string, unknown>; onChange: (name: string, v: unknown) => void; ctx: FormCtx }) {
  if (!isFieldVisible(f, params)) return null;
  const value = params[f.name] ?? f.default;
  if (f.kind === 'tools') {
    const sel = new Set((value as string[] | undefined) ?? []);
    const toggle = (id: string) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); onChange(f.name, [...n]); };
    return (
      <div className="field"><span>{f.label}</span>
        <div className="checks">
          {BUILTIN_TOOLS.map((t) => <label key={t.id} title={t.description}><input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} /> {t.label}</label>)}
          {ctx.workflows.filter((w) => w.id !== ctx.selfId).map((w) => <label key={w.id}><input type="checkbox" checked={sel.has(`workflow:${w.id}`)} onChange={() => toggle(`workflow:${w.id}`)} /> Сценарий: {w.name}</label>)}
        </div>
        {f.help && <small className="muted">{f.help}</small>}
      </div>
    );
  }
  if (f.kind === 'list') {
    const rows = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
    const set = (next: Record<string, unknown>[]) => onChange(f.name, next);
    const blank = () => Object.fromEntries((f.itemFields ?? []).map((i) => [i.name, i.default ?? '']));
    return (
      <div className="field"><span>{f.label}{f.required ? ' *' : ''}</span>
        {rows.map((row, ri) => (
          <div key={ri} className="list-row">
            {(f.itemFields ?? []).map((sub) => (
              <div key={sub.name} className="sub"><small>{sub.label}</small>
                <Scalar f={sub} value={row[sub.name]} ctx={ctx} onChange={(v) => set(rows.map((r, i) => (i === ri ? { ...r, [sub.name]: v } : r)))} /></div>
            ))}
            <button className="icon-btn" title="Удалить строку" onClick={() => set(rows.filter((_, i) => i !== ri))}>✕</button>
          </div>
        ))}
        {(!f.maxItems || rows.length < f.maxItems) && <button type="button" className="small" onClick={() => set([...rows, blank()])}>＋ Добавить</button>}
        {f.help && <small className="muted">{f.help}</small>}
      </div>
    );
  }
  return (
    <label className={`field ${f.kind === 'boolean' ? 'inline' : ''}`}>
      <span>{f.label}{f.required ? ' *' : ''}</span>
      <Scalar f={f} value={value} ctx={ctx} onChange={(v) => onChange(f.name, v)} />
      {f.help && <small className="muted">{f.help}</small>}
    </label>
  );
}

export function ParamForm({ fields, params, onChange, ctx }: { fields: FieldSpec[]; params: Record<string, unknown>; onChange: (name: string, v: unknown) => void; ctx: FormCtx }) {
  return <>{fields.map((f) => <Field key={f.name} f={f} params={params} onChange={onChange} ctx={ctx} />)}</>;
}
