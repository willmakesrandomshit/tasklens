#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod identity;

use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::State;

struct Monitor(Mutex<System>);

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    cpu_usage: f32,
    memory: u64,
    status: String,
    start_time: u64,
    identity: Option<String>,
    exe: Option<String>,
    command: String,
}

#[derive(Serialize)]
struct Snapshot {
    timestamp: u64,
    cpu_usage: f32,
    total_memory: u64,
    used_memory: u64,
    cpu_model: String,
    logical_cores: usize,
    processes: Vec<ProcessInfo>,
}

#[tauri::command]
fn snapshot(monitor: State<'_, Monitor>) -> Result<Snapshot, String> {
    let mut system = monitor
        .0
        .lock()
        .map_err(|_| "Monitor lock failed".to_string())?;
    system.refresh_all();
    let processes = system
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            parent_pid: p.parent().map(|id| id.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cpu_usage: p.cpu_usage(),
            memory: p.memory(),
            status: format!("{:?}", p.status()),
            start_time: p.start_time(),
            identity: identity::identity_of(pid.as_u32()),
            exe: p.exe().map(|path| path.to_string_lossy().into_owned()),
            command: p
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
        })
        .collect();
    Ok(Snapshot {
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        cpu_usage: system.global_cpu_usage(),
        total_memory: system.total_memory(),
        used_memory: system.used_memory(),
        cpu_model: system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().to_owned())
            .unwrap_or_default(),
        logical_cores: system.cpus().len(),
        processes,
    })
}

/// Ends one process. `identity` is the creation-time token from the snapshot; it
/// is verified against the live process on the same handle that is terminated,
/// so a recycled PID can never cause the wrong process to be ended.
#[tauri::command]
fn terminate_process(pid: u32, identity: Option<String>) -> Result<(), String> {
    let identity = identity.ok_or_else(|| {
        "This process's identity could not be read, so it cannot be ended safely.".to_string()
    })?;
    identity::terminate(pid, &identity).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Monitor(Mutex::new(System::new_all())))
        .invoke_handler(tauri::generate_handler![snapshot, terminate_process])
        .run(tauri::generate_context!())
        .expect("Failed to run Traceback");
}
