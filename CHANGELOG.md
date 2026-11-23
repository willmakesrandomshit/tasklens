# Changelog

All notable changes. Entries are added only for behaviour that has been verified (see `docs/TEST_RESULTS.md`).

## Unreleased (0.1.0 pre-release candidate)

### Added
- Process manager: 25 columns with resize/reorder/visibility, multi-column sort, tree / application / user / session
  grouping, pinned processes, saved filters, search highlighting, keyboard navigation, context menu, usage heatmap.
- Process inspector with live graphs, threads, modules, connections and security tabs.
- Safe process actions: end process, end process tree, suspend/resume, priority, affinity. All verify the process's
  creation-time identity on the handle they act on and refuse critical/protected processes.
- Performance: per-core CPU, memory composition and commit accounting, physical-disk active time and latency,
  network adapter status and link speed, GPU engine utilisation and VRAM use.
- Resource Monitor, Users (sessions), System information, Overview.
- Services manager (Service Control Manager), Startup manager (Run keys + Startup folders, reversible), Network
  connections (TCP/UDP with owning process).
- Optional local history (SQLite, bounded by age and size), activity timeline (observations vs correlations),
  CSV export, alerts with duration/cooldown/de-duplication.
- Settings (theme, accent, density, text size, reduced motion), tray icon, compact always-on-top monitor,
  opt-in start with Windows, validated and atomically-saved settings file.
- CI (fmt, clippy, tests, typecheck, lint, Tauri build, checksums) and a tag-triggered pre-release workflow.

### Fixed
- Stale settings-save replies could silently undo a newer change.
- Process identity race: termination previously disabled until identity was bound to the handle.

### Known limitations
See `docs/KNOWN_LIMITATIONS.md`. Builds are unsigned; verified on Windows 11 x64 only.
