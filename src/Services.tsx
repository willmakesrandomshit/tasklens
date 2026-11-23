import { invoke } from '@tauri-apps/api/core';
import { useMemo, useState } from 'react';
import { compareValues, revealInExplorer, usePolling, type SortDir } from './usePolling';

export interface ServiceInfo {
  name: string; display_name: string; description: string | null; state: string; start_type: string;
  pid: number | null; path: string | null; account: string | null; dependencies: string[]; can_stop: boolean; protected: boolean;
}
type Key = 'display_name' | 'name' | 'state' | 'start_type' | 'pid';
type Action = 'start' | 'stop' | 'restart';

export function Services({ active, search }: { active: boolean; search?: string }) {
  const { data, error, refresh } = usePolling<ServiceInfo[]>('list_services', 5000, active);
  const [query, setQuery] = useState(search ?? '');
  const [stateFilter, setStateFilter] = useState('All');
  const [sort, setSort] = useState<Key>('display_name');
  const [dir, setDir] = useState<SortDir>('asc');
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (data ?? []).filter(s =>
      (stateFilter === 'All' || s.state === stateFilter) &&
      (!needle || `${s.name} ${s.display_name} ${s.description ?? ''} ${s.pid ?? ''}`.toLowerCase().includes(needle)));
    const sign = dir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => sign * compareValues(a[sort], b[sort]) || a.name.localeCompare(b.name));
  }, [data, query, stateFilter, sort, dir]);
  const current = data?.find(s => s.name === selected) ?? null;
  const header = (key: Key, label: string) => <th><button className="column-button" onClick={() => { if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDir('asc'); } }} aria-label={`Sort by ${label}`}>{label}{sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>;

  const run = async (action: Action) => {
    if (!current) return;
    setBusy(true); setMessage(null);
    try { await invoke('control_service', { name: current.name, action }); setMessage({ ok: true, text: `${current.display_name}: ${action} completed.` }); refresh(); }
    catch (e) { setMessage({ ok: false, text: String(e) }); }
    finally { setBusy(false); setConfirm(null); }
  };
  const why = (action: Action): string | null => {
    if (!current) return 'Select a service first';
    if (action === 'start') return current.state === 'Running' ? 'Already running' : current.start_type === 'Disabled' ? 'Disabled services cannot be started' : null;
    if (current.protected) return 'Core Windows/security service: TaskLens will not stop it';
    if (current.state !== 'Running') return 'Not running';
    return current.can_stop ? null : 'This service does not accept stop requests';
  };
  const button = (action: Action, label: string, danger: boolean) => {
    const reason = why(action);
    return <button className={danger ? 'danger-button' : 'secondary-button'} disabled={!!reason || busy} title={reason ?? label} onClick={() => danger ? setConfirm(action) : void run(action)}>{label}</button>;
  };

  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">SYSTEM MANAGEMENT</div><h1>Services</h1><p>Windows services from the Service Control Manager. Starting and stopping usually needs administrator rights.</p></div><div className="heading-actions"><span className="count-pill">{data ? `${rows.length} of ${data.length}` : 'Loading…'}</span></div></div>
    {error && <div className="error-banner" role="alert"><strong>Could not read services.</strong> {error}</div>}
    <div className="table-toolbar">
      <label className="search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, display name or description" aria-label="Search services" /></label>
      <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} aria-label="Filter by state"><option>All</option><option>Running</option><option>Stopped</option><option>Starting</option><option>Stopping</option><option>Paused</option></select>
      <button className="secondary-button" onClick={refresh}>Refresh</button>
    </div>
    <div className="split">
      <div className="data-wrap" role="region" aria-label="Services table">
        <table className="data-table"><thead><tr>{header('display_name', 'Display name')}{header('name', 'Name')}{header('state', 'Status')}{header('start_type', 'Startup')}{header('pid', 'PID')}</tr></thead>
          <tbody>{rows.map(s => <tr key={s.name} className={s.name === selected ? 'selected' : ''} onClick={() => { setSelected(s.name); setMessage(null); setConfirm(null); }} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(s.name); } }} aria-selected={s.name === selected}>
            <td title={s.description ?? ''}>{s.display_name}</td><td>{s.name}</td><td><span className={`pill ${s.state === 'Running' ? 'ok' : ''}`}>{s.state}</span></td><td>{s.start_type}</td><td>{s.pid ?? '—'}</td></tr>)}</tbody></table>
        {data && rows.length === 0 && <div className="empty">No services match.</div>}
        {!data && !error && <div className="empty">Reading services…</div>}
      </div>
      <aside className="detail-panel" aria-label="Service details">
        {current ? <>
          <h2>{current.display_name}</h2><p className="muted">{current.name}</p>
          <p>{current.description ?? 'No description available.'}</p>
          <div className="detail-list">
            <div><span>Status</span><strong>{current.state}</strong></div>
            <div><span>Startup type</span><strong>{current.start_type}</strong></div>
            <div><span>Process ID</span><strong>{current.pid ?? '—'}</strong></div>
            <div><span>Account</span><strong>{current.account ?? 'Unavailable'}</strong></div>
            <div className="detail-long"><span>Executable</span><strong>{current.path ?? 'Unavailable'}</strong></div>
            <div className="detail-long"><span>Depends on</span><strong>{current.dependencies.length ? current.dependencies.join(', ') : 'Nothing'}</strong></div>
          </div>
          <div className="button-row">{button('start', 'Start', false)}{button('stop', 'Stop', true)}{button('restart', 'Restart', true)}
            {current.path && <button className="secondary-button" onClick={async () => { const exe = current.path!.replace(/^"([^"]+)".*$/, '$1').replace(/^([^"]+?\.exe)\b.*$/i, '$1'); const err = await revealInExplorer(exe); if (err) setMessage({ ok: false, text: err }); }}>Open file location</button>}</div>
          {confirm && <div className="confirm-bar" role="alertdialog" aria-label="Confirm service action"><p>{confirm === 'stop' ? 'Stop' : 'Restart'} <strong>{current.display_name}</strong>? Programs that depend on it may stop working.</p><div className="button-row"><button className="secondary-button" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button><button className="danger-button" onClick={() => void run(confirm)} disabled={busy}>{busy ? 'Working…' : confirm === 'stop' ? 'Stop service' : 'Restart service'}</button></div></div>}
          {message && <div className={message.ok ? 'action-ok' : 'action-error'} role="status">{message.text}</div>}
        </> : <div className="empty">Select a service to see its details.</div>}
      </aside>
    </div>
  </section>;
}
