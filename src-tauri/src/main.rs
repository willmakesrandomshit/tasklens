#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod collector;
mod connections;
mod gpu;
mod identity;
mod pdh;
mod perf;
mod procinfo;
mod services;
mod startup;
mod system;

use std::sync::Mutex;
use tauri::State;

struct Monitor(Mutex<collector::Collector>);

// Commands are `async` so Tauri runs them on its thread pool instead of the UI thread;
// enumerating services or processes can take tens of milliseconds and must not freeze the window.

#[tauri::command(async)]
fn snapshot(monitor: State<'_, Monitor>) -> Result<collector::Snapshot, String> {
    let mut c = monitor
        .0
        .lock()
        .map_err(|_| "Monitor lock failed".to_string())?;
    Ok(collector::take_snapshot(&mut c))
}

/// Ends one process. `identity` is the creation-time token from the snapshot; it
/// is verified against the live process on the same handle that is terminated,
/// so a recycled PID can never cause the wrong process to be ended.
#[tauri::command(async)]
fn terminate_process(pid: u32, identity: Option<String>) -> Result<(), String> {
    let identity = identity.ok_or_else(|| {
        "This process's identity could not be read, so it cannot be ended safely.".to_string()
    })?;
    identity::terminate(pid, &identity).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn list_services() -> Result<Vec<services::ServiceInfo>, String> {
    services::list().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn control_service(name: String, action: services::ServiceAction) -> Result<(), String> {
    services::control(&name, action).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn list_connections() -> Result<Vec<connections::Connection>, String> {
    connections::list()
}

#[tauri::command(async)]
fn list_startup() -> Vec<startup::StartupEntry> {
    startup::list()
}

#[tauri::command(async)]
fn set_startup_enabled(id: String, enabled: bool) -> Result<(), String> {
    startup::set_enabled(&id, enabled)
}

/// Shows a file in Explorer. The path must be absolute, exist, and contain no quotes, so it cannot
/// smuggle extra arguments into the Explorer command line.
#[tauri::command(async)]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || path.contains(['"', '\0']) || std::fs::metadata(p).is_err() {
        return Err("That file does not exist or its path is not valid.".into());
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}

fn verified<T>(r: Result<T, identity::TerminateError>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn process_threads(pid: u32, identity: String) -> Result<Vec<procinfo::ThreadInfo>, String> {
    verified(procinfo::threads(pid, &identity))
}

#[tauri::command(async)]
fn process_modules(pid: u32, identity: String) -> Result<Vec<procinfo::ModuleInfo>, String> {
    verified(procinfo::modules(pid, &identity))
}

#[tauri::command(async)]
fn process_file_info(path: String) -> Result<system::FileInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err("That file does not exist.".into());
    }
    Ok(system::file_info(&path))
}

#[tauri::command(async)]
fn set_process_priority(pid: u32, identity: String, priority: String) -> Result<(), String> {
    procinfo::set_priority(pid, &identity, &priority)
}

#[tauri::command(async)]
fn get_process_affinity(pid: u32, identity: String) -> Result<(u64, u64), String> {
    procinfo::affinity(pid, &identity)
}

#[tauri::command(async)]
fn set_process_affinity(pid: u32, identity: String, mask: u64) -> Result<(), String> {
    procinfo::set_affinity(pid, &identity, mask)
}

#[tauri::command(async)]
fn suspend_process(pid: u32, identity: String, suspend: bool) -> Result<u32, String> {
    procinfo::set_suspended(pid, &identity, suspend)
}

#[tauri::command(async)]
fn terminate_process_tree(pid: u32, identity: String) -> Result<procinfo::TreeResult, String> {
    procinfo::terminate_tree(pid, &identity)
}

#[tauri::command(async)]
fn system_info() -> system::SystemInfo {
    system::system_info()
}

#[tauri::command(async)]
fn list_sessions() -> Vec<system::SessionInfo> {
    system::sessions()
}

fn main() {
    tauri::Builder::default()
        .manage(Monitor(Mutex::new(collector::new_collector())))
        .invoke_handler(tauri::generate_handler![
            snapshot,
            terminate_process,
            list_services,
            control_service,
            list_connections,
            list_startup,
            set_startup_enabled,
            reveal_in_explorer,
            process_threads,
            process_modules,
            process_file_info,
            set_process_priority,
            get_process_affinity,
            set_process_affinity,
            suspend_process,
            terminate_process_tree,
            system_info,
            list_sessions
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run TaskLens");
}
