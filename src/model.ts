export interface ProcessInfo {
  pid: number; parent_pid: number | null; name: string; cpu_usage: number; memory: number;
  status: string; start_time: number; identity: string | null; exe: string | null; command: string;
  user?: string | null; thread_count?: number | null; handle_count?: number | null; priority?: string | null;
  session_id?: number | null; architecture?: string | null; private_bytes?: number | null;
  peak_working_set?: number | null; io_read_bytes?: number | null; io_write_bytes?: number | null;
  cpu_time_ms?: number | null; io_read_per_s?: number | null; io_write_per_s?: number | null;
  gpu_percent?: number | null; suspended?: boolean;
}
export interface DiskInfo {
  name: string; mount: string; file_system: string; total: number; available: number;
}
export interface NetworkInfo {
  name: string; received_per_s: number | null; transmitted_per_s: number | null;
  total_received: number; total_transmitted: number; addresses: string[]; mtu: number;
}
export interface PhysicalDisk {
  name: string; active_percent: number | null; response_ms: number | null;
  read_per_s: number | null; write_per_s: number | null; queue_length: number | null;
}
export interface MemoryDetail {
  commit_total: number | null; commit_limit: number | null; commit_peak: number | null; system_cache: number | null;
  kernel_paged: number | null; kernel_nonpaged: number | null; handle_count: number | null;
  process_count: number | null; thread_count: number | null;
}
export interface GpuLive {
  luid: string; percent: number; engines: { engine_type: string; percent: number }[];
  dedicated_used: number | null; shared_used: number | null;
}
export interface GpuAdapter {
  name: string; driver_version: string | null; driver_date: string | null; provider: string | null; dedicated_memory: number | null;
}
export interface NetAdapter { name: string; description: string; status: string; kind: string; link_speed_bps: number | null }
export interface Snapshot {
  timestamp: number; cpu_usage: number; cpu_cores: number[]; cpu_frequency_mhz: number | null;
  total_memory: number; used_memory: number; available_memory: number; total_swap: number; used_swap: number;
  cpu_model: string; logical_cores: number; physical_cores: number | null;
  memory_detail: MemoryDetail;
  disks: DiskInfo[]; networks: NetworkInfo[];
  perf: { physical_disks: PhysicalDisk[]; memory_lists: { standby: number | null; modified: number | null; free: number | null } };
  gpu: { supported: boolean; live: GpuLive[] }; gpu_adapters: GpuAdapter[]; net_adapters: NetAdapter[]; collect_ms: number;
  processes: ProcessInfo[];
}
export interface TreeRow { process: ProcessInfo; depth: number; hasChildren: boolean; expanded: boolean }

export type SortKey = 'name' | 'pid' | 'cpu_usage' | 'memory';

export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

export function percent(n: number): string { return `${n.toFixed(1)}%`; }

/** Bytes per second, or an em dash when no rate is known yet (never a fake zero). */
export function rate(value: number | null | undefined): string { return value == null ? '—' : `${bytes(Math.round(value))}/s`; }

/** Link speeds are quoted in bits per second, as network hardware is sold. */
export function bitRate(bps: number): string {
  if (bps >= 1e9) return `${+(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${+(bps / 1e6).toFixed(0)} Mbps`;
  return `${Math.round(bps / 1e3)} Kbps`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function procKey(p: ProcessInfo): string { return `${p.pid}:${p.identity ?? p.start_time}`; }

export function selectProcesses(processes: ProcessInfo[], query: string, sort: SortKey, ascending: boolean): ProcessInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  return processes.filter(p => !needle || `${p.name} ${p.pid} ${p.exe ?? ''} ${p.command}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => {
      const left = a[sort], right = b[sort];
      const result = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right) : Number(left) - Number(right);
      return (ascending ? result : -result) || a.pid - b.pid;
    });
}

/**
 * Flattens processes into parent/child order. A process is a child only if its parent exists AND started no
 * later than the child — otherwise the parent PID was reused and the process is shown as a root.
 * `order` sorts siblings.
 */
export function buildTreeRows(
  processes: ProcessInfo[], expanded: ReadonlySet<string>, sort: SortKey, ascending: boolean,
  order?: (list: ProcessInfo[]) => ProcessInfo[],
): TreeRow[] {
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
  const sortSiblings = order ?? ((list: ProcessInfo[]) => selectProcesses(list, '', sort, ascending));
  const rows: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (p: ProcessInfo, depth: number) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid);
    const kids = children.get(p.pid) ?? [];
    const open = expanded.has(procKey(p));
    rows.push({ process: p, depth, hasChildren: kids.length > 0, expanded: open });
    if (open) for (const kid of sortSiblings(kids)) walk(kid, depth + 1);
  };
  for (const root of sortSiblings(roots)) walk(root, 0);
  return rows;
}

/** Hides secrets in a command line before it is copied or shown: `--password x`, `token=abc`, etc. */
export function redactCommand(command: string): string {
  const keys = '(?:pass(?:word|wd)?|pwd|token|secret|api[-_]?key|apikey|auth(?:orization)?|bearer|credential|key)';
  return command
    .replace(new RegExp(`(--?${keys}[=:\\s]+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1***')
    .replace(new RegExp(`(\\b${keys}=)("[^"]*"|'[^']*'|[^\\s&]+)`, 'gi'), '$1***')
    .replace(/(\/\/[^\s/:@]+:)[^\s@/]+@/g, '$1***@');
}
