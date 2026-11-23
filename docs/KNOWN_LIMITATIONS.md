# Known limitations

- Only the Processes and Performance (CPU + memory totals) pages show real data. Startup, Services, Network and History are placeholders that say so.
- No GPU, disk, network, per-core CPU or temperature metrics yet. The UI states this rather than showing zeros.
- Process termination refuses: TaskLens itself, PID 0/4, processes Windows marks critical (`IsProcessCritical`),
  and a denylist of core images (csrss, lsass, winlogon, ...). It cannot end protected or higher-privilege processes
  (Windows returns access denied; TaskLens reports it and does not try to bypass it).
- Process CPU% comes from `sysinfo`; the first sample after start is 0.
- Builds are unsigned; Windows SmartScreen may warn.
- Not yet tested on Windows 10 or ARM64.
