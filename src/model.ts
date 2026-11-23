export interface ProcessInfo {
  pid: number; parent_pid: number | null; name: string; cpu_usage: number; memory: number;
  status: string; start_time: number; identity: string | null; exe: string | null; command: string;
}
export interface DiskInfo {
  name: string; mount: string; file_system: string; total: number; available: number;
  read_per_s: number | null; write_per_s: number | null;
}
export interface NetworkInfo {
  name: string; received_per_s: number | null; transmitted_per_s: number | null;
  total_received: number; total_transmitted: number; addresses: string[]; mtu: number;
}
export interface Snapshot {
  timestamp: number; cpu_usage: number; cpu_cores: number[]; cpu_frequency_mhz: number | null;
  total_memory: number; used_memory: number; available_memory: number; total_swap: number; used_swap: number;
  cpu_model: string; logical_cores: number; physical_cores: number | null;
  disks: DiskInfo[]; networks: NetworkInfo[]; processes: ProcessInfo[];
}
export interface TreeRow { process: ProcessInfo; depth: number; hasChildren: boolean; expanded: boolean }

export function percent(n: number): string { return `${n.toFixed(1)}%`; }

export function procKey(p: ProcessInfo): string { return `${p.pid}:${p.identity ?? p.start_time}`; }

/** Bytes per second, or an em dash when no rate is known yet (never a fake zero). */
export function rate(value: number | null): string { return value === null ? '—' : `${bytes(Math.round(value))}/s`; }

/**
 * Flattens processes into parent/child order. A process is a child only if its parent exists AND started no
 * later than the child — otherwise the parent PID was reused and the process is shown as a root.
 */
export function buildTreeRows(processes: ProcessInfo[], expanded: ReadonlySet<string>, sort: SortKey, ascending: boolean): TreeRow[] {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const children = new Map<number, ProcessInfo[]>();
  const roots: ProcessInfo[] = [];
  for (const p of processes) {
    const parent = p.parent_pid === null ? undefined : byPid.get(p.parent_pid);
    if (parent && parent.pid !== p.pid && parent.start_time <= p.start_time) {
      const list = children.get(parent.pid) ?? [];
      list.push(p); children.set(parent.pid, list);
    } else roots.push(p);
  }
  const order = (list: ProcessInfo[]) => selectProcesses(list, '', sort, ascending);
  const rows: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (p: ProcessInfo, depth: number) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    const kids = children.get(p.pid) ?? [];
    const open = expanded.has(procKey(p));
    rows.push({ process: p, depth, hasChildren: kids.length > 0, expanded: open });
    if (open) for (const kid of order(kids)) walk(kid, depth + 1);
  };
  for (const root of order(roots)) walk(root, 0);
  return rows;
}
export type SortKey = 'name' | 'pid' | 'cpu_usage' | 'memory';
export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function selectProcesses(processes: ProcessInfo[], query: string, sort: SortKey, ascending: boolean): ProcessInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  return processes.filter(p => !needle || `${p.name} ${p.pid} ${p.exe ?? ''} ${p.command}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      const left = a[sort], right = b[sort];
      const result = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right) : Number(left) - Number(right);
      return (ascending ? result : -result) || a.pid - b.pid;
    });
}
