# Implementation status

Last updated: 2026-11-23. Only items with evidence are marked done.

## Environment (verified on the dev machine)

rustc 1.100.0, cargo 1.100.0, Node 22.21.0, npm 10.9.4, Git 2.55, gh 2.98 (authenticated as `willmakesrandomshit`),
FFmpeg 9.0.2, WebView2 runtime 157.0.4341.42, Windows SDK 10.0.26100, MSVC linker working (crates compile and link).
Network/DNS to the npm and crates.io registries works now (the earlier DNS failure was environmental).

## Done (verified)

| Item | Evidence |
|---|---|
| Checkpoint recovered, baseline committed | git commit `4ea4fd6` |
| Locked dependencies installed (`package-lock.json`, `Cargo.lock`) | `npm install`, `cargo check` succeed |
| Rust build, `cargo fmt --check`, `cargo clippy -D warnings` | clean |
| Handle-bound process identity + safe terminate (`src-tauri/src/identity.rs`) | 6 Rust tests pass, repeated 5x |
| Frontend typecheck, ESLint, Vitest (4 tests), production Vite build | all pass |

| Release build + NSIS installer produced (unsigned) | `tauri build`, installer 1.78 MiB |
| App launches; real process/CPU/memory data shown; navigation; live updates | scripted UI smoke test, 10/10 (see TEST_RESULTS.md) |
| End process through the UI on a harmless `ping` child, with confirmation | same smoke test |

## Implemented, only partly verified

- Search, sort, virtualized rows, theme and refresh settings exist in source; search was exercised by the smoke test,
  the others have only typecheck/lint coverage.
- The installer was built but has NOT been installed or run.

## Project name

Renamed from "Traceback" to **TaskLens** (repo `willmakesrandomshit/tasklens`) on 2026-11-23 at the owner's request.

## Not implemented

Per-core CPU, GPU, disk and network metrics; process tree/grouping, column customization, priority/affinity/suspend;
startup manager; services manager; network connections; history storage; alerts; tray; compact mode;
frontend component tests; end-to-end tests; benchmarks; screenshots; installer verification; GitHub repository, collaborator
invite, release, and launch video.

## Blockers / pending decisions

- GitHub repo creation, pushing and inviting `mynameisjapan26-hue` are outward-facing actions and need explicit go-ahead.
- Installer artifacts are unsigned.

## Next actions

1. Launch the release build and verify real data appears (UI-level check).
2. Expand the collector: per-core CPU, memory breakdown, disk, network, process tree.
3. Services / Startup / Network modules.
4. History storage, settings, alerts.
5. Create the GitHub repo (after approval), CI, release.
