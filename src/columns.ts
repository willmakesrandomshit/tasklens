import { bytes, duration, percent, procKey, rate, type ProcessInfo } from './model';
import type { ColumnLayout, FileInfo, Grouping } from './api';

export interface ColumnContext { now: number; files: Map<string, FileInfo>; cores: number }

export interface ColumnDef {
  id: string;
  label: string;
  width: number;
  numeric?: boolean;
  /** Sort/filter value. `null` sorts last. */
  value: (p: ProcessInfo, ctx: ColumnContext) => string | number | null;
  /** Display text; defaults to the value. */
  text?: (p: ProcessInfo, ctx: ColumnContext) => string;
  /** 0..1 intensity for the subtle usage heatmap. */
  heat?: (p: ProcessInfo, ctx: ColumnContext, max: number) => number;
  /** Needs the on-demand file-version lookup (publisher, description, signature). */
  lazy?: boolean;
  hint?: string;
}

const dash = '—';
const num = (v: number | null | undefined) => (v == null ? dash : String(v));
const file = (p: ProcessInfo, ctx: ColumnContext) => (p.exe ? ctx.files.get(p.exe.toLowerCase()) : undefined);

export const COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', width: 240, value: p => p.name.toLowerCase(), text: p => p.name },
  { id: 'pid', label: 'PID', width: 64, numeric: true, value: p => p.pid },
  { id: 'parent', label: 'Parent PID', width: 80, numeric: true, value: p => p.parent_pid, text: p => num(p.parent_pid) },
  { id: 'cpu', label: 'CPU', width: 72, numeric: true, value: p => p.cpu_usage, text: p => percent(p.cpu_usage), heat: (p, _c, max) => (max ? p.cpu_usage / max : 0), hint: 'Share of total CPU capacity (all logical processors).' },
  { id: 'memory', label: 'Memory', width: 84, numeric: true, value: p => p.memory, text: p => bytes(p.memory), heat: (p, _c, max) => (max ? p.memory / max : 0), hint: 'Working set: physical memory currently used.' },
  { id: 'private', label: 'Private bytes', width: 96, numeric: true, value: p => p.private_bytes ?? null, text: p => (p.private_bytes == null ? dash : bytes(p.private_bytes)), hint: 'Commit charge that cannot be shared.' },
  { id: 'peak', label: 'Peak working set', width: 110, numeric: true, value: p => p.peak_working_set ?? null, text: p => (p.peak_working_set == null ? dash : bytes(p.peak_working_set)) },
  { id: 'gpu', label: 'GPU', width: 64, numeric: true, value: p => p.gpu_percent ?? null, text: p => (p.gpu_percent == null ? dash : percent(p.gpu_percent)), heat: p => (p.gpu_percent ?? 0) / 100, hint: 'Peak engine utilisation; — when Windows reports no GPU counters.' },
  { id: 'disk_read', label: 'I/O read', width: 84, numeric: true, value: p => p.io_read_per_s ?? null, text: p => rate(p.io_read_per_s), hint: 'All I/O the process performs (files, pipes, devices), not necessarily physical disk traffic.' },
  { id: 'disk_write', label: 'I/O write', width: 84, numeric: true, value: p => p.io_write_per_s ?? null, text: p => rate(p.io_write_per_s), hint: 'All I/O the process performs, not necessarily physical disk traffic.' },
  { id: 'threads', label: 'Threads', width: 70, numeric: true, value: p => p.thread_count ?? null, text: p => num(p.thread_count) },
  { id: 'handles', label: 'Handles', width: 70, numeric: true, value: p => p.handle_count ?? null, text: p => num(p.handle_count) },
  { id: 'status', label: 'Status', width: 84, value: p => p.status.toLowerCase(), text: p => p.status },
  { id: 'user', label: 'User', width: 150, value: p => p.user?.toLowerCase() ?? null, text: p => p.user ?? dash },
  { id: 'session', label: 'Session', width: 66, numeric: true, value: p => p.session_id ?? null, text: p => num(p.session_id) },
  { id: 'arch', label: 'Arch', width: 60, value: p => p.architecture ?? null, text: p => p.architecture ?? dash },
  { id: 'priority', label: 'Priority', width: 96, value: p => p.priority?.toLowerCase() ?? null, text: p => p.priority ?? dash },
  { id: 'start', label: 'Started', width: 150, value: p => p.start_time || null, text: p => (p.start_time ? new Date(p.start_time * 1000).toLocaleString() : dash) },
  { id: 'uptime', label: 'Uptime', width: 80, numeric: true, value: (p, c) => (p.start_time ? c.now - p.start_time : null), text: (p, c) => (p.start_time ? duration(c.now - p.start_time) : dash) },
  { id: 'cpu_time', label: 'CPU time', width: 84, numeric: true, value: p => p.cpu_time_ms ?? null, text: p => (p.cpu_time_ms == null ? dash : duration(p.cpu_time_ms / 1000)) },
  { id: 'publisher', label: 'Publisher', width: 150, lazy: true, value: (p, c) => file(p, c)?.company?.toLowerCase() ?? null, text: (p, c) => file(p, c)?.company ?? dash },
  { id: 'description', label: 'Description', width: 190, lazy: true, value: (p, c) => file(p, c)?.description?.toLowerCase() ?? null, text: (p, c) => file(p, c)?.description ?? dash },
  { id: 'signature', label: 'Signature', width: 130, lazy: true, value: (p, c) => file(p, c)?.signature ?? null, text: (p, c) => file(p, c)?.signature ?? dash, hint: 'Embedded Authenticode only. Unsigned does not mean unsafe.' },
  { id: 'path', label: 'Executable path', width: 320, value: p => p.exe?.toLowerCase() ?? null, text: p => p.exe ?? dash },
  { id: 'command', label: 'Command line', width: 320, value: p => p.command.toLowerCase() || null, text: p => p.command || dash },
];

