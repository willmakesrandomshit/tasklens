# Performance benchmarks

Reproduce with `node tests/bench/bench.mjs src-tauri/target/release/tasklens.exe 60` (raw output:
[`bench-results.json`](bench-results.json)). Single run on one machine; numbers vary run to run, so treat them as
indicative, not as a guarantee.

## Setup
| | |
|---|---|
| Machine | AMD Ryzen 5 9600X (6 cores / 12 threads), 31.1 GB RAM |
| OS | Windows 11 Pro, build 26200 |
| Build | release (LTO, stripped), unsigned, v0.1.0 |
| Settings | defaults: 2 s refresh, history recording off, tray off |
| State | ~358 processes; other heavy programs were running (system CPU ≈ 30–90%), which inflates idle numbers |
| Method | App launched with WebView2 remote debugging; UI latency measured in the page with `performance.now()` around the action plus two animation frames; CPU from `Get-Process` CPU-time deltas over 30 s; memory from working sets |

## Results (2026-11-23, final build)
| Metric | Result | Target | Verdict |
|---|---|---|---|
| Cold start to first process rows (fresh WebView2 profile) | **1.64 s** | < 1 s "where practical" | not met |
| Warm start to first process rows | **0.72 s** | < 1 s | met |
| Snapshot collection (backend, ~358 processes) | median **20.9 ms**, p95 29.0 ms | – | – |
| Snapshot IPC round trip (cached, incl. JSON of all processes) | median **3.4 ms** | – | – |
| Search latency (keystroke → painted) | median **7.4 ms**, p95 13.7 ms | responsive | good |
| Sort latency (header click → painted) | median **9.4 ms**, p95 12.0 ms | responsive | good |
| Scroll through the full table (119 frames) | median **4.2 ms/frame**, 0 frames > 33 ms | smooth | good |
| Idle CPU (backend, Overview page, 2 s refresh) | **1.2 %** of one core (1.56 % in the e2e run) | < 1 % | **not met** |
| Idle memory, backend | **44.6 MB** | < 100 MB | met |
| Idle memory, WebView2 (renderer + GPU + browser processes) | **≈ 387 MB** | < 100 MB | **not met** |
| 60 s stability | backend +1.9 MB, WebView2 +1.5 MB | stable | no growth observed (60 s only; a 24 h run has **not** been done) |

The memory target was set for the whole app; WebView2 dominates and is a property of the chosen UI stack. A
lighter approach would be a native UI, which is out of scope for now.

## What the time is spent on
`cargo test --release profile_phases -- --ignored --nocapture` (per snapshot, 357 processes, before caching):

| Phase | ms |
|---|---|
| sysinfo process list (+ ~3 ms for per-process CPU) | 8–10 |
| Toolhelp thread table | 6.0 → now cached every 5 s |
| disks + networks refresh | 3.9 → disks now every 10 s |
| per-process handle queries (identity, handles, I/O, memory, owner) | 2.9 |
| GPU + disk/memory PDH | 1.9 |
| CPU + memory totals | 0.4 |

Caching the slow-changing parts moved idle CPU from **2.18 % to ≈ 1.2 %** and median collection from 26.4 ms to
20.9 ms. Remaining cost is mostly `sysinfo`'s process enumeration. Next options (not done): replace it with a single
Toolhelp pass, skip per-process collection on pages that do not show processes, lengthen the default refresh.

## Not measured
Windows 10, other hardware, 24-hour stability, history-recording overhead (SQLite writes), behaviour with several
thousand processes (the table is virtualized, but this was only tested with ~360).
