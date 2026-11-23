# Release checklist

Pre-releases (`v0.x.y-alpha.n`) may ship while this list is incomplete. A **stable** release (`v1.0.0`) requires every
box below. Tick a box only with evidence recorded in `TEST_RESULTS.md`.

## Gate: code
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` green in CI on Windows
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` green in CI
- [ ] `npm run e2e` (30+ real-UI checks) green on a clean Windows 11 machine
- [ ] No known data-loss or wrong-process bug open

## Gate: safety
- [ ] Process identity tests green, including PID-reuse simulation and tree termination sparing a bystander
- [ ] Critical-process and protected-service refusals verified through the UI
- [ ] Tauri capabilities reviewed (no shell/fs/http permissions beyond `core:default`)
- [ ] Dependency audit reviewed (`npm audit`, `cargo audit`)

## Gate: platform
- [ ] Verified on Windows 11 x64 and Windows 10 x64
- [ ] Verified at 100%, 150%, 200% display scaling and with two monitors
- [ ] Verified as a standard user and as administrator
- [ ] Verified on a machine with no GPU counters and one with a dedicated GPU
- [ ] Startup enable/disable verified across a real sign-in

## Gate: performance (see `PERFORMANCE_BENCHMARKS.md`)
- [ ] Idle CPU, idle memory, cold/warm start measured on a documented reference machine
- [ ] 24-hour stability run: no memory growth, history size within its limit

## Gate: distribution
- [ ] Installer installs, launches, uninstalls cleanly (verified, not just built)
- [ ] Portable exe launches on a machine without Visual C++ build tools
- [ ] SHA-256 checksums published and verified against the downloaded files
- [ ] Release notes disclose unsigned binaries and known limitations
- [ ] README screenshots are real captures of this version

## Procedure
1. Update `CHANGELOG.md` and versions (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`).
2. Merge to `main` through a reviewed PR with green CI.
3. Tag `vX.Y.Z[-alpha.N]` and push; the `Pre-release` workflow builds and publishes a **pre-release** with checksums.
4. For stable: after every gate above, manually promote the pre-release (workflow never publishes stable by itself).
