#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod identity;

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System, UpdateKind,
};
use tauri::State;

struct Monitor(Mutex<Collector>);

struct Collector {
    system: System,
    disks: Disks,
    networks: Networks,
    last_refresh: Option<Instant>,
}

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
struct DiskInfo {
    name: String,
    mount: String,
    file_system: String,
    total: u64,
    available: u64,
    /// Bytes per second since the previous snapshot; `None` until two samples exist.
    read_per_s: Option<f64>,
    write_per_s: Option<f64>,
}

#[derive(Serialize)]
struct NetworkInfo {
    name: String,
    /// Bytes per second since the previous snapshot; `None` until two samples exist.
    received_per_s: Option<f64>,
    transmitted_per_s: Option<f64>,
    total_received: u64,
    total_transmitted: u64,
    addresses: Vec<String>,
    mtu: u64,
}

#[derive(Serialize)]
struct Snapshot {
    timestamp: u64,
    cpu_usage: f32,
    cpu_cores: Vec<f32>,
    cpu_frequency_mhz: Option<u64>,
    total_memory: u64,
    used_memory: u64,
    available_memory: u64,
    total_swap: u64,
    used_swap: u64,
    cpu_model: String,
    logical_cores: usize,
    physical_cores: Option<usize>,
    disks: Vec<DiskInfo>,
    networks: Vec<NetworkInfo>,
    processes: Vec<ProcessInfo>,
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
}

fn new_collector() -> Collector {
    let mut system = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::everything())
            .with_memory(MemoryRefreshKind::everything())
            .with_processes(process_refresh_kind()),
    );
    system.refresh_cpu_all();
    Collector {
        system,
        disks: Disks::new_with_refreshed_list(),
        networks: Networks::new_with_refreshed_list(),
        last_refresh: None,
    }
}

fn per_second(bytes: u64, elapsed: Option<f64>) -> Option<f64> {
    elapsed.filter(|s| *s > 0.0).map(|s| bytes as f64 / s)
}

#[tauri::command]
fn snapshot(monitor: State<'_, Monitor>) -> Result<Snapshot, String> {
    let mut c = monitor
        .0
        .lock()
        .map_err(|_| "Monitor lock failed".to_string())?;
    let now = Instant::now();
    let elapsed = c.last_refresh.map(|t| now.duration_since(t).as_secs_f64());
    c.last_refresh = Some(now);

    c.system.refresh_cpu_all();
    c.system.refresh_memory();
    c.system
        .refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
    c.disks.refresh(true);
    c.networks.refresh(true);

    let processes = c
        .system
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

    let disks = c
        .disks
        .list()
        .iter()
        .map(|d| {
            let usage = d.usage();
            DiskInfo {
                name: d.name().to_string_lossy().into_owned(),
                mount: d.mount_point().to_string_lossy().into_owned(),
                file_system: d.file_system().to_string_lossy().into_owned(),
                total: d.total_space(),
                available: d.available_space(),
                read_per_s: per_second(usage.read_bytes, elapsed),
                write_per_s: per_second(usage.written_bytes, elapsed),
            }
        })
        .collect();

    let networks = c
        .networks
        .iter()
        .map(|(name, n)| NetworkInfo {
            name: name.clone(),
            received_per_s: per_second(n.received(), elapsed),
            transmitted_per_s: per_second(n.transmitted(), elapsed),
            total_received: n.total_received(),
            total_transmitted: n.total_transmitted(),
            addresses: n
                .ip_networks()
                .iter()
                .map(|ip| ip.addr.to_string())
                .collect(),
            mtu: n.mtu(),
        })
        .collect();

    let cpus = c.system.cpus();
    Ok(Snapshot {
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        cpu_usage: c.system.global_cpu_usage(),
        cpu_cores: cpus.iter().map(|cpu| cpu.cpu_usage()).collect(),
        cpu_frequency_mhz: cpus.first().map(|cpu| cpu.frequency()).filter(|f| *f > 0),
        total_memory: c.system.total_memory(),
        used_memory: c.system.used_memory(),
        available_memory: c.system.available_memory(),
        total_swap: c.system.total_swap(),
        used_swap: c.system.used_swap(),
        cpu_model: cpus
            .first()
            .map(|cpu| cpu.brand().to_owned())
            .unwrap_or_default(),
        logical_cores: cpus.len(),
        physical_cores: c.system.physical_core_count(),
        disks,
        networks,
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
        .manage(Monitor(Mutex::new(new_collector())))
        .invoke_handler(tauri::generate_handler![snapshot, terminate_process])
        .run(tauri::generate_context!())
        .expect("Failed to run TaskLens");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_are_unknown_until_two_samples() {
        assert_eq!(per_second(1000, None), None);
        assert_eq!(per_second(1000, Some(0.0)), None);
        assert_eq!(per_second(1000, Some(2.0)), Some(500.0));
    }

    #[test]
    fn collector_reports_real_machine_data() {
        let mut c = new_collector();
        c.system.refresh_memory();
        c.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
        assert!(c.system.total_memory() > 0);
        assert!(!c.system.cpus().is_empty());
        let me = sysinfo::Pid::from_u32(std::process::id());
        assert!(
            c.system.process(me).is_some(),
            "own process must be enumerated"
        );
        assert!(!c.disks.list().is_empty(), "at least one volume expected");
    }
}
