import { invoke } from '@tauri-apps/api/core';
import { Activity, ArrowDown, ArrowUp, ChartNoAxesCombined, ChevronRight, CircleHelp, Clock3, Cpu, List, MonitorCog, Network, Search, Server, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildTreeRows, bytes, percent, procKey, selectProcesses, type ProcessInfo, type Snapshot, type SortKey } from './model';
import { emptyHistory, Performance, type History } from './Performance';
import { Connections } from './Connections';
import { Services } from './Services';
import { Startup } from './Startup';
import { visibleRange } from './viewport';

type Page = 'Processes' | 'Performance' | 'Startup' | 'Services' | 'Network' | 'History' | 'Settings';
type Theme = 'system' | 'dark' | 'light';
const navigation: { name: Page; icon: typeof List }[] = [
  { name: 'Processes', icon: List }, { name: 'Performance', icon: Activity },
  { name: 'Startup', icon: MonitorCog }, { name: 'Services', icon: Server },
  { name: 'Network', icon: Network }, { name: 'History', icon: Clock3 }, { name: 'Settings', icon: Settings },
];
const ROW_HEIGHT = 38;
function readSetting<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const value = localStorage.getItem(key); return allowed.includes(value as T) ? value as T : fallback; } catch { return fallback; }
}

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
  const [tree, setTree] = useState(() => readSetting('tasklens.tree', ['on', 'off'], 'off') === 'on');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [history, setHistory] = useState<History>(emptyHistory);
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('tasklens.theme', theme); } catch { /* storage can be disabled */ }
  }, [theme]);
  useEffect(() => { try { localStorage.setItem('tasklens.tree', tree ? 'on' : 'off'); } catch { /* storage can be disabled */ } }, [tree]);
  useEffect(() => { try { localStorage.setItem('tasklens.interval', interval); } catch { /* storage can be disabled */ } }, [interval]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await invoke<Snapshot>('snapshot');
        if (!active) return;
        setSnapshot(data); setError(null);
        {
          const sum = (values: (number | null)[]) => values.reduce<number>((a, v) => a + (v ?? 0), 0);
          const push = (series: number[], value: number) => [...series, value].slice(-60);
          setHistory(h => ({
            cpu: push(h.cpu, data.cpu_usage),
            memory: push(h.memory, data.total_memory ? data.used_memory / data.total_memory * 100 : 0),
            netIn: push(h.netIn, sum(data.networks.map(n => n.received_per_s))),
            netOut: push(h.netOut, sum(data.networks.map(n => n.transmitted_per_s))),
            diskRead: push(h.diskRead, sum(data.disks.map(d => d.read_per_s))),
            diskWrite: push(h.diskWrite, sum(data.disks.map(d => d.write_per_s))),
          }));
        }
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
  const treeMode = tree && !query.trim();
  const rows = useMemo(() => {
    const all = snapshot?.processes ?? [];
    if (treeMode) return buildTreeRows(all, expanded, sort, ascending);
    return selectProcesses(all, query, sort, ascending).map(process => ({ process, depth: 0, hasChildren: false, expanded: false }));
  }, [snapshot, query, sort, ascending, treeMode, expanded]);
  const processes = rows;
  const toggleExpanded = (p: ProcessInfo) => setExpanded(prev => { const next = new Set(prev); const k = procKey(p); if (next.has(k)) next.delete(k); else next.add(k); return next; });
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
        <div className="table-toolbar"><label className="search"><Search size={16}/><input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setScrollTop(0); if (tableRef.current) tableRef.current.scrollTop = 0; }} placeholder="Search name, PID, or path" aria-label="Search processes"/><kbd>Ctrl F</kbd></label><button className={`secondary-button${tree ? ' active' : ''}`} aria-pressed={tree} title={query.trim() ? 'Clear the search to use the tree view' : 'Show processes as a parent/child tree'} onClick={() => setTree(t => !t)}>Tree view</button><span className="muted">{processes.length} shown</span></div>
        <div className="table-wrap"><div className="table-head row"><button className="column-button" onClick={() => changeSort('name')}>PROCESS {sort === 'name' && (ascending ? <ArrowUp size={12}/> : <ArrowDown size={12}/>)}</button>{(['pid','cpu_usage','memory'] as SortKey[]).map(key => <button key={key} className="column-button" onClick={() => changeSort(key)}>{key === 'pid' ? 'PID' : key === 'cpu_usage' ? 'CPU' : 'MEMORY'} {sort === key && (ascending ? <ArrowUp size={12}/> : <ArrowDown size={12}/>)}</button>)}<span>STATUS</span></div>
          <div className="table-scroll" ref={tableRef} onScroll={e => setScrollTop(e.currentTarget.scrollTop)} role="table" aria-label="Running processes"><div style={{ height: processes.length * ROW_HEIGHT, position: 'relative' }}>{processes.slice(first, last).map(({ process: p, depth, hasChildren, expanded: open }, i) => <button className={`process-row row ${current?.pid === p.pid && current.identity === p.identity ? 'selected' : ''}`} key={procKey(p)} style={{ top: (first + i) * ROW_HEIGHT }} onClick={() => setSelected({ pid: p.pid, identity: p.identity })}><span className="process-name" style={{ paddingLeft: depth * 16 }}>{treeMode && (hasChildren ? <span className="tree-toggle" role="button" aria-label={open ? 'Collapse children' : 'Expand children'} aria-expanded={open} onClick={e => { e.stopPropagation(); toggleExpanded(p); }}>{open ? '▾' : '▸'}</span> : <span className="tree-toggle" aria-hidden="true" />)}<span className="process-icon">{p.name[0]?.toUpperCase() || '?'}</span><span title={p.name}>{p.name}</span></span><span>{p.pid}</span><span>{percent(p.cpu_usage)}</span><span>{bytes(p.memory)}</span><span className="process-status">{p.status}</span></button>)}</div>{snapshot && processes.length === 0 && <div className="empty">No processes match your search.</div>}</div>
          <div className="table-footer"><span>Click a process to inspect it</span><span>Updated every {Number(interval) / 1000}s</span></div></div>
      </section>}
      {page === 'Performance' && <Performance snapshot={snapshot} history={history} />}
      {page === 'Settings' && <section className="page settings-page"><div className="page-heading"><div><div className="eyebrow">PERSONALIZATION</div><h1>Settings</h1><p>Make TaskLens work for you.</p></div></div><div className="settings-block"><h2>Appearance</h2><div className="setting-row"><div><strong>Theme</strong><p>Choose how the application looks.</p></div><select value={theme} onChange={e => setTheme(e.target.value as Theme)} aria-label="Theme"><option value="system">Use system setting</option><option value="dark">Dark</option><option value="light">Light</option></select></div></div><div className="settings-block"><h2>Monitoring</h2><div className="setting-row"><div><strong>Refresh interval</strong><p>How often process and system data updates.</p></div><select value={interval} onChange={e => setIntervalValue(e.target.value)} aria-label="Refresh interval"><option value="1000">1 second</option><option value="2000">2 seconds</option><option value="5000">5 seconds</option></select></div></div><div className="settings-block"><h2>Privacy</h2><p>Preferences are stored on this device. Live readings remain local.</p></div></section>}
      {page === 'Startup' && <Startup active />}
      {page === 'Services' && <Services active />}
      {page === 'Network' && <Connections active snapshot={snapshot} />}
      {['History'].includes(page) && <section className="page"><div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>{page}</h1><p>This section is not implemented yet.</p></div></div><div className="empty-panel"><CircleHelp size={24}/><strong>{page} is unavailable</strong><p>There is no collector or management functionality behind this section yet.</p></div></section>}
    </main>
    {selected && page === 'Processes' && <aside className="inspector"><div className="inspector-head"><span>PROCESS DETAILS</span><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close process details"><X size={16}/></button></div>{current ? <><div className="inspector-title"><div className="process-icon large">{current.name[0]?.toUpperCase() || '?'}</div><div><h2>{current.name}</h2><p>PID {current.pid}</p></div></div><div className="inspector-stats"><div><span>CPU</span><strong>{percent(current.cpu_usage)}</strong></div><div><span>MEMORY</span><strong>{bytes(current.memory)}</strong></div></div><div className="detail-list"><div><span>Status</span><strong>{current.status}</strong></div><div><span>Parent PID</span><strong>{current.parent_pid ?? 'Unavailable'}</strong></div><div><span>Started</span><strong>{current.start_time ? new Date(current.start_time * 1000).toLocaleString() : 'Unavailable'}</strong></div><div className="detail-long"><span>Executable</span><strong>{current.exe || 'Unavailable'}</strong></div><div className="detail-long"><span>Command line</span><strong>{current.command || 'Unavailable'}</strong></div></div><button className="danger-button" disabled={!current.identity} title={current.identity ? 'End this process' : 'Windows did not allow TaskLens to read this process, so it cannot be ended safely'} onClick={() => { setActionError(null); setConfirm(current); }}>End process</button><p className="inspector-note">Ending a process is tied to its exact creation time, so a recycled PID is never ended by mistake. Protected and critical Windows processes are refused. Some details may be unavailable due to Windows permissions.</p></> : <div className="empty">This process has exited or is no longer available.</div>}</aside>}
    {confirm && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="eyebrow">CONFIRM ACTION</div><h2 id="modal-title">End {confirm.name}?</h2><p>Windows will terminate PID {confirm.pid}. Unsaved work in this process may be lost.</p>{actionError && <div className="action-error" role="alert">{actionError}</div>}<div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button><button className="danger-button" onClick={() => void terminate()} disabled={busy}>{busy ? 'Ending…' : 'End process'}</button></div></div></div>}
  </div>;
}

