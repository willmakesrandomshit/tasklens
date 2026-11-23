import { useEffect, useMemo, useState } from 'react';
import { call, type AlertEvent, type SessionInfo, type SystemInfo as SysInfo } from './api';
import { Sparkline } from './Graph';
import type { MetricHistory } from './hooks';
import { bitRate, bytes, duration, percent, rate, type ProcessInfo, type Snapshot } from './model';
import type { Page } from './Processes';
import { usePolling } from './usePolling';

const top = <T,>(list: T[], key: (t: T) => number, n = 5) => [...list].sort((a, b) => key(b) - key(a)).slice(0, n);

export function Overview({ snapshot: s, history: h, onNavigate }: { snapshot: Snapshot | null; history: MetricHistory; onNavigate: (p: Page, q?: string) => void }) {
  const alerts = usePolling<AlertEvent[]>('alert_log', 5000, true);
  if (!s) return <section className="page"><div className="page-heading"><div><div className="eyebrow">OVERVIEW</div><h1>Overview</h1></div></div><div className="empty">Waiting for the first reading…</div></section>;
  const mem = s.total_memory ? (s.used_memory / s.total_memory) * 100 : 0;
  const gpu = s.gpu.supported ? Math.max(0, ...s.gpu.live.map(g => g.percent)) : null;
  const disk = s.perf.physical_disks.reduce<number | null>((a, d) => d.active_percent == null ? a : Math.max(a ?? 0, d.active_percent), null);
  const inR = h.netIn[h.netIn.length - 1];
  const lists: [string, ProcessInfo[], (p: ProcessInfo) => string][] = [
    ['CPU', top(s.processes, p => p.cpu_usage), p => percent(p.cpu_usage)],
    ['Memory', top(s.processes, p => p.memory), p => bytes(p.memory)],
    ['Disk I/O', top(s.processes.filter(p => p.io_read_per_s != null), p => (p.io_read_per_s ?? 0) + (p.io_write_per_s ?? 0)), p => rate((p.io_read_per_s ?? 0) + (p.io_write_per_s ?? 0))],
    ['GPU', s.gpu.supported ? top(s.processes, p => p.gpu_percent ?? 0).filter(p => (p.gpu_percent ?? 0) > 0) : [], p => percent(p.gpu_percent ?? 0)],
  ];
  // Observations only: state what is high right now, never what "caused" it.
  const notes: string[] = [];
  if (s.cpu_usage > 85) notes.push(`CPU is at ${percent(s.cpu_usage)}. The busiest process right now is ${lists[0][1][0]?.name ?? 'unknown'} (${lists[0][1][0] ? percent(lists[0][1][0].cpu_usage) : '—'}).`);
  if (mem > 85) notes.push(`Memory is ${percent(mem)} in use; the largest working set belongs to ${lists[1][1][0]?.name ?? 'unknown'} (${bytes(lists[1][1][0]?.memory)}).`);
  if (disk != null && disk > 80) notes.push(`A physical disk is ${percent(disk)} active.`);
  if (gpu != null && gpu > 85) notes.push(`The GPU's busiest engine is at ${percent(gpu)}.`);
  const tile = (title: string, value: string, sub: string, spark: number[], max: number | undefined, page: Page) => <button className="ov-tile" onClick={() => onNavigate(page)}><span>{title}</span><strong>{value}</strong><small>{sub}</small><Sparkline values={spark.slice(-60)} color="var(--accent)" max={max ?? Math.max(1, ...spark)} /></button>;
  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">OVERVIEW</div><h1>Overview</h1><p>What is using your computer right now.</p></div></div>
    <div className="ov-tiles">
      {tile('CPU', percent(s.cpu_usage), `${s.logical_cores} logical processors`, h.cpu, 100, 'Performance')}
      {tile('Memory', percent(mem), `${bytes(s.used_memory)} of ${bytes(s.total_memory)}`, h.memory, 100, 'Performance')}
      {tile('Disk', disk == null ? '—' : percent(disk), 'active time', h.diskActive.map(v => v ?? 0), 100, 'Performance')}
      {tile('Network', inR == null ? '—' : rate(inR), 'download', h.netIn, undefined, 'Network')}
      {tile('GPU', gpu == null ? 'N/A' : percent(gpu), s.gpu.supported ? 'busiest engine' : 'no counters', h.gpu.map(v => v ?? 0), 100, 'Performance')}
    </div>
    <div className="notes" aria-live="polite">{notes.length ? notes.map(n => <p key={n}>{n}</p>) : <p className="muted">Nothing unusual right now: CPU, memory, disk and GPU are all below their attention thresholds.</p>}
      <p className="muted">These are observations of current usage, not diagnoses. Open the Resource Monitor to investigate, or History to look back.</p></div>
    <div className="ov-lists">{lists.map(([title, rows, fmt]) => <article key={title} className="metric"><h2>Top by {title}</h2>
      {rows.length ? <table className="mini-table"><tbody>{rows.map(p => <tr key={p.pid}><td>{p.name}</td><td className="num">{fmt(p)}</td></tr>)}</tbody></table> : <p className="muted">{title === 'GPU' ? 'No process is using the GPU, or GPU counters are unavailable.' : 'No data yet.'}</p>}</article>)}</div>
    <article className="metric"><h2>Recent alerts</h2>{(alerts.data ?? []).length ? <ul className="plain">{(alerts.data ?? []).slice(0, 5).map(a => <li key={`${a.ts}${a.rule_id}`}><strong>{new Date(a.ts * 1000).toLocaleTimeString()}</strong> {a.message}</li>)}</ul> : <p className="muted">No alerts have fired. Create rules on the Alerts page.</p>}</article>
  </section>;
}

