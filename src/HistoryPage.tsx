import { useCallback, useEffect, useState } from 'react';
import { call, type AlertEvent, type AlertRule, type HistorySample, type HistoryStats, type ProcEvent, type Spike } from './api';
import { Graph } from './Graph';
import { useAction } from './hooks';
import { bytes, percent, rate } from './model';
import { useSettings } from './settings';
import { usePolling } from './usePolling';

const RANGES: [number, string][] = [[3600, 'Last hour'], [21600, 'Last 6 hours'], [86400, 'Last 24 hours'], [604800, 'Last 7 days']];
const METRIC_LABEL: Record<string, string> = { cpu: 'CPU', memory: 'Memory', gpu: 'GPU', disk_active: 'Disk active time' };

export function HistoryPage() {
  const { settings, update } = useSettings();
  const [range, setRange] = useState(3600);
  const [samples, setSamples] = useState<HistorySample[]>([]);
  const [spikes, setSpikes] = useState<Spike[]>([]);
  const [events, setEvents] = useState<ProcEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const stats = usePolling<HistoryStats | null>('history_stats', 10000, true);
  const action = useAction();

  const load = useCallback(async () => {
    const to = Math.floor(Date.now() / 1000), from = to - range;
    try {
      const [s, sp, ev] = await Promise.all([
        call<HistorySample[]>('history_query', { from, to, maxPoints: 300 }),
        call<Spike[]>('history_spikes', { from, to }),
        call<ProcEvent[]>('history_events', { from, to }),
      ]);
      setSamples(s); setSpikes(sp.sort((a, b) => b.ts - a.ts)); setEvents(ev); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [range]);
  useEffect(() => { void load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const recording = settings.history.enabled;
  const step = samples.length > 1 ? Math.max(1, Math.round(range / samples.length)) : 5;
  const col = <K extends keyof HistorySample>(k: K) => samples.map(s => s[k] as number | null);
  const chart = (label: string, series: { key: keyof HistorySample; color: string; label: string }[], fmt: (n: number) => string, max?: number) =>
    <article className="metric"><h2>{label}</h2><Graph series={series.map(s => ({ values: col(s.key), color: s.color, label: s.label }))} step={step} points={Math.max(samples.length, 2)} format={fmt} label={label} max={max} height={110} /></article>;

  const exportCsv = () => action.run(async () => {
    const to = Math.floor(Date.now() / 1000);
    const csv = await call<string>('history_export', { from: to - range, to });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'tasklens-history.csv'; a.click(); URL.revokeObjectURL(url);
    return 'Exported the selected range as CSV.';
  });
  const clear = () => action.run(async () => { await call('history_clear'); setConfirmClear(false); await load(); return 'History cleared.'; });

  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>History</h1><p>Resource usage recorded on this computer only. Nothing is uploaded.</p></div>
      <div className="heading-actions"><select value={range} onChange={e => setRange(Number(e.target.value))} aria-label="Time range">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div></div>
    <div className="rec-bar">
      <span className={`rec-dot${recording ? ' on' : ''}`} aria-hidden="true" /><strong>{recording ? 'Recording' : 'Recording is off'}</strong>
      <span className="muted">{recording ? `every ${settings.history.interval_s} s · keeps ${settings.history.retention_days} days · max ${settings.history.max_mb} MB` : 'Turn it on to build a history you can look back on.'}</span>
      <button className="secondary-button" onClick={() => update(s => ({ ...s, history: { ...s.history, enabled: !s.history.enabled } }))}>{recording ? 'Pause recording' : 'Start recording'}</button>
      <button className="secondary-button" onClick={() => void exportCsv()} disabled={action.busy || !samples.length}>Export CSV</button>
      <button className="danger-button" onClick={() => setConfirmClear(true)} disabled={!stats.data?.samples}>Clear history</button>
    </div>
    {stats.data && <p className="muted">{stats.data.samples.toLocaleString()} samples · {bytes(stats.data.bytes)} on disk{stats.data.oldest ? ` · since ${new Date(stats.data.oldest * 1000).toLocaleString()}` : ''}</p>}
    {action.message && <div className={action.message.ok ? 'action-ok' : 'action-error'} role="status">{action.message.text}</div>}
    {confirmClear && <div className="confirm-bar" role="alertdialog" aria-label="Confirm clear history"><p>Delete all recorded history? This cannot be undone.</p><div className="button-row"><button className="secondary-button" onClick={() => setConfirmClear(false)}>Cancel</button><button className="danger-button" onClick={() => void clear()}>Delete history</button></div></div>}
    {error && <div className="empty-panel"><strong>{error}</strong></div>}
    {!error && samples.length === 0 && <div className="empty">No samples in this range yet.</div>}
    {samples.length > 0 && <div className="chart-grid">
      {chart('CPU (peak per interval)', [{ key: 'cpu', color: 'var(--accent)', label: 'CPU' }], percent, 100)}
      {chart('Memory (peak)', [{ key: 'mem', color: 'var(--green)', label: 'Memory' }], percent, 100)}
      {chart('GPU (peak)', [{ key: 'gpu', color: 'var(--amber)', label: 'GPU' }], percent, 100)}
      {chart('Disk active time (peak)', [{ key: 'disk_active', color: 'var(--amber)', label: 'Active' }], percent, 100)}
      {chart('Disk throughput', [{ key: 'disk_read', color: 'var(--accent)', label: 'Read' }, { key: 'disk_write', color: 'var(--green)', label: 'Write' }], rate)}
      {chart('Network throughput', [{ key: 'net_rx', color: 'var(--accent)', label: 'Download' }, { key: 'net_tx', color: 'var(--green)', label: 'Upload' }], rate)}
    </div>}
    <h2 className="sub-h">Activity timeline</h2>
    <p className="muted">Spikes are <strong>recorded observations</strong>. The processes listed beside a spike were the busiest at that moment — a correlation, not a confirmed cause. Top processes are recorded only while something is elevated.</p>
    {spikes.length === 0 ? <p className="muted">No spikes found in this range.</p> : <ul className="timeline">{spikes.slice(0, 40).map(sp => <li key={`${sp.ts}${sp.metric}`}>
      <div><span className="tag obs">Observation</span> <strong>{new Date(sp.ts * 1000).toLocaleString()}</strong> — {METRIC_LABEL[sp.metric] ?? sp.metric} peaked at {percent(sp.value)} (typical {percent(sp.baseline)}).</div>
      {sp.processes.length > 0 ? <div className="muted"><span className="tag cor">Correlation</span> Busiest then: {sp.processes.map(p => `${p.name} (${percent(p.cpu)} CPU, ${bytes(p.mem)})`).join('; ')}. Not proven to be the cause.</div> : <div className="muted">No process details were recorded for this moment.</div>}
    </li>)}</ul>}
    <h2 className="sub-h">Process starts and exits</h2>
    {events.length === 0 ? <p className="muted">None recorded in this range.</p> : <div className="data-wrap small"><table className="data-table"><thead><tr><th>Time</th><th>Event</th><th>Process</th><th>PID</th></tr></thead><tbody>{events.map((e, i) => <tr key={i}><td>{new Date(e.ts * 1000).toLocaleTimeString()}</td><td>{e.kind === 'start' ? 'Started' : 'Exited'}</td><td>{e.name}</td><td>{e.pid}</td></tr>)}</tbody></table></div>}
  </section>;
}

const METRICS: [string, string, string][] = [
  ['cpu', 'CPU usage above', '%'], ['memory', 'Memory usage above', '%'], ['gpu', 'GPU usage above', '%'], ['disk_active', 'Disk active time above', '%'],
  ['disk_free', 'Free disk space below', '%'], ['process_cpu', 'A process uses more CPU than', '%'], ['process_exit', 'A process exits', ''],
];

export function AlertsPage() {
  const { settings, update } = useSettings();
  const log = usePolling<AlertEvent[]>('alert_log', 4000, true);
  const rules = settings.alerts;
  const set = (alerts: AlertRule[]) => update(s => ({ ...s, alerts }));
  const edit = (id: string, patch: Partial<AlertRule>) => set(rules.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => set([...rules, { id: `rule-${Date.now()}`, name: 'New alert', metric: 'cpu', threshold: 90, duration_s: 30, cooldown_s: 300, enabled: true, process: null }]);
  return <section className="page">
    <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>Alerts</h1><p>Get notified when something stays high. Alerts only notify — they never end or change a process.</p></div><div className="heading-actions"><button className="secondary-button" onClick={add}>Add alert</button></div></div>
    {rules.length === 0 ? <div className="empty-panel"><strong>No alerts yet</strong><p>Add one, for example "CPU usage above 90% for 30 seconds".</p></div> :
      <div className="rules">{rules.map(r => { const needsProc = r.metric.startsWith('process_'); return <div className="rule" key={r.id}>
        <label className="toggle"><input type="checkbox" checked={r.enabled} onChange={e => edit(r.id, { enabled: e.target.checked })} /> <span className="sr-only">Enabled</span></label>
        <input className="field" value={r.name} onChange={e => edit(r.id, { name: e.target.value })} aria-label="Alert name" />
        <select value={r.metric} onChange={e => edit(r.id, { metric: e.target.value })} aria-label="Condition">{METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {r.metric !== 'process_exit' && <label>Value <input className="field narrow" type="number" min={0} max={100} value={r.threshold} onChange={e => edit(r.id, { threshold: Number(e.target.value) })} aria-label="Threshold percent" />%</label>}
        {needsProc && <input className="field" placeholder="process.exe" value={r.process ?? ''} onChange={e => edit(r.id, { process: e.target.value })} aria-label="Process name" />}
        {r.metric !== 'process_exit' && <label>for <input className="field narrow" type="number" min={0} value={r.duration_s} onChange={e => edit(r.id, { duration_s: Number(e.target.value) })} aria-label="Duration seconds" /> s</label>}
        <label>cooldown <input className="field narrow" type="number" min={10} value={r.cooldown_s} onChange={e => edit(r.id, { cooldown_s: Number(e.target.value) })} aria-label="Cooldown seconds" /> s</label>
        <button className="secondary-button" onClick={() => set(rules.filter(x => x.id !== r.id))}>Delete</button>
        <p className="muted rule-explain">{r.enabled ? 'Active' : 'Off'}: {METRICS.find(m => m[0] === r.metric)?.[1]}{r.metric !== 'process_exit' ? ` ${r.threshold}%` : ''}{needsProc ? ` (${r.process || 'name needed'})` : ''}{r.duration_s && r.metric !== 'process_exit' ? ` for ${r.duration_s} s` : ''}; at most once every ${r.cooldown_s} s. Unavailable metrics never trigger it.</p>
      </div>; })}</div>}
    <h2 className="sub-h">Alert history</h2>
    {(log.data ?? []).length === 0 ? <p className="muted">Nothing has fired this session.</p> : <div className="data-wrap small"><table className="data-table"><thead><tr><th>Time</th><th>Alert</th><th>Details</th></tr></thead><tbody>{(log.data ?? []).map(a => <tr key={`${a.ts}${a.rule_id}`}><td>{new Date(a.ts * 1000).toLocaleTimeString()}</td><td>{a.rule_name}</td><td className="cell-long">{a.message}</td></tr>)}</tbody></table></div>}
    <p className="muted note">Alerts are evaluated by the background engine even when the window is hidden, as long as an alert is enabled. They appear here and as an in-app notice; Windows toast notifications are not implemented.</p>
  </section>;
}
