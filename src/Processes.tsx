import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, type Grouping, type TreeResult } from './api';
import { buildGroups, COLUMNS, matchesQuery, normalizeLayout, sortProcesses, visibleColumns, type ColumnContext, type DisplayRow, type SortSpec } from './columns';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { useAction, useFileInfo } from './hooks';
import { emptySeries, Inspector, pushSeries, type ProcSeries } from './Inspector';
import { bytes, buildTreeRows, percent, procKey, redactCommand, type ProcessInfo, type Snapshot } from './model';
import { ProcessTable } from './ProcessTable';
import { useSettings } from './settings';
import { revealInExplorer } from './usePolling';

export type Page = 'Overview' | 'Processes' | 'Performance' | 'Resource Monitor' | 'Startup' | 'Services' | 'Users' | 'Network' | 'History' | 'Alerts' | 'System' | 'Settings';

interface Props {
  snapshot: Snapshot | null;
  error: string | null;
  interval: number;
  onNavigate: (page: Page, search?: string) => void;
  focusSearch: number;
}

const PRIORITIES: [string, string][] = [['high', 'High'], ['above_normal', 'Above normal'], ['normal', 'Normal'], ['below_normal', 'Below normal'], ['idle', 'Low (idle)']];

export function Processes({ snapshot, error, interval, onNavigate, focusSearch }: Props) {
  const { settings, update } = useSettings();
  const ui = settings.ui ?? {};
  const layout = useMemo(() => normalizeLayout(ui.columns), [ui.columns]);
  const columns = useMemo(() => visibleColumns(layout), [layout]);
  const grouping: Grouping = ui.grouping ?? 'flat';
  const sorts: SortSpec[] = ui.sort?.length ? ui.sort : [{ id: 'cpu', desc: true }];
  const pinned = useMemo(() => new Set((ui.pinned ?? []).map(n => n.toLowerCase())), [ui.pinned]);
  const rowHeight = settings.density === 'compact' ? 26 : 34;

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inspect, setInspect] = useState(false);
  const [series, setSeries] = useState<ProcSeries>(emptySeries());
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'end' | 'tree'; process: ProcessInfo; children: number } | null>(null);
  const [affinity, setAffinity] = useState<{ process: ProcessInfo; mask: bigint; system: bigint } | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const action = useAction();

  useEffect(() => { if (focusSearch) searchRef.current?.focus(); }, [focusSearch]);

  const all = snapshot?.processes ?? [];
  const needle = query.trim().toLowerCase();
  const lazyVisible = columns.some(c => c.lazy);
  const [paths, setPaths] = useState<string[]>([]);
  const files = useFileInfo(paths, lazyVisible || needle.length > 0);
  const ctx: ColumnContext = useMemo(() => ({ now: snapshot?.timestamp ?? Date.now() / 1000, files, cores: snapshot?.logical_cores ?? 1 }), [snapshot, files]);

  const rows: DisplayRow[] = useMemo(() => {
    const sortList = (list: ProcessInfo[]) => sortProcesses(list, sorts, ctx);
    const toRow = (process: ProcessInfo, depth = 0, hasChildren = false, open = false): DisplayRow => ({ kind: 'process', process, depth, hasChildren, expanded: open, key: procKey(process) });
    if (grouping === 'tree' && !needle) return buildTreeRows(all, expanded, 'pid', true, sortList).map(r => toRow(r.process, r.depth, r.hasChildren, r.expanded));
    const filtered = needle ? all.filter(p => matchesQuery(p, needle, ctx)) : all;
    const sorted = sortList(filtered);
    // Pinned processes float to the top of flat views.
    const arranged = pinned.size ? [...sorted.filter(p => pinned.has(p.name.toLowerCase())), ...sorted.filter(p => !pinned.has(p.name.toLowerCase()))] : sorted;
    if (grouping === 'app' || grouping === 'user' || grouping === 'session') return buildGroups(arranged, grouping, expanded);
    return arranged.map(p => toRow(p));
  }, [all, needle, grouping, expanded, sorts, ctx, pinned]);

  // Executables for the visible window, so publisher/description/signature are fetched lazily.
  const visibleKey = useRef('');
  useEffect(() => {
    const exes = rows.slice(0, 60).flatMap(r => (r.kind === 'process' && r.process.exe ? [r.process.exe] : []));
    const k = exes.join('|');
    if (k !== visibleKey.current) { visibleKey.current = k; setPaths(exes); }
  }, [rows]);

  const byKey = useMemo(() => new Map(all.map(p => [procKey(p), p])), [all]);
  const byPid = useMemo(() => new Map(all.map(p => [p.pid, p])), [all]);
  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;
  const maxCpu = useMemo(() => Math.max(1, ...all.map(p => p.cpu_usage)), [all]);
  const maxMemory = useMemo(() => Math.max(1, ...all.map(p => p.memory)), [all]);

  // Per-process history for the inspector: restart when the selection changes, append every snapshot.
  useEffect(() => { setSeries(emptySeries()); }, [selectedKey]);
  useEffect(() => { if (selected) setSeries(s => pushSeries(s, selected)); }, [snapshot]);

  const childrenOf = useCallback((p: ProcessInfo) => all.filter(c => c.parent_pid === p.pid && c.pid !== p.pid && c.start_time >= p.start_time), [all]);
  const descendantCount = useCallback((p: ProcessInfo): number => {
    const seen = new Set<number>([p.pid]); const queue = [p];
    while (queue.length) { for (const c of childrenOf(queue.shift()!)) if (!seen.has(c.pid)) { seen.add(c.pid); queue.push(c); } }
    return seen.size - 1;
  }, [childrenOf]);

  const patchUi = (change: (u: NonNullable<typeof settings.ui>) => NonNullable<typeof settings.ui>) => update(s => ({ ...s, ui: change(s.ui ?? {}) }));
  const setLayout = (l: typeof layout) => patchUi(u => ({ ...u, columns: l }));
  const onSort = (id: string, additive: boolean) => patchUi(u => {
    const cur = u.sort?.length ? u.sort : [{ id: 'cpu', desc: true }];
    const col = COLUMNS.find(c => c.id === id);
    const first = cur.find(s => s.id === id);
    const next = additive
      ? first ? cur.map(s => (s.id === id ? { ...s, desc: !s.desc } : s)) : [...cur, { id, desc: !!col?.numeric }]
      : [{ id, desc: first ? !first.desc : !!col?.numeric }];
    return { ...u, sort: next };
  });
  const toggle = (key: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const togglePin = (p: ProcessInfo) => patchUi(u => { const cur = (u.pinned ?? []).map(x => x.toLowerCase()); const n = p.name.toLowerCase(); return { ...u, pinned: cur.includes(n) ? cur.filter(x => x !== n) : [...cur, n] }; });

  const doEnd = async (kind: 'end' | 'tree', p: ProcessInfo) => {
    setConfirm(null);
    await action.run(async () => {
      if (kind === 'end') { await call('terminate_process', { pid: p.pid, identity: p.identity }); return `Ended ${p.name} (${p.pid}).`; }
      const r = await call<TreeResult>('terminate_process_tree', { pid: p.pid, identity: p.identity });
      if (r.failed.length) throw new Error(`Ended ${r.ended} process(es), but ${r.failed.join('; ')}`);
      return `Ended ${r.ended} process(es) in the tree of ${p.name}.`;
    });
    setSelectedKey(null);
  };
  const askEnd = (kind: 'end' | 'tree', p: ProcessInfo) => {
    if (!settings.confirm_destructive) void doEnd(kind, p);
    else setConfirm({ kind, process: p, children: kind === 'tree' ? descendantCount(p) : 0 });
  };
  const suspend = (p: ProcessInfo) => action.run(async () => { const n = await call<number>('suspend_process', { pid: p.pid, identity: p.identity, suspend: !p.suspended }); return `${p.suspended ? 'Resumed' : 'Suspended'} ${p.name} (${n} threads).`; });
  const setPriority = (p: ProcessInfo, pr: string, label: string) => action.run(async () => { await call('set_process_priority', { pid: p.pid, identity: p.identity, priority: pr }); return `${p.name} priority set to ${label}.`; });
  const openAffinity = (p: ProcessInfo) => action.run(async () => {
    const [mask, system] = await call<[number, number]>('get_process_affinity', { pid: p.pid, identity: p.identity });
    setAffinity({ process: p, mask: BigInt(mask), system: BigInt(system) });
  });
  const copy = (text: string, what: string) => action.run(async () => { await navigator.clipboard.writeText(text); return `Copied ${what}.`; });

  const menuItems = (p: ProcessInfo): MenuItem[] => {
    const noId = p.identity ? undefined : 'Windows did not allow TaskLens to open this process, so it cannot be changed safely.';
    const parent = p.parent_pid != null ? byPid.get(p.parent_pid) : undefined;
    const kids = childrenOf(p);
    return [
      { label: 'End process', danger: true, disabled: !!noId, title: noId, onSelect: () => askEnd('end', p) },
      { label: 'End process tree', danger: true, disabled: !!noId, title: noId ?? 'End this process and all processes it started', onSelect: () => askEnd('tree', p) },
      { label: p.suspended ? 'Resume' : 'Suspend', disabled: !!noId, title: noId, onSelect: () => void suspend(p) },
      { label: 'Set priority', disabled: !!noId, title: noId, submenu: PRIORITIES.map(([id, label]) => ({ label, onSelect: () => void setPriority(p, id, label), title: id === 'high' ? 'High priority can make other programs less responsive' : undefined })) },
      { label: 'Set affinity…', disabled: !!noId, title: noId, onSelect: () => void openAffinity(p) },
      { separator: true, label: '' },
      { label: 'Open file location', disabled: !p.exe, title: p.exe ? undefined : 'Executable path unavailable', onSelect: () => void action.run(async () => { const e = await revealInExplorer(p.exe!); if (e) throw new Error(e); }) },
      { label: 'Copy PID', onSelect: () => void copy(String(p.pid), 'PID') },
      { label: 'Copy path', disabled: !p.exe, onSelect: () => void copy(p.exe!, 'path') },
      { label: 'Copy command line (secrets hidden)', disabled: !p.command, onSelect: () => void copy(redactCommand(p.command), 'redacted command line') },
      { separator: true, label: '' },
      { label: 'Properties', onSelect: () => setInspect(true) },
      { label: 'Show parent process', disabled: !parent, title: parent ? undefined : 'The parent has exited or is unknown', onSelect: () => parent && setSelectedKey(procKey(parent)) },
      { label: `Show child processes (${kids.length})`, disabled: !kids.length, onSelect: () => { update(s => ({ ...s, ui: { ...(s.ui ?? {}), grouping: 'tree' } })); setQuery(''); setExpanded(prev => new Set(prev).add(procKey(p))); } },
      { label: 'View network connections', onSelect: () => onNavigate('Network', String(p.pid)) },
      { label: 'View associated services', onSelect: () => onNavigate('Services', String(p.pid)) },
      { label: 'View resource history', onSelect: () => setInspect(true) },
      { separator: true, label: '' },
      { label: pinned.has(p.name.toLowerCase()) ? 'Unpin' : 'Pin to top', onSelect: () => togglePin(p) },
    ];
  };

  const menuProcess = menu ? byKey.get(menu.key) : undefined;
  const flat = !needle && grouping === 'flat';
  const total = all.length;
  const filters = ui.filters ?? [];

  return <section className="page process-page">
    <div className="page-heading">
      <div><div className="eyebrow">SYSTEM OVERVIEW</div><h1>Processes</h1><p>See what's running and where your resources are going.</p></div>
      <div className="heading-actions"><span className="count-pill">{snapshot ? `${total} processes` : 'Awaiting data'}</span></div>
    </div>
    {error && <div className="error-banner" role="alert"><strong>Monitoring unavailable.</strong> {error}</div>}
    <div className="summary-strip">
      <div><span>CPU</span><strong>{snapshot ? percent(snapshot.cpu_usage) : '—'}</strong><small>overall utilization</small></div>
      <div><span>MEMORY</span><strong>{snapshot && snapshot.total_memory ? percent(snapshot.used_memory / snapshot.total_memory * 100) : '—'}</strong><small>{snapshot ? `${bytes(snapshot.used_memory)} in use` : 'awaiting data'}</small></div>
      <div><span>PROCESSES</span><strong>{snapshot?.processes.length ?? '—'}</strong><small>currently running</small></div>
      <div className="summary-note"><span>{snapshot?.cpu_model || 'System information unavailable'}</span></div>
    </div>
    {(action.message) && <div className={action.message.ok ? 'action-ok' : 'action-error'} role="status">{action.message.text}</div>}
    <div className="table-toolbar">
      <label className="search"><span className="sr-only">Search processes</span><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, PID, path, user, publisher" aria-label="Search processes" /><kbd>Ctrl F</kbd></label>
      <select value={grouping} onChange={e => { setExpanded(new Set()); patchUi(u => ({ ...u, grouping: e.target.value as Grouping })); }} aria-label="Grouping">
        <option value="flat">Flat list</option><option value="tree">Process tree</option><option value="app">Group by application</option><option value="user">Group by user</option><option value="session">Group by session</option>
      </select>
      <select value="" onChange={e => { const f = filters.find(x => x.name === e.target.value); if (f) setQuery(f.query); }} aria-label="Saved filters"><option value="">Saved filters…</option>{filters.map(f => <option key={f.name}>{f.name}</option>)}</select>
      <button className="secondary-button" disabled={!needle} title={needle ? 'Save the current search as a filter' : 'Type a search first'} onClick={() => { const name = window.prompt('Name this filter'); if (name) patchUi(u => ({ ...u, filters: [...(u.filters ?? []).filter(f => f.name !== name), { name, query }] })); }}>Save filter</button>
      <div className="menu-anchor">
        <button className="secondary-button" aria-expanded={columnsOpen} onClick={() => setColumnsOpen(o => !o)}>Columns</button>
        {columnsOpen && <div className="popover" role="dialog" aria-label="Choose columns">
          {layout.order.map(id => { const c = COLUMNS.find(x => x.id === id)!; return <label key={id}><input type="checkbox" checked={layout.visible.includes(id)} disabled={id === 'name'} onChange={e => setLayout({ ...layout, visible: e.target.checked ? [...layout.visible, id] : layout.visible.filter(v => v !== id) })} /> {c.label}</label>; })}
          <button className="secondary-button" onClick={() => patchUi(u => ({ ...u, columns: undefined }))}>Reset columns</button>
        </div>}
      </div>
      <span className="muted">{rows.length} shown</span>
    </div>
    <div className="table-wrap">
      <ProcessTable rows={rows} columns={columns} widths={layout.widths} rowHeight={rowHeight} ctx={ctx} sorts={sorts} selectedKey={selectedKey} pinned={pinned} query={query} treeMode={grouping === 'tree' && !needle}
        maxCpu={maxCpu} maxMemory={maxMemory} onSelect={k => { setSelectedKey(k); if (k && byKey.has(k)) setInspect(true); }} onContext={(key, x, y) => setMenu({ key, x, y })} onToggle={toggle} onSort={onSort}
        onResize={(id, w) => setLayout({ ...layout, widths: { ...layout.widths, [id]: w } })}
        onReorder={(from, to) => { const order = layout.order.filter(i => i !== from); order.splice(order.indexOf(to), 0, from); setLayout({ ...layout, order }); }}
        onActivate={() => setInspect(true)} emptyText={snapshot ? 'No processes match your search.' : 'Waiting for the first reading…'} />
      <div className="table-footer"><span>{flat ? 'Click a process to inspect it. Right-click for actions. Shift-click a header to sort by several columns.' : 'Press Enter to open details, arrow keys to move, Left/Right to collapse or expand.'}</span><span>Updated every {interval / 1000}s</span></div>
    </div>
    {inspect && selectedKey && <Inspector process={selected} series={series} interval={interval} parent={selected?.parent_pid != null ? byPid.get(selected.parent_pid) ?? null : null} children={selected ? childrenOf(selected) : []}
      onClose={() => setInspect(false)} onSelectPid={pid => { const t = byPid.get(pid); if (t) setSelectedKey(procKey(t)); }}
      onEnd={() => selected && askEnd('end', selected)} onEndTree={() => selected && askEnd('tree', selected)} onSuspend={() => selected && void suspend(selected)} />}
    {menu && menuProcess && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menuProcess)} onClose={() => setMenu(null)} />}
    {confirm && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="eyebrow">CONFIRM ACTION</div><h2 id="modal-title">End {confirm.kind === 'tree' ? 'process tree of ' : ''}{confirm.process.name}?</h2>
      <p>Windows will terminate PID {confirm.process.pid}{confirm.kind === 'tree' ? ` and ${confirm.children} process${confirm.children === 1 ? '' : 'es'} it started` : ''}. Unsaved work may be lost. TaskLens verifies each process's identity first and refuses protected ones.</p>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setConfirm(null)} autoFocus>Cancel</button><button className="danger-button" onClick={() => void doEnd(confirm.kind, confirm.process)}>End {confirm.kind === 'tree' ? 'tree' : 'process'}</button></div>
    </div></div>}
    {affinity && <AffinityDialog data={affinity} cores={snapshot?.logical_cores ?? 1} onCancel={() => setAffinity(null)} onApply={async mask => { const a = affinity; setAffinity(null); await action.run(async () => { await call('set_process_affinity', { pid: a.process.pid, identity: a.process.identity, mask: Number(mask) }); return `Affinity of ${a.process.name} updated.`; }); }} />}
  </section>;
}

function AffinityDialog({ data, cores, onCancel, onApply }: { data: { process: ProcessInfo; mask: bigint; system: bigint }; cores: number; onCancel: () => void; onApply: (mask: bigint) => void }) {
  const [mask, setMask] = useState(data.mask);
  const bits = Array.from({ length: Math.min(cores, 64) }, (_, i) => i).filter(i => (data.system >> BigInt(i)) & 1n);
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="aff-title">
    <div className="eyebrow">CPU AFFINITY</div><h2 id="aff-title">Processors for {data.process.name}</h2>
    <p>Choose which logical processors this process may use. Restricting a program can slow it down.</p>
    <div className="affinity-grid">{bits.map(i => <label key={i}><input type="checkbox" checked={((mask >> BigInt(i)) & 1n) === 1n} onChange={e => setMask(m => (e.target.checked ? m | (1n << BigInt(i)) : m & ~(1n << BigInt(i))))} /> CPU {i}</label>)}</div>
    <div className="modal-actions"><button className="secondary-button" onClick={onCancel}>Cancel</button><button className="secondary-button" onClick={() => setMask(data.system)}>All</button><button className="danger-button" disabled={mask === 0n} onClick={() => onApply(mask)}>Apply</button></div>
  </div></div>;
}
