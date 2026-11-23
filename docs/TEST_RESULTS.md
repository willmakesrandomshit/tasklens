# Test results

Machine: Windows 11 Pro 10.0.26200. Debug test profile unless noted. Commands run from the repo root.

| Check | Command | Result (2026-11-23) |
|---|---|---|
| Rust format | `cargo fmt --check` (src-tauri) | pass |
| Rust lint | `cargo clippy --all-targets -- -D warnings` | pass, no warnings |
| Rust tests | `cargo test` | 6 passed, 0 failed (run 5 times consecutively, all green) |
| TypeScript | `npm run typecheck` | pass |
| ESLint | `npm run lint` | pass |
| Frontend tests | `npx vitest run` | 4 passed (2 files) |
| Frontend build | `npm run build` | pass (JS 167 kB, 52.8 kB gzip) |

## Runtime smoke test of the packaged release build (2026-11-23)

The release `.exe` (built as `traceback.exe` before the rename to TaskLens) was launched on Windows 11 with WebView2
remote debugging, and its real UI was driven by a script. 10/10 checks passed:

- process rows render; UI process count matched `Get-Process` (356 vs 357, 359 vs 359 in other runs)
- the timestamp advances between polls (live updates); memory % is a real number
- Performance page shows the real CPU model (AMD Ryzen 5 9600X) and 12 logical processors; navigation back works
- selecting a harmless `ping.exe` child opens the inspector, End process is enabled, a confirmation dialog appears,
  the child is still alive before confirming, and is gone after confirming (killed through the UI)

Idle measurement, same run, 2 s refresh, release build, one 10 s sample (single sample, not a benchmark):
backend CPU 1.56% of one core, backend working set 36.7 MB, WebView2 processes working set sum 355.6 MB.
This is ABOVE the <1% CPU target and the <100 MB target; optimization is outstanding.
The test script is not committed yet.

## Runtime smoke test, TaskLens build with per-core/disk/network/tree (2026-11-23)

`node tests/e2e/smoke.mjs src-tauri/target/release/tasklens.exe` — 15/15 checks passed: everything above, plus
per-core CPU bars equal to the logical processor count (12), disk volume and network adapter tables populated with
live rates, tree view collapses 374 processes to 53 roots and expanding a node reveals children, and a UI kill of a
harmless `ping` child.

Idle measurement (one 10 s sample, 2 s refresh, machine at ~80% CPU from other work, not a benchmark):
backend 2.19% of one core, backend working set 37.2 MB, WebView2 processes 375.6 MB. Still ABOVE the <1% CPU and
<100 MB targets. Optimization is outstanding (per-process handle opens each poll are the first suspect).

Test-harness note: earlier runs flipped the app to the Performance page by themselves. Cause not proven; the window is
real and visible, so a human click is the likely explanation. The script now navigates explicitly before each phase.

Observed limitations: virtual adapters (WiFi filter drivers) repeat the physical adapter's counters, and per-volume
disk rates come from sysinfo, not PDH active-time counters.

## What the Rust tests cover

`identity::tests` spawn harmless `ping -n 120 127.0.0.1` children (never system processes):

- identity token is stable per process and distinct between processes
- terminating with the correct identity ends exactly that child
- a wrong identity (simulated PID reuse) is refused and the child keeps running
- an already-exited process reports "not found" (or identity mismatch), never kills anything
- garbage identity tokens and Traceback's own PID are refused
- policy: critical flag, core Windows image names, PID 0/4 are refused

## Not yet covered

Service/startup/network integration tests, frontend component tests, end-to-end UI tests, and runtime
verification of the packaged application. See `IMPLEMENTATION_STATUS.md`.
