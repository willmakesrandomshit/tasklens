import { useMemo, useState } from 'react';
import type { Snapshot } from './model';
import { compareValues, usePolling, type SortDir } from './usePolling';

export interface Connection {
  protocol: 'TCP' | 'TCP6' | 'UDP' | 'UDP6'; local_addr: string; local_port: number;
  remote_addr: string | null; remote_port: number | null; state: string | null; pid: number;
}
type Key = 'process' | 'pid' | 'protocol' | 'local' | 'remote' | 'state';

export function Connections({ active, snapshot }: { active: boolean; snapshot: Snapshot | null }) {
  const { data, error, refresh } = usePolling<Connection[]>('list_connections', 3000, active);
  const [query, setQuery] = useState('');
  const [proto, setProto] = useState('All');
  const [state, setState] = useState('All');
  const [sort, setSort] = useState<Key>('process');
  const [dir, setDir] = useState<SortDir>('asc');

  const names = useMemo(() => new Map((snapshot?.processes ?? []).map(p => [p.pid, p.name])), [snapshot]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const view = (data ?? []).map(c => ({
      c, process: c.pid === 0 ? 'System Idle / kernel' : names.get(c.pid) ?? 'Unknown (exited or protected)',
      local: `${c.local_addr}:${c.local_port}`, remote: c.remote_addr ? `${c.remote_addr}:${c.remote_port}` : '',
    }));
    const sign = dir === 'asc' ? 1 : -1;
    const value = (v: typeof view[number]): string | number => sort === 'pid' ? v.c.pid : sort === 'protocol' ? v.c.protocol : sort === 'state' ? v.c.state ?? '' : sort === 'local' ? v.local : sort === 'remote' ? v.remote : v.process;
    return view
      .filter(v => (proto === 'All' || v.c.protocol.startsWith(proto)) && (state === 'All' || v.c.state === state) &&
        (!needle || `${v.process} ${v.c.pid} ${v.local} ${v.remote} ${v.c.state ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => sign * compareValues(value(a), value(b)) || a.c.pid - b.c.pid);
  }, [data, names, query, proto, state, sort, dir]);
  const th = (key: Key, label: string) => <th><button className="column-button" onClick={() => { if (sort === key) setDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSort(key); setDir('asc'); } }} aria-label={`Sort by ${label}`}>{label}{sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>;
  const established = (data ?? []).filter(c => c.state === 'Established').length;

  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">ACTIVITY</div><h1>Network</h1><p>Active TCP connections and UDP endpoints with their owning process. Per-process bandwidth is not measured yet, so none is shown.</p></div><div className="heading-actions"><span className="count-pill">{data ? `${rows.length} of ${data.length} · ${established} established` : 'Loading…'}</span></div></div>
    {error && <div className="error-banner" role="alert"><strong>Could not read connections.</strong> {error}</div>}
    <div className="table-toolbar">
      <label className="search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search process, PID, address, port or state" aria-label="Search connections" /></label>
      <select value={proto} onChange={e => setProto(e.target.value)} aria-label="Protocol"><option>All</option><option>TCP</option><option>UDP</option></select>
      <select value={state} onChange={e => setState(e.target.value)} aria-label="TCP state"><option>All</option><option>Established</option><option>Listen</option><option>TimeWait</option><option>CloseWait</option><option>SynSent</option></select>
      <button className="secondary-button" onClick={refresh}>Refresh</button>
    </div>
    <div className="data-wrap" role="region" aria-label="Connections table">
      <table className="data-table"><thead><tr>{th('process', 'Process')}{th('pid', 'PID')}{th('protocol', 'Protocol')}{th('local', 'Local address')}{th('remote', 'Remote address')}{th('state', 'State')}</tr></thead>
        <tbody>{rows.map((v, i) => <tr key={`${v.c.protocol}-${v.local}-${v.remote}-${v.c.pid}-${i}`}><td>{v.process}</td><td>{v.c.pid}</td><td>{v.c.protocol}</td><td>{v.local}</td><td>{v.remote || '—'}</td><td>{v.c.state ?? '—'}</td></tr>)}</tbody></table>
      {data && rows.length === 0 && <div className="empty">No connections match.</div>}
      {!data && !error && <div className="empty">Reading connections…</div>}
    </div>
  </section>;
}