type RM = 'cpu' | 'memory' | 'disk' | 'network' | 'gpu';
export function ResourceMonitor({ snapshot: s, onNavigate }: { snapshot: Snapshot | null; onNavigate: (p: Page, q?: string) => void }) {
  const [tab, setTab] = useState<RM>('cpu');
  const [focus, setFocus] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const conns = usePolling<{ pid: number; state: string | null; protocol: string }[]>('list_connections', 4000, tab === 'network');
  const procs = useMemo(() => {
    const all = (s?.processes ?? []).filter(p => !q || `${p.name} ${p.pid}`.toLowerCase().includes(q.toLowerCase()));
    const by: Record<RM, (p: ProcessInfo) => number> = {
      cpu: p => p.cpu_usage, memory: p => p.memory, disk: p => (p.io_read_per_s ?? 0) + (p.io_write_per_s ?? 0),
      network: p => (conns.data ?? []).filter(c => c.pid === p.pid && c.state === 'Established').length, gpu: p => p.gpu_percent ?? 0,
    };
    const sorted = [...all].sort((a, b) => by[tab](b) - by[tab](a)).slice(0, 60);
    return focus == null ? sorted : [...sorted.filter(p => p.pid === focus), ...sorted.filter(p => p.pid !== focus)];
  }, [s, tab, q, focus, conns.data]);
  if (!s) return <section className="page"><div className="empty">Waiting for the first reading…</div></section>;
  const focused = focus == null ? null : s.processes.find(p => p.pid === focus) ?? null;
  const cols: Record<RM, [string, (p: ProcessInfo) => string][]> = {
    cpu: [['CPU', p => percent(p.cpu_usage)], ['CPU time', p => (p.cpu_time_ms == null ? '—' : duration(p.cpu_time_ms / 1000))], ['Threads', p => String(p.thread_count ?? '—')]],
    memory: [['Working set', p => bytes(p.memory)], ['Private bytes', p => bytes(p.private_bytes)], ['Peak', p => bytes(p.peak_working_set)]],
    disk: [['I/O read', p => rate(p.io_read_per_s)], ['I/O write', p => rate(p.io_write_per_s)], ['Total read', p => bytes(p.io_read_bytes)], ['Total written', p => bytes(p.io_write_bytes)]],
    network: [['Established', p => String((conns.data ?? []).filter(c => c.pid === p.pid && c.state === 'Established').length)], ['Endpoints', p => String((conns.data ?? []).filter(c => c.pid === p.pid).length)]],
    gpu: [['GPU', p => (p.gpu_percent == null ? '—' : percent(p.gpu_percent))]],
  };
  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>Resource Monitor</h1><p>Find what is using each resource. Select a process to keep it on top across tabs.</p></div></div>
    <div className="tabs" role="tablist">{(['cpu', 'memory', 'disk', 'network', 'gpu'] as RM[]).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'cpu' ? 'CPU' : t === 'gpu' ? 'GPU' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
    <div className="rm-summary">
      {tab === 'cpu' && <p>CPU {percent(s.cpu_usage)} · {s.logical_cores} logical processors · busiest core {percent(Math.max(0, ...s.cpu_cores))}</p>}
      {tab === 'memory' && <p>{bytes(s.used_memory)} of {bytes(s.total_memory)} in use · {bytes(s.available_memory)} available · commit {bytes(s.memory_detail.commit_total)} / {bytes(s.memory_detail.commit_limit)}</p>}
      {tab === 'disk' && <><p>Process columns show all I/O a process performs (files, pipes, devices). They are not physical disk traffic; the table below is.</p>
        <table className="mini-table"><thead><tr><th>Physical disk</th><th>Active</th><th>Response</th><th>Read</th><th>Write</th></tr></thead><tbody>{s.perf.physical_disks.map(d => <tr key={d.name}><td>{d.name}</td><td>{d.active_percent == null ? '—' : percent(d.active_percent)}</td><td>{d.response_ms == null ? '—' : `${d.response_ms.toFixed(1)} ms`}</td><td>{rate(d.read_per_s)}</td><td>{rate(d.write_per_s)}</td></tr>)}</tbody></table></>}
      {tab === 'network' && <><p>Per-process bandwidth is not measured (it needs ETW tracing, which is not implemented). The table counts each process's connections instead.</p>
        <table className="mini-table"><thead><tr><th>Adapter</th><th>Down</th><th>Up</th><th>Link</th></tr></thead><tbody>{s.networks.filter(n => n.addresses.length).map(n => { const l = s.perf.link_speeds.find(x => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === n.name.toLowerCase().replace(/[^a-z0-9]/g, '')); return <tr key={n.name}><td>{n.name}</td><td>{rate(n.received_per_s)}</td><td>{rate(n.transmitted_per_s)}</td><td>{l ? bitRate(l.bits_per_s) : '—'}</td></tr>; })}</tbody></table></>}
      {tab === 'gpu' && <p>{s.gpu.supported ? `Busiest engine ${percent(Math.max(0, ...s.gpu.live.map(g => g.percent)))}. Per-process figures are each process's busiest GPU engine.` : 'GPU performance counters are not available on this system.'}</p>}
    </div>
    <div className="table-toolbar"><label className="search"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter processes" aria-label="Filter processes" /></label>{focused && <span className="chip">Focused: {focused.name} ({focused.pid}) <button className="link" onClick={() => setFocus(null)}>clear</button></span>}</div>
    <div className="data-wrap"><table className="data-table"><thead><tr><th>Process</th><th>PID</th>{cols[tab].map(([l]) => <th key={l}>{l}</th>)}<th /></tr></thead>
      <tbody>{procs.map(p => <tr key={p.pid} className={p.pid === focus ? 'selected' : ''} onClick={() => setFocus(p.pid === focus ? null : p.pid)} tabIndex={0} aria-selected={p.pid === focus} onKeyDown={e => { if (e.key === 'Enter') setFocus(p.pid); }}><td>{p.name}</td><td>{p.pid}</td>{cols[tab].map(([l, f]) => <td key={l} className="num">{f(p)}</td>)}<td><button className="link" onClick={e => { e.stopPropagation(); onNavigate('Network', String(p.pid)); }}>connections</button></td></tr>)}</tbody></table></div>
  </section>;
}

export function Users({ snapshot: s }: { snapshot: Snapshot | null }) {
  const sessions = usePolling<SessionInfo[]>('list_sessions', 5000, true);
  const rows = useMemo(() => (sessions.data ?? []).map(se => {
    const procs = (s?.processes ?? []).filter(p => p.session_id === se.id);
    return { se, count: procs.length, cpu: procs.reduce((a, p) => a + p.cpu_usage, 0), mem: procs.reduce((a, p) => a + p.memory, 0), top: top(procs, p => p.cpu_usage, 3) };
  }), [sessions.data, s]);
  const users = useMemo(() => {
    const m = new Map<string, { count: number; cpu: number; mem: number }>();
    for (const p of s?.processes ?? []) { const k = p.user ?? 'Unavailable'; const e = m.get(k) ?? { count: 0, cpu: 0, mem: 0 }; e.count++; e.cpu += p.cpu_usage; e.mem += p.memory; m.set(k, e); }
    return [...m.entries()].sort((a, b) => b[1].cpu - a[1].cpu);
  }, [s]);
  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">SYSTEM MANAGEMENT</div><h1>Users</h1><p>Sessions on this computer and the resources their processes use. Only names, states and totals are read.</p></div></div>
    {sessions.error && <div className="error-banner" role="alert">{sessions.error}</div>}
    <h2 className="sub-h">Sessions</h2>
    <div className="data-wrap"><table className="data-table"><thead><tr><th>ID</th><th>User</th><th>State</th><th>Station</th><th>Processes</th><th>CPU</th><th>Memory</th><th>Busiest</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.se.id}><td>{r.se.id}</td><td>{r.se.user ?? '—'}</td><td>{r.se.state}</td><td>{r.se.station || '—'}</td><td>{r.count}</td><td className="num">{percent(r.cpu)}</td><td className="num">{bytes(r.mem)}</td><td>{r.top.map(p => p.name).join(', ') || '—'}</td></tr>)}</tbody></table>
      {!sessions.data && !sessions.error && <div className="empty">Reading sessions…</div>}</div>
    <h2 className="sub-h">Accounts running processes</h2>
    <div className="data-wrap"><table className="data-table"><thead><tr><th>Account</th><th>Processes</th><th>CPU</th><th>Memory</th></tr></thead><tbody>{users.map(([u, v]) => <tr key={u}><td>{u}</td><td>{v.count}</td><td className="num">{percent(v.cpu)}</td><td className="num">{bytes(v.mem)}</td></tr>)}</tbody></table></div>
  </section>;
}

