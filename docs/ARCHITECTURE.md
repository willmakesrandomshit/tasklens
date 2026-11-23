# Architecture

Traceback uses a Tauri desktop shell with a Rust backend and a React/TypeScript frontend. The native backend owns access to operating-system APIs and validates all inputs; the frontend presents snapshots and sends narrowly scoped user commands. Ordinary monitoring should not require elevation.

System data can be unavailable due to platform limitations, permissions, process exit, or unsupported hardware. Represent these states explicitly rather than fabricating values. Sampling intervals and history must be bounded. Collect expensive per-process details only when requested.

Process actions need a stable identity check in addition to PID, because Windows can reuse PIDs. Explicitly confirm destructive operations and propagate permission and race failures to the UI. Test process actions only against disposable child processes.

This document describes engineering boundaries, not a claim that every proposed feature is implemented. Record the actual APIs, limitations, data formats, benchmark methodology and security decisions as the implementation matures.
