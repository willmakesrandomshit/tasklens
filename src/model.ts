export interface ProcessInfo {
  pid: number; parent_pid: number | null; name: string; cpu_usage: number; memory: number;
  status: string; start_time: number; identity: string | null; exe: string | null; command: string;
}
export interface Snapshot {
  timestamp: number; cpu_usage: number; total_memory: number; used_memory: number;
  cpu_model: string; logical_cores: number; processes: ProcessInfo[];
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
