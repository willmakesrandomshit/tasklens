import { useEffect, useState } from 'react';
import { call, type FileInfo, type ModuleInfo, type ThreadInfo } from './api';
import { Graph } from './Graph';
import { useAction } from './hooks';
import { bytes, duration, percent, rate, redactCommand, type ProcessInfo } from './model';
import { revealInExplorer, usePolling } from './usePolling';
import type { Connection } from './Connections';

export interface ProcSeries { cpu: number[]; mem: number[]; priv: (number | null)[]; gpu: (number | null)[]; ioR: (number | null)[]; ioW: (number | null)[]; handles: (number | null)[]; threads: (number | null)[] }
export const SERIES_POINTS = 120;
export const emptySeries = (): ProcSeries => ({ cpu: [], mem: [], priv: [], gpu: [], ioR: [], ioW: [], handles: [], threads: [] });
export function pushSeries(s: ProcSeries, p: ProcessInfo): ProcSeries {
  const add = <T,>(a: T[], v: T) => { const n = [...a, v]; return n.length > SERIES_POINTS ? n.slice(-SERIES_POINTS) : n; };
  return { cpu: add(s.cpu, p.cpu_usage), mem: add(s.mem, p.memory), priv: add(s.priv, p.private_bytes ?? null), gpu: add(s.gpu, p.gpu_percent ?? null),
    ioR: add(s.ioR, p.io_read_per_s ?? null), ioW: add(s.ioW, p.io_write_per_s ?? null), handles: add(s.handles, p.handle_count ?? null), threads: add(s.threads, p.thread_count ?? null) };
}

type Tab = 'overview' | 'performance' | 'threads' | 'modules' | 'connections' | 'security';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'performance', label: 'Performance' }, { id: 'threads', label: 'Threads' },
  { id: 'modules', label: 'Modules' }, { id: 'connections', label: 'Connections' }, { id: 'security', label: 'Security' },
];

interface Props {
  process: ProcessInfo | null;
  series: ProcSeries;
  interval: number;
  parent: ProcessInfo | null;
  children: ProcessInfo[];
  onClose: () => void;
  onSelectPid: (pid: number) => void;
  onEnd: () => void;
  onEndTree: () => void;
  onSuspend: () => void;
  onProperties?: never;
}

const Row = ({ k, v, long }: { k: string; v: React.ReactNode; long?: boolean }) => <div className={long ? 'detail-long' : undefined}><span>{k}</span><strong>{v}</strong></div>;

function Overview({ p, parent, kids, onSelectPid, info }: { p: ProcessInfo; parent: ProcessInfo | null; kids: ProcessInfo[]; onSelectPid: (pid: number) => void; info: FileInfo | null }) {
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = Date.now() / 1000;
  return <>
    <div className="detail-list">
      <Row k="Description" v={info?.description ?? '—'} />
      <Row k="Publisher" v={info?.company ?? '—'} />
      <Row k="Version" v={info?.version ?? '—'} />
      <Row k="Status" v={p.suspended ? 'Suspended by TaskLens' : p.status} />
      <Row k="User" v={p.user ?? 'Unavailable'} />
      <Row k="Session" v={p.session_id ?? '—'} />
      <Row k="Architecture" v={p.architecture ?? '—'} />
      <Row k="Priority" v={p.priority ?? 'Unavailable'} />
      <Row k="Started" v={p.start_time ? new Date(p.start_time * 1000).toLocaleString() : 'Unavailable'} />
      <Row k="Uptime" v={p.start_time ? duration(now - p.start_time) : '—'} />
      <Row k="Parent" v={parent ? <button className="link" onClick={() => onSelectPid(parent.pid)}>{parent.name} ({parent.pid})</button> : p.parent_pid ? `PID ${p.parent_pid} (exited)` : '—'} />
      <Row k="Children" v={kids.length ? kids.slice(0, 8).map(k => <button key={k.pid} className="link" onClick={() => onSelectPid(k.pid)}>{k.name} ({k.pid}) </button>) : 'None'} long />
      <Row k="Executable" v={<>{p.exe ?? 'Unavailable'} {p.exe && <button className="link" onClick={async () => setErr(await revealInExplorer(p.exe!))}>Open location</button>}</>} long />
      <Row k="Command line" v={<>{p.command ? (reveal ? p.command : redactCommand(p.command)) : 'Unavailable'} {p.command && redactCommand(p.command) !== p.command && <button className="link" onClick={() => setReveal(r => !r)}>{reveal ? 'Hide secrets' : 'Show secrets'}</button>}</>} long />
    </div>
    {err && <div className="action-error" role="alert">{err}</div>}
  </>;
}

