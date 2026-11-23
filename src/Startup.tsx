import { invoke } from '@tauri-apps/api/core';
import { useMemo, useState } from 'react';
import { revealInExplorer, usePolling } from './usePolling';

export interface StartupEntry { id: string; name: string; command: string; path: string | null; source: string; enabled: boolean; scope: string }

export function Startup({ active, search }: { active: boolean; search?: string }) {
  const { data, error, refresh } = usePolling<StartupEntry[]>('list_startup', 10000, active);
  const [query, setQuery] = useState(search ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data ?? []).filter(e => !needle || `${e.name} ${e.command} ${e.source}`.toLowerCase().includes(needle));
  }, [data, query]);

  const toggle = async (e: StartupEntry) => {
    setBusy(e.id); setMessage(null);
    try { await invoke('set_startup_enabled', { id: e.id, enabled: !e.enabled }); setMessage({ ok: true, text: `${e.name} ${e.enabled ? 'disabled' : 'enabled'}. The entry was not deleted and can be switched back.` }); refresh(); }
    catch (err) { setMessage({ ok: false, text: String(err) }); }
    finally { setBusy(null); }
  };

  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">SYSTEM MANAGEMENT</div><h1>Startup</h1><p>Programs registered to run at sign-in via Run keys and Startup folders. Other mechanisms (scheduled tasks, services, Run-Once) are not covered.</p></div><div className="heading-actions"><span className="count-pill">{data ? `${data.filter(e => e.enabled).length} enabled · ${data.length} total` : 'Loading…'}</span></div></div>
    {error && <div className="error-banner" role="alert"><strong>Could not read startup entries.</strong> {error}</div>}
    {message && <div className={message.ok ? 'action-ok' : 'action-error'} role="status">{message.text}</div>}
    <div className="table-toolbar"><label className="search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, command or source" aria-label="Search startup entries" /></label><button className="secondary-button" onClick={refresh}>Refresh</button></div>
    <div className="data-wrap" role="region" aria-label="Startup entries">
      <table className="data-table"><thead><tr><th>Name</th><th>Status</th><th>Source</th><th>Scope</th><th>Command</th><th>Actions</th></tr></thead>
        <tbody>{rows.map(e => <tr key={e.id}><td>{e.name}</td><td><span className={`pill ${e.enabled ? 'ok' : ''}`}>{e.enabled ? 'Enabled' : 'Disabled'}</span></td><td>{e.source}</td><td>{e.scope}</td><td className="cell-long" title={e.command}>{e.command}</td>
          <td><div className="button-row"><button className="secondary-button" disabled={busy === e.id} onClick={() => void toggle(e)}>{e.enabled ? 'Disable' : 'Enable'}</button>{e.path && <button className="secondary-button" onClick={async () => { const err = await revealInExplorer(e.path!); if (err) setMessage({ ok: false, text: err }); }}>Open location</button>}</div></td></tr>)}</tbody></table>
      {data && rows.length === 0 && <div className="empty">No startup entries found.</div>}
      {!data && !error && <div className="empty">Reading startup entries…</div>}
    </div>
    <p className="muted note">Publisher and startup-impact columns are not available yet. The enabled state follows Windows' StartupApproved convention for the current user; it has not yet been verified across a reboot.</p>
  </section>;
}
