import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import type { AlertEvent } from './api';
import { Connections } from './Connections';
import { AlertsPage, HistoryPage } from './HistoryPage';
import { useSnapshot } from './hooks';
import { Overview, ResourceMonitor, System, Users } from './Insights';
import { Performance } from './Performance';
import { Processes, type Page } from './Processes';
import { Services } from './Services';
import { useSettings } from './settings';
import { SettingsPage } from './SettingsPage';
import { Startup } from './Startup';
import { bytes, percent, rate } from './model';

const GROUPS: { label: string; pages: [Page, string][] }[] = [
  { label: 'MONITOR', pages: [['Overview', '◧'], ['Processes', '☰'], ['Performance', '∿'], ['Resource Monitor', '◎']] },
  { label: 'MANAGE', pages: [['Startup', '⏻'], ['Services', '⚙'], ['Users', '☺']] },
  { label: 'INSPECT', pages: [['Network', '⇅'], ['History', '◷'], ['Alerts', '!'], ['System', 'ⓘ']] },
];

function Compact() {
  const { settings, update } = useSettings();
  const { snapshot: s, history: h } = useSnapshot(Math.max(1000, settings.refresh_ms), false);
  if (!s) return <div className="compact"><p className="muted">Waiting…</p></div>;
  const gpu = s.gpu.supported ? Math.max(0, ...s.gpu.live.map(g => g.percent)) : null;
  const mem = s.total_memory ? (s.used_memory / s.total_memory) * 100 : 0;
  const bar = (label: string, v: number | null) => <div className="compact-row"><span>{label}</span><div className="bar"><div style={{ width: `${v ?? 0}%` }} /></div><strong>{v == null ? 'N/A' : percent(v)}</strong></div>;
  return <div className="compact" role="region" aria-label="Compact monitor">
    {bar('CPU', s.cpu_usage)}{bar('RAM', mem)}{bar('GPU', gpu)}
    <div className="compact-row"><span>NET</span><strong>↓ {rate(h.netIn[h.netIn.length - 1])} ↑ {rate(h.netOut[h.netOut.length - 1])}</strong></div>
    <div className="compact-row"><span>MEM</span><strong>{bytes(s.used_memory)} / {bytes(s.total_memory)}</strong></div>
    <button className="secondary-button" onClick={() => update(x => ({ ...x, app: { ...x.app, compact: false } }))}>Exit compact mode</button>
  </div>;
}

export default function App() {
  const { settings } = useSettings();
  const [page, setPage] = useState<Page>('Processes');
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState(300);
  const [focusSearch, setFocusSearch] = useState(0);
  const [toasts, setToasts] = useState<(AlertEvent & { id: number })[]>([]);
  const { snapshot, error, history } = useSnapshot(settings.refresh_ms, paused);

  const navigate = useCallback((p: Page, q?: string) => { setSearch(q); setPage(p); }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let n = 0;
    listen<AlertEvent>('tasklens://alert', e => {
      const id = ++n;
      setToasts(t => [...t.slice(-3), { ...e.payload, id }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 12000);
    }).then(u => { unlisten = u; }, () => undefined);
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setPage('Processes'); setFocusSearch(n => n + 1); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  if (settings.app.compact) return <Compact />;

  const live = snapshot && !error;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l5 5M7 11h2l1.5-3 2 6L14 11h1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></div><div><strong>tasklens</strong><span>system monitor</span></div></div>
      <nav aria-label="Main navigation">
        {GROUPS.map(g => <div key={g.label}><div className="nav-label">{g.label}</div>
          {g.pages.map(([name, icon]) => <button key={name} className={`nav-item${page === name ? ' active' : ''}`} aria-current={page === name ? 'page' : undefined} onClick={() => navigate(name)}><span className="nav-icon" aria-hidden="true">{icon}</span><span>{name}</span></button>)}</div>)}
      </nav>
      <div className="side-spacer" />
      <button className={`nav-item${page === 'Settings' ? ' active' : ''}`} aria-current={page === 'Settings' ? 'page' : undefined} onClick={() => navigate('Settings')}><span className="nav-icon" aria-hidden="true">✲</span><span>Settings</span></button>
      <div className="side-foot"><span className={error ? 'status-dot error-dot' : 'status-dot'} />{error ? 'Collector unavailable' : snapshot ? (paused ? 'Paused' : 'Live monitoring') : 'Connecting…'}<small>v0.1.0</small></div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="breadcrumbs">Workspace <span aria-hidden="true">›</span> <strong>{page}</strong></div>
        <div className="top-right"><span className="live-indicator"><span className={`status-dot ${live ? '' : 'error-dot'}`} /> {live ? (paused ? 'PAUSED' : 'LIVE') : 'OFFLINE'}</span><span className="top-time">{snapshot ? new Date(snapshot.timestamp * 1000).toLocaleTimeString() : '—'}</span></div>
      </header>
      {error && page !== 'Processes' && <div className="error-banner" role="alert"><strong>Monitoring unavailable.</strong> {error}</div>}
      {page === 'Overview' && <Overview snapshot={snapshot} history={history} onNavigate={navigate} />}
      {page === 'Processes' && <Processes snapshot={snapshot} error={error} interval={settings.refresh_ms} onNavigate={navigate} focusSearch={focusSearch} />}
      {page === 'Performance' && <Performance snapshot={snapshot} history={history} intervalMs={settings.refresh_ms} paused={paused} onPause={setPaused} range={range} onRange={setRange} />}
      {page === 'Resource Monitor' && <ResourceMonitor snapshot={snapshot} onNavigate={navigate} />}
      {page === 'Startup' && <Startup active search={search} />}
      {page === 'Services' && <Services active search={search} />}
      {page === 'Users' && <Users snapshot={snapshot} />}
      {page === 'Network' && <Connections active snapshot={snapshot} search={search} />}
      {page === 'History' && <HistoryPage />}
      {page === 'Alerts' && <AlertsPage />}
      {page === 'System' && <System snapshot={snapshot} />}
      {page === 'Settings' && <SettingsPage />}
    </main>
    <div className="toasts" aria-live="assertive">{toasts.map(t => <div key={t.id} className="toast" role="alert"><strong>{t.rule_name || 'Alert'}</strong><span>{t.message}</span><button className="icon-button" aria-label="Dismiss" onClick={() => setToasts(x => x.filter(y => y.id !== t.id))}>✕</button></div>)}</div>
  </div>;
}
