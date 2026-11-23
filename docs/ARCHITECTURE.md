# Architecture

TaskLens is a Tauri 2 desktop app: a Rust backend that talks to Windows, and a React + TypeScript frontend that
presents it. The backend is the only code that touches operating-system APIs; the frontend sends narrow,
validated commands over Tauri IPC.

```
React UI (src/)  ──invoke──▶  Tauri commands (src-tauri/src/main.rs)
                                   │
          ┌────────────────────────┼─────────────────────────────┐
          ▼                        ▼                             ▼
   engine.rs (one thread)     on-demand modules            settings.rs
   owns Collector, history,   identity, procinfo, services,   validated JSON,
   alerts, tray tooltip       connections, startup, system    atomic writes
          │
          ▼
   collector.rs ─ sysinfo (CPU/mem/processes/disks/NICs) + procinfo (handles, I/O, owner…)
                 + gpu.rs/perf.rs ─ pdh.rs (Windows Performance Data Helper)
```

## Backend modules (`src-tauri/src`)

| Module | Responsibility | Windows APIs |
|---|---|---|
| `identity` | Process identity = (PID, creation time). `open_verified` opens a handle and proves it is the selected process; every state-changing action starts there. Policy refuses self, PID 0/4, critical (`IsProcessCritical`) and core Windows images. | `OpenProcess`, `GetProcessTimes`, `IsProcessCritical`, `TerminateProcess` |
| `procinfo` | Per-process handles, threads, priority, session, architecture, private bytes, I/O counters, owner; on-demand threads/modules; priority, affinity, suspend/resume, end process tree. | Toolhelp, PSAPI, `GetProcessIoCounters`, `OpenProcessToken`, `LookupAccountSidW`, `SuspendThread` |
| `collector` | Builds one `Snapshot`; computes rates from two samples (`None` until known). | sysinfo + the above |
| `pdh`, `gpu`, `perf` | GPU engine use (per adapter and per process), VRAM use, physical-disk active time/latency/queue, memory page lists, link speeds. Counters that do not exist are skipped, never faked. | PDH (`\GPU Engine(*)`, `\PhysicalDisk(*)`, `\Memory\…`) |
| `system` | OS/CPU/boot info, commit and kernel accounting, WTS sessions, file version info and embedded Authenticode status. | registry, `GetPerformanceInfo`, WTS, `WinVerifyTrust`, `GetFileVersionInfoW` |
| `services` | Service Control Manager list/start/stop/restart with a protected-service denylist. | SCM |
| `connections` | TCP/UDP endpoints with owning PID (v4 + v6). | IP Helper |
| `startup` | Run keys + Startup folders; reversible enable/disable through `StartupApproved`; opt-in autostart. | registry |
| `history` | Bounded SQLite store, downsampling, spike detection, CSV export. | rusqlite (bundled) |
| `alerts` | Threshold + duration + cooldown evaluation (pure, unit-tested). | – |
| `settings` | Validation, clamping, atomic save, corrupt-file recovery. | – |
| `engine` | The only sampling thread. Cadence adapts: UI refresh while visible, history interval when only recording/alerts/tray need data, idle otherwise. Frontend reads the latest cached snapshot. | – |

### Process identity (why PIDs are never trusted)
Windows recycles PIDs. The UI therefore passes `(pid, identity)` where identity is the process creation time read
from the same handle that later performs the action. `open_verified` opens the handle, reads the creation time on it,
compares, rejects exited processes, and only then does the work on that handle. Holding the handle also reserves the
PID. Process trees are computed from Toolhelp parent links, but a child counts only if its parent's creation time is
not later than the child's (a recycled parent PID would violate that), and each member is verified and ended
individually, children first.

### CPU percentage definition
`sysinfo` computes each process's CPU-time delta divided by elapsed wall-clock time and by the logical processor
count, so 100% means every logical processor fully busy (Task Manager's definition). The first sample after start
reads 0 because a delta needs two readings. Rates (disk, network, I/O) are `null` until two samples exist.

### Memory terms
Working set = physical memory in use now. Private bytes = commit charge not shared. Commit = memory promised
(RAM + page file). Standby/modified/free come from PDH page-list counters. These are shown separately and never mixed.

## IPC
All commands are `#[tauri::command(async)]` (thread pool, never the UI thread) and return `Result<_, String>` with
a human-readable message. The frontend wrapper `api.ts` turns failures into `Error` objects. Inputs are validated in
Rust: identity tokens must parse, service names are length/charset checked, `reveal_in_explorer` requires an existing
absolute path without quotes, settings are clamped, startup entries are re-enumerated and matched by id.

## Frontend (`src`)
- `settings.tsx` – provider: loads/saves through the backend, applies theme/accent/density/motion; a stale save reply
  can never overwrite a newer change.
- `hooks.ts` – snapshot polling (pauses collection when hidden), rolling metric history, lazy file-info cache.
- `columns.ts` – column registry, layout repair, multi-column sort, search, grouping.
- `ProcessTable.tsx` – virtualized grid with resize/reorder/keyboard support; `Processes.tsx` – page logic and actions;
  `Inspector.tsx` – tabs; `ContextMenu.tsx`.
- `Performance.tsx`, `Insights.tsx` (Overview, Resource Monitor, Users, System), `HistoryPage.tsx` (History, Alerts),
  `Services.tsx`, `Connections.tsx`, `Startup.tsx`, `SettingsPage.tsx`, `Graph.tsx`.

## Data locations
`%APPDATA%\com.tasklens.monitor\settings.json` and `history.db` (+ WAL). Nothing is sent over the network.
