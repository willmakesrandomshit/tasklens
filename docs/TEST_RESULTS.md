# Test results

Machine: Windows 11 Pro 10.0.26200, AMD Ryzen 5 9600X. Results from 2026-11-23 on the final code of this milestone.
Everything below was actually executed; nothing is projected.

## Automated checks
| Check | Command | Result |
|---|---|---|
| Rust format | `cargo fmt --check` | pass |
| Rust lint | `cargo clippy --all-targets -- -D warnings` | pass |
| Rust tests | `cargo test` | **62 passed**, 0 failed, 1 ignored (profiling helper) |
| TypeScript | `npm run typecheck` | pass |
| ESLint | `npm run lint` | pass |
| Frontend tests | `npx vitest run` | **37 passed** (6 files, jsdom) |
| Frontend build | `npm run build` | pass |
| Tauri release build | `npm run tauri build` | pass → `tasklens.exe` 11.6 MB, NSIS installer 3.0 MB |
| GitHub Actions (Windows) | `CI` workflow on the PR | checks + build jobs ran on GitHub's runners; see PR #1 for current status |

CI already caught two real problems that local runs missed: an invalid `package.json` from a bad scripted edit, and
two tests that assumed the test process runs at "Normal" priority (the runner uses "Below normal").

### What the Rust tests cover (real Windows, no mocks)
- identity: stable/distinct tokens, correct kill, wrong identity (simulated PID reuse) refused, exited process, policy
- procinfo: handles/priority/private bytes/session/architecture/owner, threads, modules, priority change, affinity
  round trip, suspend/resume, **tree termination that spares an unrelated process**, stale root refused
- services (real SCM enumeration), connections (real sockets: listener, established, UDP; byte-order decode),
  startup (real HKCU registry round trip with cleanup)
- PDH, GPU instance parsing, physical-disk and memory-list counters, system info, WTS sessions, version info +
  signature, network adapters
- history (SQLite): downsampling keeps spikes, top-process storage only when elevated, spike correlation, retention,
  size cap, CSV; alerts: duration, cooldown, dips reset, unavailable metrics, disk-free, process rules; settings:
  clamping, corruption recovery, oversize blob

### What the frontend tests cover
Column layout repair, multi-column sort (missing values last), search matching, grouping, command-line redaction,
formatting; component tests with a mocked backend: table rendering, sorting, search + empty state, keyboard
selection, tree expansion, **confirm-before-kill and cancel**, disabled End when identity is unknown, error state,
navigation through all 12 pages, theme switching + persistence call, accent/density/motion application, corrupt
settings note, alert editor, **stale save reply never overwrites a newer change**.

## End-to-end test of the real app (`npm run e2e`)
`tests/e2e/smoke.mjs` launches the release exe with WebView2 remote debugging and drives the real UI. **43 / 43 checks
passed** on the final build, including:
- real process data (UI count vs `Get-Process`), live updates, rich columns, search, sort, tree, grouping
- inspector contents; context menu actions; **priority changed through the UI and confirmed by Windows**
- **suspend/resume through the UI confirmed from the OS thread wait reasons**
- confirm-before-kill; process ended; **end process tree ends root and child, a bystander survives**
- critical process (csrss.exe) cannot be ended (button disabled with explanation)
- per-core graphs = logical processors; memory composition; physical disk active/response; network status + link speed;
  GPU page lists adapters and states unavailable sensors
- Overview, Resource Monitor, Services (core service Stop disabled), Network (listeners, process names), Startup, Users,
  System (Windows 11 Pro 25H2, UEFI)
- theme switch applied and **persisted to settings.json by the backend**; history recorded real samples to SQLite;
  alert editor; narrow-window layout without horizontal scroll

Real screenshots from this run are in `docs/screenshots/`.

## Installer
`TaskLens_0.1.0_x64-setup.exe` (2,999,431 bytes, SHA-256 `381ea5af…3d47`, **unsigned**) was installed with `/S`,
created `%LOCALAPPDATA%\TaskLens\tasklens.exe`, an uninstall entry and a Start Menu shortcut; the installed app
launched (title "TaskLens"); `uninstall.exe /S` removed the files, registry entry and shortcut. Portable
`tasklens.exe` SHA-256 `f2c6a264…9736`.

## Not verified
Windows 10; ARM64; display scaling other than 100 %; multi-monitor; standard-user vs administrator comparison;
systems without GPU counters; startup enable/disable across a real sign-in; long-duration (24 h) stability;
thousands of processes; the GitHub release workflow (no tag pushed yet).
