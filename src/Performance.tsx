import { bytes, percent, rate, type Snapshot } from './model';

export interface History { cpu: number[]; memory: number[]; netIn: number[]; netOut: number[]; diskRead: number[]; diskWrite: number[] }
export const emptyHistory: History = { cpu: [], memory: [], netIn: [], netOut: [], diskRead: [], diskWrite: [] };

/** Line graph. Percent graphs pass max=100; rate graphs auto-scale to the largest recent value. */
export function Graph({ values, color, color2, values2, max, label }: { values: number[]; color: string; values2?: number[]; color2?: string; max?: number; label: string }) {
  const top = max ?? Math.max(1, ...values, ...(values2 ?? []));
  const line = (series: number[]) => series.map((n, i) => `${(i / 59) * 100},${100 - Math.max(0, Math.min(100, (n / top) * 100))}`).join(' ');
  return <svg className="graph" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}>
    <path d="M0 25H100 M0 50H100 M0 75H100 M25 0V100 M50 0V100 M75 0V100" className="grid" />
    <polyline points={line(values)} fill="none" stroke={color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    {values2 && <polyline points={line(values2)} fill="none" stroke={color2} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />}
  </svg>;
}

export function Performance({ snapshot, history }: { snapshot: Snapshot | null; history: History }) {
  const s = snapshot;
  const memPct = s && s.total_memory ? (s.used_memory / s.total_memory) * 100 : null;
  return <section className="page performance-page">
    <div className="page-heading"><div><div className="eyebrow">SYSTEM OVERVIEW</div><h1>Performance</h1><p>Live resource usage on this device. Values shown as — are not available yet; nothing is estimated.</p></div></div>
    <div className="performance-grid">
      <article className="metric">
        <div className="metric-head"><div><span>PROCESSOR</span><h2>CPU</h2></div><strong>{s ? percent(s.cpu_usage) : '—'}</strong></div>
        <Graph values={history.cpu} color="var(--accent)" max={100} label="CPU utilization history" />
        {s && <div className="cores" role="group" aria-label="Per-core utilization">{s.cpu_cores.map((v, i) => <div className="core" key={i} title={`Logical processor ${i}: ${percent(v)}`}><div className="core-bar"><div className="core-fill" style={{ height: `${Math.max(0, Math.min(100, v))}%` }} /></div><span>{i}</span></div>)}</div>}
        <div className="metric-meta"><span>{s?.cpu_model || 'Unavailable'}</span><span>{s ? `${s.physical_cores ?? '?'} cores, ${s.logical_cores} logical${s.cpu_frequency_mhz ? `, ${(s.cpu_frequency_mhz / 1000).toFixed(2)} GHz reported` : ''}` : ''}</span></div>
      </article>
      <article className="metric">
        <div className="metric-head"><div><span>PHYSICAL MEMORY</span><h2>Memory</h2></div><strong>{memPct === null ? '—' : percent(memPct)}</strong></div>
        <Graph values={history.memory} color="var(--green)" max={100} label="Memory utilization history" />
        <div className="metric-meta"><span>{s ? `${bytes(s.used_memory)} used, ${bytes(s.available_memory)} available` : 'Unavailable'}</span><span>{s ? `${bytes(s.total_memory)} installed${s.total_swap ? `, page file ${bytes(s.used_swap)} / ${bytes(s.total_swap)}` : ''}` : ''}</span></div>
      </article>
      <article className="metric">
        <div className="metric-head"><div><span>STORAGE</span><h2>Disk</h2></div><strong>{s ? `${rate(s.disks.reduce<number | null>((a, d) => d.read_per_s === null ? a : (a ?? 0) + d.read_per_s, null))} read` : '—'}</strong></div>
        <Graph values={history.diskRead} values2={history.diskWrite} color="var(--accent)" color2="var(--green)" label="Disk read and write throughput history" />
        <table className="mini-table"><thead><tr><th>Volume</th><th>Capacity</th><th>Free</th><th>Read</th><th>Write</th></tr></thead>
          <tbody>{s?.disks.map(d => <tr key={`${d.mount}-${d.name}`}><td title={d.name}>{d.mount} <small>{d.file_system}</small></td><td>{bytes(d.total)}</td><td>{bytes(d.available)}</td><td>{rate(d.read_per_s)}</td><td>{rate(d.write_per_s)}</td></tr>)}</tbody></table>
        <div className="metric-meta"><span>Blue: read. Green: write. Per-volume throughput comes from the OS volume counters; active time and response time are not implemented yet.</span></div>
      </article>
      <article className="metric">
        <div className="metric-head"><div><span>NETWORK</span><h2>Adapters</h2></div><strong>{s ? `${rate(s.networks.reduce<number | null>((a, n) => n.received_per_s === null ? a : (a ?? 0) + n.received_per_s, null))} down` : '—'}</strong></div>
        <Graph values={history.netIn} values2={history.netOut} color="var(--accent)" color2="var(--green)" label="Network download and upload history" />
        <table className="mini-table"><thead><tr><th>Adapter</th><th>Down</th><th>Up</th><th>Address</th></tr></thead>
          <tbody>{s?.networks.map(n => <tr key={n.name}><td title={n.name}>{n.name}</td><td>{rate(n.received_per_s)}</td><td>{rate(n.transmitted_per_s)}</td><td>{n.addresses[0] ?? '—'}</td></tr>)}</tbody></table>
        <div className="metric-meta"><span>Blue: download. Green: upload. Link speed and connection status are not implemented yet.</span></div>
      </article>
      <div className="unavailable-row"><div><strong>GPU metrics are not available yet</strong><p>GPU utilization, VRAM and temperatures have not been implemented. No estimated readings are shown.</p></div></div>
    </div>
  </section>;
}
