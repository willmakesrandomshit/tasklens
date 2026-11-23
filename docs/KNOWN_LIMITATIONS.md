# Known limitations

Honest list of what TaskLens does not do, does only partly, or has not verified.

## Not implemented
- **Per-process network bandwidth.** Needs ETW tracing; the Network pages show connections and adapter totals only.
- **Windows toast notifications.** Alerts appear in-app (toast overlay + Alerts history) and in the tray tooltip.
- **Scheduled tasks module.** Not built.
- **Per-process GPU memory, GPU/CPU temperatures, clocks, power.** No standard Windows API exposes them; the UI says
  "unavailable" instead of guessing. GPU utilisation and VRAM use come from PDH counters.
- **Cache sizes, RAM slot/speed/type, disk media type and interface, boot-time details** in System information.
- **Handle listing** (what files/objects a process holds). Only handle *counts and trends* are shown.
- **Integrity level**, per-module signature verification, catalog-signed file verification (system files signed by
  catalog show as "Not signed (embedded)").
- **Startup impact** and **publisher** columns on the Startup page. Run-Once keys, scheduled tasks, services, Winlogon
  hooks and other persistence mechanisms are not covered.
- **Persistent per-process history.** The inspector keeps the last 120 samples in memory; history on disk is system-wide
  plus top processes around spikes.
- **Plugin system, localisation, updater.**

## Partly implemented / caveats
- **GPU mapping with several GPUs:** counters are listed by adapter LUID because Windows does not map LUIDs to adapter
  names without DXGI. Single-GPU systems are unambiguous.
- **Virtual network adapters** (filter drivers) repeat the physical adapter's counters; totals count only adapters that
  own a routable address.
- **Process I/O columns** are *all* I/O a process does (files, pipes, devices), not physical disk traffic.
  Physical disk activity is shown separately from PDH.
- **Suspended state** is tracked only for processes TaskLens itself suspended (Windows offers no simple supported query).
- **Startup enable/disable** uses the per-user `StartupApproved` convention used by Task Manager. It has not been
  verified across a real sign-in/reboot.
- **Alert "process exited unexpectedly"** can only detect that a process with that name disappeared, not why.
- **Sorting by publisher/description/signature** only covers executables whose details have been fetched (visible rows).
- **First CPU/rate sample after start** reads 0/— because a delta needs two readings.

## Safety rules (intentional)
- Ending, suspending, re-prioritising or changing affinity refuses TaskLens itself, PID 0/4, processes Windows marks
  critical, and core images (csrss, lsass, winlogon, services, …). Realtime priority is not offered.
- Protected or higher-privilege processes return "access denied"; TaskLens never tries to bypass this and does not
  request administrator rights.
- Core Windows/security services cannot be stopped or restarted from the app.

## Packaging / platforms
- Builds are **unsigned**; Windows SmartScreen may warn.
- Verified only on **Windows 11 x64** (see `TEST_RESULTS.md`). Windows 10 and ARM64 have not been tested.
- Interface verified at 100% display scaling and a narrow-window emulation only; other scale factors and multi-monitor
  setups are untested.
