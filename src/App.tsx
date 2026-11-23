import { invoke } from '@tauri-apps/api/core';
import { Activity, ArrowDown, ArrowUp, ChartNoAxesCombined, ChevronRight, CircleHelp, Clock3, Cpu, HardDrive, List, MonitorCog, Network, Search, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bytes, selectProcesses, type ProcessInfo, type Snapshot, type SortKey } from './model';
import { visibleRange } from './viewport';

type Page = 'Processes' | 'Performance' | 'Startup' | 'Services' | 'Network' | 'History' | 'Settings';
type Theme = 'system' | 'dark' | 'light';
const navigation: { name: Page; icon: typeof List }[] = [
  { name: 'Processes', icon: List }, { name: 'Performance', icon: Activity },
  { name: 'Startup', icon: MonitorCog }, { name: 'Services', icon: Settings },
  { name: 'Network', icon: Network }, { name: 'History', icon: Clock3 }, { name: 'Settings', icon: Settings },
];
const ROW_HEIGHT = 38;
function readSetting<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key); return allowed.includes(value as T) ? value as T : fallback; } catch { return fallback; }
}
function Graph({ values, color, max = 100 }: { values: number[]; color: string; max?: number }) {
  const points = values.map((n, index) => `${(index / 59) * 100},${100 - Math.max(0, Math.min(100, n / max * 100))}`).join(' ');
  return <svg className="graph" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Recent readings graph"><path d="M0 25H100 M0 50H100 M0 75H100 M25 0V100 M50 0V100 M75 0V100" className="grid"/><polyline points={points} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" /></svg>;
}
function percent(n: number) { return `${n.toFixed(1)}%`; }

