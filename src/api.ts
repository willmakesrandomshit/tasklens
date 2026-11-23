import { invoke } from '@tauri-apps/api/core';

export interface AlertRule {
  id: string; name: string; metric: string; threshold: number; duration_s: number; cooldown_s: number;
  enabled: boolean; process: string | null;
}
export interface ColumnLayout { order: string[]; visible: string[]; widths: Record<string, number> }
export interface SavedFilter { name: string; query: string }
export interface UiState {
  columns?: ColumnLayout; pinned?: string[]; filters?: SavedFilter[]; grouping?: Grouping;
  sort?: { id: string; desc: boolean }[]; graphRange?: number;
}
export type Grouping = 'flat' | 'tree' | 'app' | 'user' | 'session';
export interface Settings {
  theme: 'system' | 'dark' | 'light'; accent: string; density: 'compact' | 'comfortable'; font_scale: number;
  reduced_motion: boolean; refresh_ms: number; confirm_destructive: boolean;
  history: { enabled: boolean; interval_s: number; retention_days: number; max_mb: number };
  app: { start_minimized: boolean; always_on_top: boolean; tray_enabled: boolean; minimize_to_tray: boolean; compact: boolean; notify_in_app: boolean };
  alerts: AlertRule[];
  ui: UiState | null;
}
export interface SettingsReply { settings: Settings; note: string | null; autostart: boolean }
export interface AlertEvent { ts: number; rule_id: string; rule_name: string; metric: string; value: number; message: string }
export interface HistorySample {
  ts: number; cpu: number; mem: number; gpu: number | null; disk_active: number | null;
  disk_read: number; disk_write: number; net_rx: number; net_tx: number;
}
export interface HistoryStats { samples: number; bytes: number; oldest: number | null; newest: number | null }
export interface ProcBrief { pid: number; identity: string | null; name: string; cpu: number; mem: number }
export interface Spike { ts: number; metric: string; value: number; baseline: number; processes: ProcBrief[] }
export interface ProcEvent { ts: number; kind: 'start' | 'exit'; pid: number; name: string }
export interface SystemInfo {
  os_name: string; os_version: string | null; os_build: string | null; device_name: string | null; uptime_secs: number;
  architecture: string; boot_mode: string | null; cpu_name: string | null; cpu_base_mhz: number | null;
}
export interface SessionInfo { id: number; station: string; state: string; user: string | null }
export interface ThreadInfo { tid: number; base_priority: number; cpu_time_ms: number | null }
export interface ModuleInfo { name: string; path: string }
export interface FileInfo { description: string | null; company: string | null; product: string | null; version: string | null; signature: string }
export interface TreeResult { ended: number; failed: string[] }

/** Calls a backend command, turning any failure into a readable message. */
export async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); } catch (e) { throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)); }
}

export const defaultUi: UiState = {};