export const COLUMN_BY_ID = new Map(COLUMNS.map(c => [c.id, c]));
export const DEFAULT_VISIBLE = ['name', 'pid', 'cpu', 'memory', 'gpu', 'disk_read', 'disk_write', 'threads', 'handles', 'status', 'user'];

export function defaultLayout(): ColumnLayout {
  return { order: COLUMNS.map(c => c.id), visible: [...DEFAULT_VISIBLE], widths: {} };
}

/** Repairs a stored layout: drops unknown columns, appends new ones, keeps Name visible and first. */
export function normalizeLayout(layout: ColumnLayout | undefined): ColumnLayout {
  const base = defaultLayout();
  if (!layout) return base;
  const known = new Set(COLUMNS.map(c => c.id));
  const order = [...layout.order.filter(id => known.has(id)), ...base.order.filter(id => !layout.order.includes(id))];
  const visible = layout.visible.filter(id => known.has(id));
  if (!visible.includes('name')) visible.unshift('name');
  const widths: Record<string, number> = {};
  for (const [id, w] of Object.entries(layout.widths ?? {})) if (known.has(id) && Number.isFinite(w)) widths[id] = Math.min(800, Math.max(40, w));
  return { order: ['name', ...order.filter(id => id !== 'name')], visible, widths };
}

export function visibleColumns(layout: ColumnLayout): ColumnDef[] {
  const shown = new Set(layout.visible);
  return layout.order.filter(id => shown.has(id)).map(id => COLUMN_BY_ID.get(id)!).filter(Boolean);
}

export interface SortSpec { id: string; desc: boolean }

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // missing values always sort last
  if (b === null) return -1;
  return typeof a === 'string' && typeof b === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : Number(a) - Number(b);
}

/** Multi-column sort; missing values stay last regardless of direction. PID breaks ties. */
export function sortProcesses(list: ProcessInfo[], sorts: SortSpec[], ctx: ColumnContext): ProcessInfo[] {
  const specs = sorts.map(s => ({ col: COLUMN_BY_ID.get(s.id), desc: s.desc })).filter(s => s.col);
  return [...list].sort((a, b) => {
    for (const { col, desc } of specs) {
      const va = col!.value(a, ctx), vb = col!.value(b, ctx);
      if (va === null || vb === null) { const c = compare(va, vb); if (c) return c; continue; }
      const c = compare(va, vb);
      if (c) return desc ? -c : c;
    }
    return a.pid - b.pid;
  });
}

/** Case-insensitive match over name, PID, path, command, user, and (when known) publisher/description. */
export function matchesQuery(p: ProcessInfo, needle: string, ctx: ColumnContext): boolean {
  if (!needle) return true;
  const f = file(p, ctx);
  const hay = `${p.name} ${p.pid} ${p.exe ?? ''} ${p.command} ${p.user ?? ''} ${f?.company ?? ''} ${f?.description ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

export type DisplayRow =
  | { kind: 'process'; process: ProcessInfo; depth: number; hasChildren: boolean; expanded: boolean; key: string }
  | { kind: 'group'; key: string; label: string; count: number; cpu: number; memory: number; expanded: boolean };

export function groupKey(p: ProcessInfo, mode: Grouping): string {
  switch (mode) {
    case 'app': return (p.exe ?? p.name).toLowerCase();
    case 'user': return p.user ?? 'Unknown user';
    case 'session': return `Session ${p.session_id ?? '?'}`;
    default: return '';
  }
}

export function groupLabel(p: ProcessInfo, mode: Grouping): string {
  if (mode === 'app') return p.name;
  return groupKey(p, mode);
}

/** Groups already-sorted processes; groups are ordered by their aggregate CPU. */
export function buildGroups(sorted: ProcessInfo[], mode: Grouping, expanded: ReadonlySet<string>): DisplayRow[] {
  const groups = new Map<string, { label: string; members: ProcessInfo[] }>();
  for (const p of sorted) {
    const k = groupKey(p, mode);
    const g = groups.get(k) ?? { label: groupLabel(p, mode), members: [] };
    g.members.push(p);
    groups.set(k, g);
  }
  const rows: DisplayRow[] = [];
  const ordered = [...groups.entries()].map(([key, g]) => ({ key, ...g, cpu: g.members.reduce((a, p) => a + p.cpu_usage, 0), memory: g.members.reduce((a, p) => a + p.memory, 0) }))
    .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.label.localeCompare(b.label));
  for (const g of ordered) {
    const open = expanded.has(`group:${g.key}`);
    rows.push({ kind: 'group', key: `group:${g.key}`, label: g.label, count: g.members.length, cpu: g.cpu, memory: g.memory, expanded: open });
    if (open) for (const p of g.members) rows.push({ kind: 'process', process: p, depth: 1, hasChildren: false, expanded: false, key: procKey(p) });
  }
  return rows;
}