export default function App() {
  const [page, setPage] = useState<Page>('Processes');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('cpu_usage');
  const [ascending, setAscending] = useState(false);
  const [selected, setSelected] = useState<{ pid: number; identity: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ProcessInfo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => readSetting('tasklens.theme', ['system', 'dark', 'light'], 'system'));
  const [interval, setIntervalValue] = useState(() => readSetting('tasklens.interval', ['1000', '2000', '5000'], '2000'));
  const [scrollTop, setScrollTop] = useState(0);
  const [tableHeight, setTableHeight] = useState(500);
  const [history, setHistory] = useState<{ cpu: number[]; memory: number[] }>({ cpu: [], memory: [] });
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('tasklens.theme', theme); } catch { /* storage can be disabled */ }
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('tasklens.interval', interval); } catch { /* storage can be disabled */ } }, [interval]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await invoke<Snapshot>('snapshot');
        if (!active) return;
        setSnapshot(data); setError(null);
        setHistory(h => ({ cpu: [...h.cpu, data.cpu_usage].slice(-60), memory: [...h.memory, data.total_memory ? data.used_memory / data.total_memory * 100 : 0].slice(-60) }));
      } catch (e) { if (active) setError(String(e)); }
      if (active) timer = setTimeout(poll, Number(interval));
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [interval]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); setPage('Processes'); requestAnimationFrame(() => searchRef.current?.focus()); }
      if (event.key === 'Escape') { setConfirm(null); setSelected(null); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const element = tableRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTableHeight(element.clientHeight));
    observer.observe(element); setTableHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [page]);
  const processes = useMemo(() => selectProcesses(snapshot?.processes ?? [], query, sort, ascending), [snapshot, query, sort, ascending]);
  const current = snapshot?.processes.find(p => p.pid === selected?.pid && p.identity === selected.identity) ?? null;
  const { first, last } = visibleRange(processes.length, scrollTop, tableHeight, ROW_HEIGHT);
  const changeSort = (key: SortKey) => { if (key === sort) setAscending(!ascending); else { setSort(key); setAscending(key === 'name'); } };
  const terminate = useCallback(async () => {
    if (!confirm) return;
    setBusy(true); setActionError(null);
    try { await invoke('terminate_process', { pid: confirm.pid, identity: confirm.identity }); setConfirm(null); setSelected(null); }
    catch (e) { setActionError(String(e)); }
    finally { setBusy(false); }
  }, [confirm]);

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><ChartNoAxesCombined size={19}/></div><div><strong>tasklens</strong><span>system monitor</span></div></div>
      <div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${page === name ? 'active' : ''}`} onClick={() => setPage(name)}><Icon size={17}/><span>{name}</span>{page === name && <ChevronRight size={14}/>}</button>)}</nav>
      <div className="side-foot"><span className={error ? 'status-dot error-dot' : 'status-dot'}/>{error ? 'Collector unavailable' : snapshot ? 'Live monitoring' : 'Connecting…'}<small>v0.1.0</small></div>
    </aside>
    <main className="main"><header className="topbar"><div className="breadcrumbs">Workspace <ChevronRight size={13}/> <strong>{page}</strong></div><div className="top-right"><span className="live-indicator"><span className={`status-dot ${snapshot && !error ? '' : 'error-dot'}`}/> {snapshot && !error ? 'LIVE' : 'OFFLINE'}</span><span className="top-time">{snapshot ? new Date(snapshot.timestamp * 1000).toLocaleTimeString() : '—'}</span></div></header>
      {error && <div className="error-banner" role="alert"><strong>Monitoring unavailable.</strong> {error} <span>Run TaskLens as a desktop application to connect to its native collector.</span></div>}
      {page === 'Processes' && <section className="page process-page"><div className="page-heading"><div><div className="eyebrow">SYSTEM OVERVIEW</div><h1>Processes</h1><p>See what's running and where your resources are going.</p></div><div className="heading-actions"><span className="count-pill">{snapshot ? `${snapshot.processes.length} processes` : 'Awaiting data'}</span></div></div>
        <div className="summary-strip"><div><span>CPU</span><strong>{snapshot ? percent(snapshot.cpu_usage) : '—'}</strong><small>overall utilization</small></div><div><span>MEMORY</span><strong>{snapshot && snapshot.total_memory ? percent(snapshot.used_memory / snapshot.total_memory * 100) : '—'}</strong><small>{snapshot ? `${bytes(snapshot.used_memory)} in use` : 'awaiting data'}</small></div><div><span>PROCESSES</span><strong>{snapshot?.processes.length ?? '—'}</strong><small>currently running</small></div><div className="summary-note"><Cpu size={18}/><span>{snapshot?.cpu_model || 'System information unavailable'}</span></div></div>
        <div className="table-toolbar"><label className="search"><Search size={16}/><input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setScrollTop(0); if (tableRef.current) tableRef.current.scrollTop = 0; }} placeholder="Search name, PID, or path" aria-label="Search processes"/><kbd>Ctrl F</kbd></label><span className="muted">{processes.length} shown</span></div>
        <div className="table-wrap"><div className="table-head row"><button className="column-button" onClick={() => changeSort('name')}>PROCESS {sort === 'name' && (ascending ? <ArrowUp size={12}/> : <ArrowDown size={12}/>)}</button>{(['pid','cpu_usage','memory'] as SortKey[]).map(key => <button key={key} className="column-button" onClick={() => changeSort(key)}>{key === 'pid' ? 'PID' : key === 'cpu_usage' ? 'CPU' : 'MEMORY'} {sort === key && (ascending ? <ArrowUp size={12}/> : <ArrowDown size={12}/>)}</button>)}<span>STATUS</span></div>
          <div className="table-scroll" ref={tableRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} role="table" aria-label="Running processes"><div style={{ height: processes.length * ROW_HEIGHT, position: 'relative' }}>{processes.slice(first, last).map((p, i) => <button className={`process-row row ${current?.pid === p.pid && current.identity === p.identity ? 'selected' : ''}`} key={`${p.pid}-${p.identity ?? p.start_time}`} style={{ top: (first + i) * ROW_HEIGHT }} onClick={() => setSelected({ pid: p.pid, identity: p.identity })}><span className="process-name"><span className="process-icon">{p.name[0]?.toUpperCase() || '?'}</span><span title={p.name}>{p.name}</span></span><span>{p.pid}</span><span>{percent(p.cpu_usage)}</span><span>{bytes(p.memory)}</span><span className="process-status">{p.status}</span></button>)}</div>{snapshot && processes.length === 0 && <div className="empty">No processes match your search.</div>}</div>
          <div className="table-footer"><span>Click a process to inspect it</span><span>Updated every {Number(interval) / 1000}s</span></div></div>
      </section>}
      {page === 'Performance' && <section className="page performance-page"><div className="page-heading"><div><div className="eyebrow">SYSTEM OVERVIEW</div><h1>Performance</h1><p>Live resource usage on this device.</p></div></div><div className="performance-grid"><article className="metric"><div className="metric-head"><div><span>PROCESSOR</span><h2>CPU</h2></div><strong>{snapshot ? percent(snapshot.cpu_usage) : '—'}</strong></div><Graph values={history.cpu} color="var(--accent)"/><div className="metric-meta"><span>{snapshot?.cpu_model || 'Unavailable'}</span><span>{snapshot ? `${snapshot.logical_cores} logical processors` : ''}</span></div></article><article className="metric"><div className="metric-head"><div><span>PHYSICAL MEMORY</span><h2>Memory</h2></div><strong>{snapshot && snapshot.total_memory ? percent(snapshot.used_memory / snapshot.total_memory * 100) : '—'}</strong></div><Graph values={history.memory} color="var(--green)"/><div className="metric-meta"><span>{snapshot ? `${bytes(snapshot.used_memory)} used` : 'Unavailable'}</span><span>{snapshot ? `${bytes(snapshot.total_memory)} total` : ''}</span></div></article><div className="unavailable-row"><HardDrive size={18}/><div><strong>More metrics are not available yet</strong><p>GPU, disk and network monitoring have not been implemented. No estimated readings are shown.</p></div></div></div></section>}
      {page === 'Settings' && <section className="page settings-page"><div className="page-heading"><div><div className="eyebrow">PERSONALIZATION</div><h1>Settings</h1><p>Make TaskLens work for you.</p></div></div><div className="settings-block"><h2>Appearance</h2><div className="setting-row"><div><strong>Theme</strong><p>Choose how the application looks.</p></div><select value={theme} onChange={e => setTheme(e.target.value as Theme)} aria-label="Theme"><option value="system">Use system setting</option><option value="dark">Dark</option><option value="light">Light</option></select></div></div><div className="settings-block"><h2>Monitoring</h2><div className="setting-row"><div><strong>Refresh interval</strong><p>How often process and system data updates.</p></div><select value={interval} onChange={e => setIntervalValue(e.target.value)} aria-label="Refresh interval"><option value="1000">1 second</option><option value="2000">2 seconds</option><option value="5000">5 seconds</option></select></div></div><div className="settings-block"><h2>Privacy</h2><p>Preferences are stored on this device. Live readings remain local.</p></div></section>}
      {['Startup', 'Services', 'Network', 'History'].includes(page) && <section className="page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>{page}</h1><p>This section is not implemented yet.</p></div></div><div className="empty-panel"><CircleHelp size={24}/><strong>{page} is unavailable</strong><p>There is no collector or management functionality behind this section yet.</p></div></section>}
    </main>
    {selected && page === 'Processes' && <aside className="inspector"><div className="inspector-head"><span>PROCESS DETAILS</span><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close process details"><X size={16}/></button></div>{current ? <><div className="inspector-title"><div className="process-icon large">{current.name[0]?.toUpperCase() || '?'}</div><div><h2>{current.name}</h2><p>PID {current.pid}</p></div></div><div className="inspector-stats"><div><span>CPU</span><strong>{percent(current.cpu_usage)}</strong></div><div><span>MEMORY</span><strong>{bytes(current.memory)}</strong></div></div><div className="detail-list"><div><span>Status</span><strong>{current.status}</strong></div><div><span>Parent PID</span><strong>{current.parent_pid ?? 'Unavailable'}</strong></div><div><span>Started</span><strong>{current.start_time ? new Date(current.start_time * 1000).toLocaleString() : 'Unavailable'}</strong></div><div className="detail-long"><span>Executable</span><strong>{current.exe || 'Unavailable'}</strong></div><div className="detail-long"><span>Command line</span><strong>{current.command || 'Unavailable'}</strong></div></div><button className="danger-button" disabled={!current.identity} title={current.identity ? 'End this process' : 'Windows did not allow TaskLens to read this process, so it cannot be ended safely'} onClick={() => { setActionError(null); setConfirm(current); }}>End process</button><p className="inspector-note">Ending a process is tied to its exact creation time, so a recycled PID is never ended by mistake. Protected and critical Windows processes are refused. Some details may be unavailable due to Windows permissions.</p></> : <div className="empty">This process has exited or is no longer available.</div>}</aside>}
    {confirm && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="eyebrow">CONFIRM ACTION</div><h2 id="modal-title">End {confirm.name}?</h2><p>Windows will terminate PID {confirm.pid}. Unsaved work in this process may be lost.</p>{actionError && <div className="action-error" role="alert">{actionError}</div>}<div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button><button className="danger-button" onClick={() => void terminate()} disabled={busy}>{busy ? 'Ending…' : 'End process'}</button></div></div></div>}
  </div>;
}

