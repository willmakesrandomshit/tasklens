import { useState } from 'react';
import { call } from './api';
import { useAction } from './hooks';
import { useSettings } from './settings';

const ACCENTS = ['#4f8cff', '#2bb3a3', '#8b6df0', '#e0833a', '#d9506e', '#3fa65a'];

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong>{hint && <p>{hint}</p>}</div><div className="setting-control">{children}</div></div>;
}

export function SettingsPage() {
  const { settings: s, update, autostart, setAutostart, note, saveError, loaded } = useSettings();
  const action = useAction();
  const [hex, setHex] = useState(s.accent);
  const set = (change: Parameters<typeof update>[0]) => update(change);
  return <section className="page settings-page">
    <div className="page-heading"><div><div className="eyebrow">PERSONALIZATION</div><h1>Settings</h1><p>Stored on this computer in the app's data folder. Nothing is sent anywhere.</p></div></div>
    {note && <div className="error-banner" role="alert">{note}</div>}
    {saveError && <div className="error-banner" role="alert"><strong>Could not save settings.</strong> {saveError}</div>}
    {!loaded && <p className="muted">Loading settings…</p>}
    {action.message && <div className={action.message.ok ? 'action-ok' : 'action-error'} role="status">{action.message.text}</div>}

    <div className="settings-block"><h2>Appearance</h2>
      <Row title="Theme" hint="Follow Windows or pick one."><select value={s.theme} onChange={e => set(x => ({ ...x, theme: e.target.value as typeof s.theme }))} aria-label="Theme"><option value="system">Use system setting</option><option value="dark">Dark</option><option value="light">Light</option></select></Row>
      <Row title="Accent color"><div className="swatches" role="radiogroup" aria-label="Accent color">{ACCENTS.map(c => <button key={c} role="radio" aria-checked={s.accent === c} aria-label={`Accent ${c}`} className={`swatch${s.accent === c ? ' on' : ''}`} style={{ background: c }} onClick={() => { setHex(c); set(x => ({ ...x, accent: c })); }} />)}
        <input className="field narrow" value={hex} onChange={e => { setHex(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) set(x => ({ ...x, accent: e.target.value })); }} aria-label="Custom accent hex" /></div></Row>
      <Row title="Density" hint="Compact fits more rows."><select value={s.density} onChange={e => set(x => ({ ...x, density: e.target.value as typeof s.density }))} aria-label="Density"><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></Row>
      <Row title="Text size"><input type="range" min={0.85} max={1.5} step={0.05} value={s.font_scale} onChange={e => set(x => ({ ...x, font_scale: Number(e.target.value) }))} aria-label="Text size" /> <span>{Math.round(s.font_scale * 100)}%</span></Row>
      <Row title="Reduce motion" hint="Turns off transitions."><input type="checkbox" checked={s.reduced_motion} onChange={e => set(x => ({ ...x, reduced_motion: e.target.checked }))} aria-label="Reduce motion" /></Row>
    </div>

    <div className="settings-block"><h2>Monitoring</h2>
      <Row title="Refresh interval" hint="How often the window updates. Collection pauses when the window is hidden unless history, alerts or the tray need it."><select value={s.refresh_ms} onChange={e => set(x => ({ ...x, refresh_ms: Number(e.target.value) }))} aria-label="Refresh interval"><option value={500}>0.5 seconds</option><option value={1000}>1 second</option><option value={2000}>2 seconds</option><option value={5000}>5 seconds</option><option value={10000}>10 seconds</option></select></Row>
      <Row title="Confirm before ending processes" hint="Strongly recommended."><input type="checkbox" checked={s.confirm_destructive} onChange={e => set(x => ({ ...x, confirm_destructive: e.target.checked }))} aria-label="Confirm destructive actions" /></Row>
    </div>

    <div className="settings-block"><h2>History</h2>
      <Row title="Record history" hint="Off by default. Stored locally in a bounded database."><input type="checkbox" checked={s.history.enabled} onChange={e => set(x => ({ ...x, history: { ...x.history, enabled: e.target.checked } }))} aria-label="Record history" /></Row>
      <Row title="Sampling interval"><select value={s.history.interval_s} onChange={e => set(x => ({ ...x, history: { ...x.history, interval_s: Number(e.target.value) } }))} aria-label="History interval">{[1, 5, 15, 30, 60, 300].map(v => <option key={v} value={v}>{v < 60 ? `${v} s` : `${v / 60} min`}</option>)}</select></Row>
      <Row title="Keep for"><select value={s.history.retention_days} onChange={e => set(x => ({ ...x, history: { ...x.history, retention_days: Number(e.target.value) } }))} aria-label="Retention">{[1, 3, 7, 14, 30, 90].map(v => <option key={v} value={v}>{v} day{v > 1 ? 's' : ''}</option>)}</select></Row>
      <Row title="Size limit"><select value={s.history.max_mb} onChange={e => set(x => ({ ...x, history: { ...x.history, max_mb: Number(e.target.value) } }))} aria-label="Size limit">{[10, 50, 100, 250, 500].map(v => <option key={v} value={v}>{v} MB</option>)}</select></Row>
      <Row title="Clear recorded data"><button className="danger-button" onClick={() => void action.run(async () => { if (!window.confirm('Delete all recorded history?')) return; await call('history_clear'); return 'History cleared.'; })}>Clear history</button></Row>
    </div>

    <div className="settings-block"><h2>Application</h2>
      <Row title="Start with Windows" hint="Opt-in. Adds one entry to your Run key (visible on the Startup page), starts minimized."><input type="checkbox" checked={autostart} onChange={e => void action.run(async () => { await setAutostart(e.target.checked); return e.target.checked ? 'TaskLens will start with Windows.' : 'TaskLens will no longer start with Windows.'; })} aria-label="Start with Windows" /></Row>
      <Row title="Start minimized"><input type="checkbox" checked={s.app.start_minimized} onChange={e => set(x => ({ ...x, app: { ...x.app, start_minimized: e.target.checked } }))} aria-label="Start minimized" /></Row>
      <Row title="System tray icon" hint="Shows CPU and memory in the tooltip; left-click opens the window."><input type="checkbox" checked={s.app.tray_enabled} onChange={e => set(x => ({ ...x, app: { ...x.app, tray_enabled: e.target.checked, minimize_to_tray: e.target.checked ? x.app.minimize_to_tray : false } }))} aria-label="System tray icon" /></Row>
      <Row title="Close to tray" hint="Closing the window keeps TaskLens running in the tray."><input type="checkbox" disabled={!s.app.tray_enabled} checked={s.app.minimize_to_tray} onChange={e => set(x => ({ ...x, app: { ...x.app, minimize_to_tray: e.target.checked } }))} aria-label="Close to tray" /></Row>
      <Row title="Always on top"><input type="checkbox" checked={s.app.always_on_top} onChange={e => set(x => ({ ...x, app: { ...x.app, always_on_top: e.target.checked } }))} aria-label="Always on top" /></Row>
      <Row title="Compact monitor" hint="A small always-on-top window with the essentials."><input type="checkbox" checked={s.app.compact} onChange={e => set(x => ({ ...x, app: { ...x.app, compact: e.target.checked } }))} aria-label="Compact monitor" /></Row>
      <Row title="In-app alert notices"><input type="checkbox" checked={s.app.notify_in_app} onChange={e => set(x => ({ ...x, app: { ...x.app, notify_in_app: e.target.checked } }))} aria-label="In-app alert notices" /></Row>
    </div>

    <div className="settings-block"><h2>Privacy</h2><p>TaskLens has no telemetry, accounts or network features. Readings stay on this device. Command lines are shown with likely secrets hidden unless you choose to reveal them.</p></div>
  </section>;
}
