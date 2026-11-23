# Implementation status

Last updated: 2026-11-23. Classification: **Verified** = exercised by automated tests *and* the real-app e2e run;
**Unverified** = implemented, not runtime-checked; **Partial**; **Missing**.

## Feature matrix
| Area | Feature | Status |
|---|---|---|
| Processes | List with 25 columns, resize/reorder/visibility, heatmap | Verified |
| | Multi-column sort, search (name/PID/path/command/user/publisher), highlighting | Verified |
| | Tree view (PID-reuse safe), group by app/user/session | Verified |
| | Pinned processes, saved filters, density | Unverified in e2e (unit-tested logic) |
| | Keyboard navigation, context menu | Verified (component tests + e2e menu) |
| | Publisher / description / signature columns | Verified (lazy, embedded signature only) |
| Actions | End process, End process tree, confirmation, identity verification, critical-process refusal | Verified (incl. tree sparing a bystander) |
| | Suspend / resume, priority | Verified in real Windows |
| | CPU affinity | Verified in Rust tests; UI dialog unverified in e2e |
| | Copy PID/path/redacted command line, open file location | Unverified in e2e (clipboard/Explorer) |
| Inspector | Overview, performance graphs, threads, modules, connections, security tabs | Verified (overview + open); other tabs unit/integration-tested backend |
| Performance | CPU per core, memory composition + commit/pools, disk active/response/queue, network status/link speed | Verified |
| | GPU engine utilisation, VRAM use, adapters | Verified on this NVIDIA + AMD machine; other vendors unverified |
| | Temperatures, clocks, power, cache sizes | **Missing** (no standard API) |
| Resource Monitor | CPU/Memory/Disk/Network/GPU rankings, focus process | Verified (opens, lists); focus unverified |
| Startup | Run keys + folders, reversible disable | Verified in registry round trip; reboot effect unverified |
| Services | List, config, start/stop/restart, protected denylist | Listing + refusal verified; start/stop of a real service not exercised (needs admin) |
| Network | TCP/UDP with owning process, filtering | Verified; per-process bandwidth **Missing** |
| Users | Sessions + per-session/per-account totals | Verified |
| System | Windows/CPU/memory/GPU/storage/network info | Verified |
| History | SQLite recording, bounded retention, spike timeline, events, CSV export, clear | Verified (recording); export/clear unit-tested |
| Alerts | Rules, duration, cooldown, in-app notices, history | Rule engine verified; firing end-to-end unverified; Windows toasts **Missing** |
| Settings | Theme/accent/density/text size/motion, persistence, corruption recovery | Verified |
| Application | Tray, compact monitor, always-on-top, close-to-tray, start minimized, autostart (opt-in) | Implemented, **unverified** (tray/compact/autostart not exercised) |
| Scheduled tasks | – | **Missing** |
| Distribution | Release build, NSIS installer install/uninstall, portable exe | Verified (unsigned) |
| | GitHub Actions CI | Running on every push; see PR #1 |
| | Pre-release workflow | Written, **not yet run** (no tag pushed) |

## Repository / collaboration
- Public repo `willmakesrandomshit/tasklens` (renamed from "Traceback" at the owner's request); `main` = recovered baseline,
  work on `feat/process-identity-safety` (PR #1).
- `mynameisjapan26-hue` invited with write access; **acceptance not confirmed** (collaborators list shows only the owner).
- Branch protection not yet enabled. No release published. No launch video produced.

## Next actions
1. Merge PR #1 once CI is green; enable branch protection on `main`.
2. Exercise tray, compact mode, autostart and a real alert firing in the e2e script.
3. Windows 10 / scaling / multi-monitor verification; 24 h stability run.
4. Reduce idle CPU below 1 % (see benchmarks) and WebView2 memory.
5. Scheduled tasks module; per-process network bandwidth (ETW); Windows toast notifications.
6. Tag `v0.1.0-alpha.1` to exercise the pre-release workflow; launch video from real footage.