export function System({ snapshot: s }: { snapshot: Snapshot | null }) {
  const [info, setInfo] = useState<SysInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { call<SysInfo>('system_info').then(setInfo, e => setErr(e.message)); }, []);
  const row = (k: string, v: React.ReactNode) => <div key={k}><span>{k}</span><strong>{v ?? 'Unavailable'}</strong></div>;
  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>System information</h1><p>Hardware and Windows details read from Windows. Fields Windows does not report are marked unavailable.</p></div></div>
    {err && <div className="error-banner" role="alert">{err}</div>}
    <div className="split-cols">
      <article className="metric"><h2>Windows</h2><div className="stat-grid one">{row('Edition', info?.os_name)}{row('Version', info?.os_version)}{row('Build', info?.os_build)}{row('Device name', info?.device_name)}{row('Architecture', info?.architecture)}{row('Boot mode', info?.boot_mode)}{row('Uptime', info ? duration(info.uptime_secs) : null)}</div></article>
      <article className="metric"><h2>Processor</h2><div className="stat-grid one">{row('Model', info?.cpu_name ?? s?.cpu_model)}{row('Cores / logical', s ? `${s.physical_cores ?? '?'} / ${s.logical_cores}` : null)}{row('Base frequency', info?.cpu_base_mhz ? `${(info.cpu_base_mhz / 1000).toFixed(2)} GHz` : null)}{row('Current frequency', s?.cpu_frequency_mhz ? `${(s.cpu_frequency_mhz / 1000).toFixed(2)} GHz (reported)` : null)}{row('Cache sizes', 'Not reported')}</div></article>
      <article className="metric"><h2>Memory</h2><div className="stat-grid one">{row('Installed', s ? bytes(s.total_memory) : null)}{row('Available', s ? bytes(s.available_memory) : null)}{row('Commit limit', s ? bytes(s.memory_detail.commit_limit) : null)}{row('Page file', s?.total_swap ? bytes(s.total_swap) : null)}{row('Slots / speed / type', 'Not reported')}</div></article>
      <article className="metric"><h2>Graphics</h2>{s?.gpu_adapters.length ? <table className="mini-table"><tbody>{s.gpu_adapters.map(a => <tr key={a.name}><td>{a.name}<br /><small className="muted">Driver {a.driver_version ?? '—'} · {a.provider ?? '—'}</small></td><td className="num">{a.dedicated_memory ? bytes(a.dedicated_memory) : 'VRAM not reported'}</td></tr>)}</tbody></table> : <p className="muted">No display adapters reported.</p>}</article>
      <article className="metric"><h2>Storage</h2><table className="mini-table"><tbody>{s?.disks.map(d => <tr key={d.mount}><td>{d.mount} <small className="muted">{d.file_system}</small></td><td className="num">{bytes(d.available)} free of {bytes(d.total)}</td></tr>)}</tbody></table></article>
      <article className="metric"><h2>Network adapters</h2><table className="mini-table"><tbody>{s?.networks.map(n => { const l = s.perf.link_speeds.find(x => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === n.name.toLowerCase().replace(/[^a-z0-9]/g, '')); return <tr key={n.name}><td>{n.name}</td><td>{l ? bitRate(l.bits_per_s) : '—'}</td><td>{n.addresses[0] ?? 'no address'}</td></tr>; })}</tbody></table></article>
    </div>
  </section>;
}
