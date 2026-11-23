import { useState } from 'react';
import { Graph, Sparkline, type Series } from './Graph';
import type { MetricHistory } from './hooks';
import { bitRate, bytes, percent, rate, type Snapshot } from './model';

type Tab = 'cpu' | 'memory' | 'disk' | 'network' | 'gpu';
const RANGES: [number, string][] = [[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour']];

interface Props { snapshot: Snapshot | null; history: MetricHistory; intervalMs: number; paused: boolean; onPause: (p: boolean) => void; range: number; onRange: (r: number) => void }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const tail = <T,>(a: T[], n: number) => (a.length > n ? a.slice(-n) : a);

function Tile({ id, tab, onTab, title, value, sub, spark, color }: { id: Tab; tab: Tab; onTab: (t: Tab) => void; title: string; value: string; sub: string; spark: number[]; color: string }) {
  return <button className={`perf-tile${tab === id ? ' active' : ''}`} onClick={() => onTab(id)} aria-pressed={tab === id}>
    <div><span>{title}</span><strong>{value}</strong><small>{sub}</small></div><Sparkline values={tail(spark, 60)} color={color} max={id === 'cpu' || id === 'memory' || id === 'gpu' ? 100 : Math.max(1, ...spark)} />
  </button>;
}

/** Memory composition bar: in use / modified / standby / free, using Windows' own page-list counters. */
function MemoryBar({ s }: { s: Snapshot }) {
  const l = s.perf.memory_lists;
  if (l.standby == null || l.modified == null || l.free == null) {
    return <p className="muted">Memory page-list counters are unavailable on this system, so only totals are shown.</p>;
  }
  const total = s.total_memory;
  const inUse = Math.max(0, total - l.standby - l.modified - l.free);
  const parts = [['In use', inUse, 'var(--accent)'], ['Modified', l.modified, 'var(--amber)'], ['Standby (cache)', l.standby, 'var(--green)'], ['Free', l.free, 'var(--hover)']] as const;
  return <div className="membar-wrap"><div className="membar" role="img" aria-label="Memory composition">{parts.map(([n, v, c]) => <div key={n} style={{ width: `${(v / total) * 100}%`, background: c }} title={`${n}: ${bytes(v)}`} />)}</div>
    <div className="legend">{parts.map(([n, v, c]) => <span key={n}><i style={{ background: c }} /> {n} {bytes(v)}</span>)}</div></div>;
}

export function Performance({ snapshot: s, history: h, intervalMs, paused, onPause, range, onRange }: Props) {
  const [tab, setTab] = useState<Tab>('cpu');
  const step = intervalMs / 1000;
  const points = Math.max(2, Math.round(range / step));
  const view = <T,>(a: T[]) => tail(a, points);
  const gpuNow = s?.gpu.supported ? Math.max(0, ...s.gpu.live.map(g => g.percent)) : null;
  const memPct = s && s.total_memory ? (s.used_memory / s.total_memory) * 100 : null;
  const physBusy = s?.perf.physical_disks.reduce<number | null>((a, d) => d.active_percent == null ? a : Math.max(a ?? 0, d.active_percent), null) ?? null;
  const lastIn = h.netIn[h.netIn.length - 1], lastOut = h.netOut[h.netOut.length - 1];
  const g = (label: string, series: Series[], fmt: (n: number) => string, max?: number, height = 150) => <Graph series={series} step={step} points={points} format={fmt} label={label} max={max} height={height} />;

  return <section className="page performance-page">
    <div className="page-heading"><div><div className="eyebrow">SYSTEM OVERVIEW</div><h1>Performance</h1><p>Live resource usage. Values shown as — are not available on this system; nothing is estimated.</p></div>
      <div className="heading-actions"><select value={range} onChange={e => onRange(Number(e.target.value))} aria-label="Time range">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="secondary-button" aria-pressed={paused} onClick={() => onPause(!paused)}>{paused ? 'Resume' : 'Pause'}</button></div></div>
    <div className="perf-layout">
      <nav className="perf-tiles" aria-label="Resources">
        <Tile id="cpu" tab={tab} onTab={setTab} title="CPU" value={s ? percent(s.cpu_usage) : '—'} sub={s ? `${s.logical_cores} logical processors` : ''} spark={h.cpu} color="var(--accent)" />
        <Tile id="memory" tab={tab} onTab={setTab} title="Memory" value={memPct == null ? '—' : percent(memPct)} sub={s ? `${bytes(s.used_memory)} / ${bytes(s.total_memory)}` : ''} spark={h.memory} color="var(--green)" />
        <Tile id="disk" tab={tab} onTab={setTab} title="Disk" value={physBusy == null ? '—' : percent(physBusy)} sub="active time" spark={h.diskActive.map(v => v ?? 0)} color="var(--amber)" />
        <Tile id="network" tab={tab} onTab={setTab} title="Network" value={lastIn == null ? '—' : rate(lastIn)} sub={lastOut == null ? '' : `up ${rate(lastOut)}`} spark={h.netIn} color="var(--accent)" />
        <Tile id="gpu" tab={tab} onTab={setTab} title="GPU" value={gpuNow == null ? 'N/A' : percent(gpuNow)} sub={s?.gpu.supported ? `${s.gpu.live.length} adapter(s)` : 'no counters'} spark={h.gpu.map(v => v ?? 0)} color="var(--green)" />
      </nav>
      <div className="perf-detail">
        {tab === 'cpu' && s && <article className="metric">
          <div className="metric-head"><div><span>PROCESSOR</span><h2>CPU</h2></div><strong>{percent(s.cpu_usage)}</strong></div>
          {g('CPU utilization', [{ values: view(h.cpu), color: 'var(--accent)', label: 'CPU' }], percent, 100)}
          <h3 className="sub-h">Per logical processor</h3>
          <div className="core-grid">{s.cpu_cores.map((v, i) => <div className="core-cell" key={i}><Graph series={[{ values: view(h.perCore[i] ?? []), color: 'var(--accent)', label: `CPU ${i}` }]} step={step} points={points} format={percent} label={`Logical processor ${i}`} max={100} height={56} /><span className="core-label">CPU {i} · {percent(v)}</span></div>)}</div>
          <div className="stat-grid">
            <div><span>Model</span><strong>{s.cpu_model}</strong></div><div><span>Cores / logical</span><strong>{s.physical_cores ?? '?'} / {s.logical_cores}</strong></div>
            <div><span>Frequency (reported)</span><strong>{s.cpu_frequency_mhz ? `${(s.cpu_frequency_mhz / 1000).toFixed(2)} GHz` : 'Unavailable'}</strong></div>
            <div><span>Temperature / power</span><strong>Unavailable (no standard Windows API)</strong></div>
            <div><span>Processes / threads / handles</span><strong>{s.memory_detail.process_count ?? '—'} / {s.memory_detail.thread_count ?? '—'} / {s.memory_detail.handle_count ?? '—'}</strong></div>
          </div>
          <p className="muted">CPU % is the share of total capacity across all logical processors (100% = every processor fully busy), averaged between two readings.</p>
        </article>}
        {tab === 'memory' && s && <article className="metric">
          <div className="metric-head"><div><span>PHYSICAL MEMORY</span><h2>Memory</h2></div><strong>{memPct == null ? '—' : percent(memPct)}</strong></div>
          {g('Memory utilization', [{ values: view(h.memory), color: 'var(--green)', label: 'In use' }], percent, 100)}
          <h3 className="sub-h">Composition</h3><MemoryBar s={s} />
          <div className="stat-grid">
            <div><span>Installed</span><strong>{bytes(s.total_memory)}</strong></div><div><span>In use</span><strong>{bytes(s.used_memory)}</strong></div><div><span>Available</span><strong>{bytes(s.available_memory)}</strong></div>
            <div><span>Committed</span><strong>{s.memory_detail.commit_total == null ? '—' : `${bytes(s.memory_detail.commit_total)} of ${bytes(s.memory_detail.commit_limit)}`}</strong></div>
            <div><span>Cached (file cache)</span><strong>{bytes(s.memory_detail.system_cache)}</strong></div>
            <div><span>Paged pool</span><strong>{bytes(s.memory_detail.kernel_paged)}</strong></div><div><span>Non-paged pool</span><strong>{bytes(s.memory_detail.kernel_nonpaged)}</strong></div>
            <div><span>Page file in use</span><strong>{s.total_swap ? `${bytes(s.used_swap)} / ${bytes(s.total_swap)}` : '—'}</strong></div>
          </div>
          <p className="muted">Working set = physical memory a process is using now. Private bytes = commit charge not shared with others. Commit = memory Windows has promised, which can exceed RAM.</p>
        </article>}
        {tab === 'disk' && s && <article className="metric">
          <div className="metric-head"><div><span>STORAGE</span><h2>Disk</h2></div><strong>{physBusy == null ? '—' : `${percent(physBusy)} active`}</strong></div>
          {g('Disk active time', [{ values: view(h.diskActive), color: 'var(--amber)', label: 'Active time' }], percent, 100, 110)}
          {g('Disk throughput', [{ values: view(h.diskRead), color: 'var(--accent)', label: 'Read' }, { values: view(h.diskWrite), color: 'var(--green)', label: 'Write' }], rate, undefined, 110)}
          <h3 className="sub-h">Physical disks</h3>
          <table className="mini-table"><thead><tr><th>Disk</th><th>Active</th><th>Response</th><th>Queue</th><th>Read</th><th>Write</th></tr></thead><tbody>{s.perf.physical_disks.map(d => <tr key={d.name}><td>{d.name}</td><td>{d.active_percent == null ? '—' : percent(d.active_percent)}</td><td>{d.response_ms == null ? '—' : `${d.response_ms.toFixed(1)} ms`}</td><td>{d.queue_length ?? '—'}</td><td>{rate(d.read_per_s)}</td><td>{rate(d.write_per_s)}</td></tr>)}</tbody></table>
          <h3 className="sub-h">Volumes</h3>
          <table className="mini-table"><thead><tr><th>Volume</th><th>Type</th><th>Capacity</th><th>Free</th><th>Used</th></tr></thead><tbody>{s.disks.map(d => <tr key={`${d.mount}${d.name}`}><td>{d.mount}</td><td>{d.file_system}</td><td>{bytes(d.total)}</td><td>{bytes(d.available)}</td><td><div className="bar"><div style={{ width: `${d.total ? (1 - d.available / d.total) * 100 : 0}%` }} /></div></td></tr>)}</tbody></table>
          <p className="muted">Disk media type and interface are not detected yet.</p>
        </article>}
        {tab === 'network' && s && <article className="metric">
          <div className="metric-head"><div><span>NETWORK</span><h2>Adapters</h2></div><strong>{lastIn == null ? '—' : `${rate(lastIn)} down`}</strong></div>
          {g('Network throughput', [{ values: view(h.netIn), color: 'var(--accent)', label: 'Download' }, { values: view(h.netOut), color: 'var(--green)', label: 'Upload' }], rate)}
          <table className="mini-table"><thead><tr><th>Adapter</th><th>Down</th><th>Up</th><th>Link speed</th><th>Addresses</th></tr></thead><tbody>{s.networks.map(n => { const link = s.perf.link_speeds.find(l => norm(l.name) === norm(n.name)); return <tr key={n.name}><td title={n.name}>{n.name}</td><td>{rate(n.received_per_s)}</td><td>{rate(n.transmitted_per_s)}</td><td>{link ? bitRate(link.bits_per_s) : '—'}</td><td>{n.addresses.join(', ') || '—'}</td></tr>; })}</tbody></table>
          <p className="muted">Virtual filter-driver adapters repeat the physical adapter's counters; totals count only adapters that own an address. Per-process bandwidth is not measured.</p>
        </article>}
        {tab === 'gpu' && s && <article className="metric">
          <div className="metric-head"><div><span>GRAPHICS</span><h2>GPU</h2></div><strong>{gpuNow == null ? 'Not available' : percent(gpuNow)}</strong></div>
          {s.gpu.supported ? g('GPU utilization', [{ values: view(h.gpu), color: 'var(--green)', label: 'GPU (busiest engine)' }], percent, 100) : <p className="muted">Windows exposes no GPU performance counters on this system, so utilization cannot be shown.</p>}
          <h3 className="sub-h">Adapters</h3>
          <table className="mini-table"><thead><tr><th>Adapter</th><th>Driver</th><th>Dedicated memory</th></tr></thead><tbody>{s.gpu_adapters.map(a => <tr key={a.name}><td>{a.name}</td><td>{a.driver_version ?? '—'}{a.driver_date ? ` (${a.driver_date})` : ''}</td><td>{a.dedicated_memory ? bytes(a.dedicated_memory) : 'Not reported'}</td></tr>)}</tbody></table>
          {s.gpu.live.length > 0 && <><h3 className="sub-h">Live counters by adapter</h3>
            <table className="mini-table"><thead><tr><th>Adapter LUID</th><th>Busiest engine</th><th>Dedicated in use</th><th>Shared in use</th><th>Engines</th></tr></thead><tbody>{s.gpu.live.map(l => <tr key={l.luid}><td title={l.luid}>{l.luid.replace('luid_0x00000000_', '')}</td><td>{percent(l.percent)}</td><td>{l.dedicated_used == null ? '—' : bytes(l.dedicated_used)}</td><td>{l.shared_used == null ? '—' : bytes(l.shared_used)}</td><td>{l.engines.filter(e => e.percent > 0.5).map(e => `${e.engine_type} ${e.percent.toFixed(0)}%`).join(', ') || 'idle'}</td></tr>)}</tbody></table></>}
          <p className="muted">GPU temperature, clock speed and power are not available through Windows' standard counters, so they are not shown. With several GPUs, counters are listed by LUID because Windows does not map them to adapter names without DXGI.</p>
        </article>}
        {!s && <div className="empty">Waiting for the first reading…</div>}
      </div>
    </div>
  </section>;
}