function Performance({ s, step }: { s: ProcSeries; step: number }) {
  const g = (label: string, series: { values: (number | null)[]; color: string; label: string }[], fmt: (n: number) => string, max?: number) => <div className="mini-graph"><h4>{label}</h4><Graph series={series} step={step} points={SERIES_POINTS} format={fmt} label={label} height={90} max={max} /></div>;
  return <div className="graph-stack">
    {g('CPU', [{ values: s.cpu, color: 'var(--accent)', label: 'CPU' }], percent, 100)}
    {g('Memory', [{ values: s.mem, color: 'var(--green)', label: 'Working set' }, { values: s.priv, color: 'var(--amber)', label: 'Private bytes' }], bytes)}
    {g('I/O (all kinds, not only disk)', [{ values: s.ioR, color: 'var(--accent)', label: 'Read' }, { values: s.ioW, color: 'var(--green)', label: 'Write' }], rate)}
    {s.gpu.some(v => v !== null) ? g('GPU', [{ values: s.gpu, color: 'var(--accent)', label: 'GPU' }], percent, 100) : <p className="muted">GPU: not available for this process.</p>}
    {g('Handles', [{ values: s.handles, color: 'var(--accent)', label: 'Handles' }], n => String(Math.round(n)))}
    {g('Threads', [{ values: s.threads, color: 'var(--green)', label: 'Threads' }], n => String(Math.round(n)))}
  </div>;
}

function Threads({ p }: { p: ProcessInfo }) {
  const [data, setData] = useState<ThreadInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => call<ThreadInfo[]>('process_threads', { pid: p.pid, identity: p.identity }).then(r => { if (alive) { setData(r); setErr(null); } }, e => { if (alive) setErr(e.message); });
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [p.pid, p.identity]);
  if (err) return <div className="action-error" role="alert">{err}</div>;
  if (!data) return <div className="empty">Reading threads…</div>;
  return <div className="data-wrap small"><table className="data-table"><thead><tr><th>Thread ID</th><th>Base priority</th><th>CPU time</th></tr></thead><tbody>
    {[...data].sort((a, b) => (b.cpu_time_ms ?? -1) - (a.cpu_time_ms ?? -1)).map(t => <tr key={t.tid}><td>{t.tid}</td><td>{t.base_priority}</td><td>{t.cpu_time_ms == null ? '—' : duration(t.cpu_time_ms / 1000)}</td></tr>)}</tbody></table></div>;
}

function Modules({ p }: { p: ProcessInfo }) {
  const [data, setData] = useState<ModuleInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { let alive = true; call<ModuleInfo[]>('process_modules', { pid: p.pid, identity: p.identity }).then(r => alive && setData(r), e => alive && setErr(e.message)); return () => { alive = false; }; }, [p.pid, p.identity]);
  if (err) return <div className="action-error" role="alert">{err} Modules of protected or elevated processes cannot be read without administrator rights.</div>;
  if (!data) return <div className="empty">Reading modules…</div>;
  const rows = data.filter(m => !q || `${m.name} ${m.path}`.toLowerCase().includes(q.toLowerCase()));
  return <><input className="field" placeholder="Filter modules" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter modules" />
    <div className="data-wrap small"><table className="data-table"><thead><tr><th>Module</th><th>Path</th></tr></thead><tbody>{rows.map(m => <tr key={m.path}><td>{m.name}</td><td className="cell-long" title={m.path}>{m.path}</td></tr>)}</tbody></table></div>
    <p className="muted">{rows.length} of {data.length} modules. Per-module signatures are not verified.</p></>;
}

function Connections({ p, active }: { p: ProcessInfo; active: boolean }) {
  const { data, error } = usePolling<Connection[]>('list_connections', 3000, active);
  const rows = (data ?? []).filter(c => c.pid === p.pid);
  if (error) return <div className="action-error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Reading connections…</div>;
  if (!rows.length) return <div className="empty">This process has no TCP connections or UDP endpoints.</div>;
  return <div className="data-wrap small"><table className="data-table"><thead><tr><th>Proto</th><th>Local</th><th>Remote</th><th>State</th></tr></thead><tbody>
    {rows.map((c, i) => <tr key={i}><td>{c.protocol}</td><td>{c.local_addr}:{c.local_port}</td><td>{c.remote_addr ? `${c.remote_addr}:${c.remote_port}` : '—'}</td><td>{c.state ?? '—'}</td></tr>)}</tbody></table></div>;
}

function Security({ p, info }: { p: ProcessInfo; info: FileInfo | null }) {
  return <><div className="detail-list">
    <Row k="Account" v={p.user ?? 'Unavailable'} /><Row k="Session" v={p.session_id ?? '—'} />
    <Row k="Embedded signature" v={info?.signature ?? '—'} /><Row k="Publisher" v={info?.company ?? '—'} />
    <Row k="Integrity level" v="Not available yet" />
  </div><p className="muted">Only an embedded Authenticode signature is checked; many Windows files are catalog-signed and show as "Not signed (embedded)". An unsigned file is not evidence of malware, and a valid signature is not a guarantee of safety.</p></>;
}

export function Inspector(props: Props) {
  const { process: p } = props;
  const [tab, setTab] = useState<Tab>('overview');
  const [info, setInfo] = useState<FileInfo | null>(null);
  const action = useAction();
  useEffect(() => {
    setInfo(null);
    if (!p?.exe) return;
    let alive = true;
    call<FileInfo>('process_file_info', { path: p.exe }).then(r => alive && setInfo(r), () => undefined);
    return () => { alive = false; };
  }, [p?.exe]);
  return <aside className="inspector" aria-label="Process details">
    <div className="inspector-head"><span>PROCESS DETAILS</span><button className="icon-button" onClick={props.onClose} aria-label="Close process details">✕</button></div>
    {p ? <>
      <div className="inspector-title"><div className="process-icon large" aria-hidden="true">{p.name[0]?.toUpperCase() || '?'}</div><div><h2>{p.name}</h2><p>PID {p.pid}{p.suspended ? ' · suspended' : ''}</p></div></div>
      <div className="inspector-stats"><div><span>CPU</span><strong>{percent(p.cpu_usage)}</strong></div><div><span>MEMORY</span><strong>{bytes(p.memory)}</strong></div><div><span>GPU</span><strong>{p.gpu_percent == null ? '—' : percent(p.gpu_percent)}</strong></div></div>
      <div className="tabs" role="tablist">{TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
      <div className="tab-body" role="tabpanel">
        {tab === 'overview' && <Overview p={p} parent={props.parent} kids={props.children} onSelectPid={props.onSelectPid} info={info} />}
        {tab === 'performance' && <Performance s={props.series} step={props.interval / 1000} />}
        {tab === 'threads' && <Threads p={p} />}
        {tab === 'modules' && <Modules p={p} />}
        {tab === 'connections' && <Connections p={p} active />}
        {tab === 'security' && <Security p={p} info={info} />}
      </div>
      <div className="button-row">
        <button className="secondary-button" disabled={action.busy || !p.identity} onClick={props.onSuspend} title={p.identity ? '' : 'Windows did not allow TaskLens to open this process, so it cannot be changed safely'}>{p.suspended ? 'Resume' : 'Suspend'}</button>
        <button className="danger-button" disabled={!p.identity} title={p.identity ? 'End this process' : 'Windows did not allow TaskLens to read this process, so it cannot be ended safely'} onClick={props.onEnd}>End process</button>
        <button className="danger-button" disabled={!p.identity} onClick={props.onEndTree} title="End this process and everything it started">End process tree</button>
      </div>
      <p className="inspector-note">Ending a process is tied to its exact creation time, so a recycled PID is never ended by mistake. Protected and critical Windows processes are refused. Details may be unavailable due to Windows permissions.</p>
    </> : <div className="empty">This process has exited or is no longer available.</div>}
  </aside>;
}
