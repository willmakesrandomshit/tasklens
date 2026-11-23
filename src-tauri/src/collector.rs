//! Periodic system snapshot: processes, CPU, memory, disks, network adapters, GPU.
//!
//! CPU percentages: `sysinfo` reports each process's CPU time delta divided by wall-clock time, per
//! logical processor, then divides by the processor count, so 100% means every logical processor is
//! fully busy (the same definition Task Manager uses). The first sample after start is 0 because a
//! delta needs two readings. Rates are `None` until two samples exist so "unknown" is never shown as 0.

use crate::gpu::{GpuSampler, GpuSnapshot};
use crate::netinfo::{self, AdapterInfo};
use crate::perf::{PerfSampler, PerfSnapshot};
use crate::procinfo::{self, Extra};
use crate::system::{memory_detail, MemoryDetail};
use crate::{gpu, identity};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System, UpdateKind,
};

pub struct Collector {
    system: System,
    disks: Disks,
    networks: Networks,
    gpu: GpuSampler,
    perf: PerfSampler,
    last_refresh: Option<Instant>,
    /// Owner account per `pid:identity`; looked up once because it never changes for a process.
    users: HashMap<String, Option<String>>,
    /// Previous cumulative I/O bytes per `pid:identity` for rate calculation.
    io_prev: HashMap<String, (u64, u64)>,
    gpu_adapters: Vec<gpu::GpuAdapterInfo>,
    net_adapters: (Option<Instant>, Vec<AdapterInfo>),
    disks_at: Option<Instant>,
    /// Thread counts and parent PIDs from Toolhelp, refreshed every 5 s.
    threads: HashMap<u32, (u32, u32)>,
    threads_at: Option<Instant>,
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    cpu_usage: f32,
    /// Working set (physical memory currently used), bytes.
    memory: u64,
    status: String,
    start_time: u64,
    identity: Option<String>,
    exe: Option<String>,
    command: String,
    user: Option<String>,
    thread_count: Option<u32>,
    #[serde(flatten)]
    extra: Extra,
    /// Process-wide I/O rates (all I/O, not only physical disk).
    io_read_per_s: Option<f64>,
    io_write_per_s: Option<f64>,
    /// Peak GPU engine utilisation of this process; `None` when GPU counters are unavailable.
    gpu_percent: Option<f32>,
    /// True only for processes TaskLens itself suspended.
    suspended: bool,
}

#[derive(Serialize)]
pub struct DiskInfo {
    name: String,
    mount: String,
    file_system: String,
    total: u64,
    available: u64,
}

#[derive(Serialize)]
pub struct NetworkInfo {
    name: String,
    received_per_s: Option<f64>,
    transmitted_per_s: Option<f64>,
    total_received: u64,
    total_transmitted: u64,
    addresses: Vec<String>,
    mtu: u64,
}

#[derive(Serialize)]
pub struct Snapshot {
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
    memory_detail: MemoryDetail,
    disks: Vec<DiskInfo>,
    networks: Vec<NetworkInfo>,
    perf: PerfSnapshot,
    gpu: GpuSnapshot,
    gpu_adapters: Vec<gpu::GpuAdapterInfo>,
    net_adapters: Vec<AdapterInfo>,
    /// How long collecting this snapshot took, in milliseconds (a self-measurement of TaskLens overhead).
    collect_ms: f64,
    processes: Vec<ProcessInfo>,
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
}

pub fn new_collector() -> Collector {
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
        gpu: GpuSampler::new(),
        perf: PerfSampler::new(),
        last_refresh: None,
        users: HashMap::new(),
        io_prev: HashMap::new(),
        gpu_adapters: gpu::adapters(),
        net_adapters: (None, Vec::new()),
        disks_at: None,
        threads: HashMap::new(),
        threads_at: None,
    }
}

fn per_second(bytes: u64, elapsed: Option<f64>) -> Option<f64> {
    elapsed.filter(|s| *s > 0.0).map(|s| bytes as f64 / s)
}

/// Rate from two cumulative counters; `None` if the counter went backwards (wrap or process change).
pub fn counter_rate(prev: Option<u64>, now: u64, elapsed: Option<f64>) -> Option<f64> {
    let (prev, secs) = (prev?, elapsed.filter(|s| *s > 0.0)?);
    now.checked_sub(prev).map(|d| d as f64 / secs)
}

pub fn take_snapshot(c: &mut Collector) -> Snapshot {
    let now = Instant::now();
    let started = Instant::now();
    let elapsed = c.last_refresh.map(|t| now.duration_since(t).as_secs_f64());
    c.last_refresh = Some(now);

    c.system.refresh_cpu_all();
    c.system.refresh_memory();
    c.system
        .refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
    // Volume capacity and the thread table change slowly and cost ~4 ms and ~6 ms to read, so they are
    // refreshed every 10 s and 5 s respectively instead of on every snapshot (measured, see docs).
    if c.disks_at
        .is_none_or(|t| now.duration_since(t).as_secs() >= 10)
    {
        c.disks.refresh(true);
        c.disks_at = Some(now);
    }
    c.networks.refresh(true);
    let (gpu_snapshot, gpu_per_pid) = c.gpu.sample();
    let perf = c.perf.sample();
    if c.threads_at
        .is_none_or(|t| now.duration_since(t).as_secs() >= 5)
    {
        c.threads = procinfo::process_table();
        c.threads_at = Some(now);
    }
    let table = std::mem::take(&mut c.threads);
    // Adapter facts change rarely; refresh them every 10 seconds.
    if c.net_adapters
        .0
        .is_none_or(|t| now.duration_since(t).as_secs() >= 10)
    {
        c.net_adapters = (Some(now), netinfo::adapters());
    }

    let mut next_io: HashMap<String, (u64, u64)> = HashMap::new();
    let mut live_keys: Vec<String> = Vec::new();
    let mut processes = Vec::with_capacity(c.system.processes().len());
    for (pid, p) in c.system.processes() {
        let pid = pid.as_u32();
        let (identity, extra, user, io_rates) = match identity::open_for_query(pid) {
            Some((handle, id)) => {
                let key = format!("{pid}:{id}");
                let extra = procinfo::read_extra(&handle);
                let user = c
                    .users
                    .entry(key.clone())
                    .or_insert_with(|| procinfo::user_of(&handle))
                    .clone();
                let rates = match (extra.io_read_bytes, extra.io_write_bytes) {
                    (Some(r), Some(w)) => {
                        let prev = c.io_prev.get(&key).copied();
                        next_io.insert(key.clone(), (r, w));
                        (
                            counter_rate(prev.map(|p| p.0), r, elapsed),
                            counter_rate(prev.map(|p| p.1), w, elapsed),
                        )
                    }
                    _ => (None, None),
                };
                live_keys.push(key);
                (Some(id), extra, user, rates)
            }
            None => (None, Extra::default(), None, (None, None)),
        };
        let suspended = identity
            .as_deref()
            .is_some_and(|id| procinfo::is_suspended(pid, id));
        processes.push(ProcessInfo {
            pid,
            parent_pid: p.parent().map(|id| id.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cpu_usage: p.cpu_usage(),
            memory: p.memory(),
            status: if suspended {
                "Suspended".into()
            } else {
                format!("{:?}", p.status())
            },
            start_time: p.start_time(),
            identity,
            exe: p.exe().map(|path| path.to_string_lossy().into_owned()),
            command: p
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" "),
            user,
            thread_count: table.get(&pid).map(|t| t.0),
            extra,
            io_read_per_s: io_rates.0,
            io_write_per_s: io_rates.1,
            gpu_percent: gpu_snapshot
                .supported
                .then(|| gpu_per_pid.get(&pid).copied().unwrap_or(0.0)),
            suspended,
        });
    }
    c.io_prev = next_io;
    c.threads = table;
    c.users.retain(|k, _| live_keys.contains(k));

    let disks = c
        .disks
        .list()
        .iter()
        .map(|d| DiskInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount: d.mount_point().to_string_lossy().into_owned(),
            file_system: d.file_system().to_string_lossy().into_owned(),
            total: d.total_space(),
            available: d.available_space(),
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
    let collect_ms = started.elapsed().as_secs_f64() * 1000.0;
    Snapshot {
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
        memory_detail: memory_detail(),
        disks,
        networks,
        perf,
        gpu: gpu_snapshot,
        gpu_adapters: c.gpu_adapters.clone(),
        net_adapters: c.net_adapters.1.clone(),
        collect_ms,
        processes,
    }
}

/// Network totals without double counting: virtual filter adapters repeat the physical adapter's
/// counters, so only adapters that own a routable address are summed (falling back to the busiest one).
pub fn net_totals(networks: &[NetworkInfo]) -> (f64, f64) {
    let routable = |n: &&NetworkInfo| {
        n.addresses.iter().any(|a| {
            !(a.starts_with("fe80")
                || a.starts_with("169.254")
                || a.starts_with("127.")
                || a == "::1")
        })
    };
    let pick: Vec<&NetworkInfo> = networks.iter().filter(routable).collect();
    let sum = |list: &[&NetworkInfo]| {
        list.iter().fold((0.0, 0.0), |(rx, tx), n| {
            (
                rx + n.received_per_s.unwrap_or(0.0),
                tx + n.transmitted_per_s.unwrap_or(0.0),
            )
        })
    };
    if !pick.is_empty() {
        return sum(&pick);
    }
    networks
        .iter()
        .map(|n| {
            (
                n.received_per_s.unwrap_or(0.0),
                n.transmitted_per_s.unwrap_or(0.0),
            )
        })
        .fold((0.0, 0.0), |a, b| (f64::max(a.0, b.0), f64::max(a.1, b.1)))
}

impl Snapshot {
    pub fn to_sample(&self) -> crate::history::Sample {
        let (rx, tx) = net_totals(&self.networks);
        // Throughput comes from the physical-disk counters (the supported source for real disk traffic).
        let read: f64 = self
            .perf
            .physical_disks
            .iter()
            .map(|d| d.read_per_s.unwrap_or(0.0))
            .sum();
        let write: f64 = self
            .perf
            .physical_disks
            .iter()
            .map(|d| d.write_per_s.unwrap_or(0.0))
            .sum();
        crate::history::Sample {
            ts: self.timestamp as i64,
            cpu: f64::from(self.cpu_usage),
            mem: if self.total_memory > 0 {
                self.used_memory as f64 / self.total_memory as f64 * 100.0
            } else {
                0.0
            },
            gpu: self
                .gpu
                .supported
                .then(|| self.gpu.live.iter().map(|g| g.percent).fold(0.0, f64::max)),
            disk_active: self
                .perf
                .physical_disks
                .iter()
                .filter_map(|d| d.active_percent)
                .reduce(f64::max),
            disk_read: read,
            disk_write: write,
            net_rx: rx,
            net_tx: tx,
        }
    }

    /// Every process as a brief record (used to detect starts and exits between samples).
    pub fn brief_processes(&self) -> Vec<crate::history::ProcBrief> {
        self.processes
            .iter()
            .map(|p| crate::history::ProcBrief {
                pid: p.pid,
                identity: p.identity.clone(),
                name: p.name.clone(),
                cpu: p.cpu_usage,
                mem: p.memory,
            })
            .collect()
    }

    pub fn alert_metrics(&self, exited: Vec<String>) -> crate::alerts::Metrics {
        let s = self.to_sample();
        let free_min = self
            .disks
            .iter()
            .filter(|d| d.total > 0)
            .map(|d| d.available as f64 / d.total as f64 * 100.0)
            .reduce(f64::min);
        crate::alerts::Metrics {
            cpu: s.cpu,
            memory: s.mem,
            gpu: s.gpu,
            disk_active: s.disk_active,
            disk_free_min: free_min,
            processes: self
                .processes
                .iter()
                .map(|p| (p.name.to_lowercase(), f64::from(p.cpu_usage)))
                .collect(),
            exited,
        }
    }

    pub fn tray_text(&self) -> String {
        let s = self.to_sample();
        format!("TaskLens - CPU {:.0}%  RAM {:.0}%", s.cpu, s.mem)
    }
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
    fn counter_rates_handle_missing_and_backwards_counters() {
        assert_eq!(counter_rate(Some(100), 300, Some(2.0)), Some(100.0));
        assert_eq!(counter_rate(None, 300, Some(2.0)), None);
        assert_eq!(counter_rate(Some(500), 300, Some(2.0)), None);
        assert_eq!(counter_rate(Some(100), 300, None), None);
    }

    #[test]
    fn network_totals_ignore_virtual_duplicates() {
        let n = |name: &str, rx: f64, addr: &str| NetworkInfo {
            name: name.into(),
            received_per_s: Some(rx),
            transmitted_per_s: Some(1.0),
            total_received: 0,
            total_transmitted: 0,
            addresses: if addr.is_empty() {
                vec![]
            } else {
                vec![addr.into()]
            },
            mtu: 1500,
        };
        let list = vec![
            n("WiFi", 100.0, "192.168.1.5"),
            n("WiFi filter", 100.0, ""),
            n("Ethernet", 0.0, "fe80::1"),
        ];
        assert_eq!(net_totals(&list), (100.0, 1.0));
        let none = vec![n("a", 5.0, ""), n("b", 9.0, "")];
        assert_eq!(net_totals(&none).0, 9.0);
    }

    #[test]
    fn snapshot_reports_real_machine_data() {
        let mut c = new_collector();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let first = take_snapshot(&mut c);
        std::thread::sleep(std::time::Duration::from_millis(600));
        let s = take_snapshot(&mut c);
        assert!(s.total_memory > 0 && !s.cpu_cores.is_empty());
        assert!((0.0..=100.0).contains(&s.cpu_usage));
        assert!(!s.disks.is_empty());
        let me = std::process::id();
        let mine = s
            .processes
            .iter()
            .find(|p| p.pid == me)
            .expect("own process listed");
        assert!(mine.identity.is_some() && mine.user.is_some());
        assert!(mine.thread_count.unwrap() >= 1);
        assert!(mine.extra.handle_count.unwrap() > 0);
        assert!(mine.extra.private_bytes.unwrap() > 0);
        assert!(
            mine.extra.priority.is_some(),
            "priority class must be readable"
        );
        // First sample has no rates; the second does.
        let mine_first = first.processes.iter().find(|p| p.pid == me).unwrap();
        assert!(mine_first.io_read_per_s.is_none());
        assert!(mine.io_read_per_s.is_some());
        assert!(!s.perf.physical_disks.is_empty());
        assert!(s.memory_detail.commit_total.is_some());
        assert!(s.net_adapters.iter().any(|a| a.status == "Connected"));
        assert!(
            s.collect_ms > 0.0 && s.collect_ms < 5000.0,
            "collect_ms {}",
            s.collect_ms
        );
    }
    /// Prints where one snapshot spends its time. Run with:
    /// cargo test --release profile_phases -- --ignored --nocapture
    #[test]
    #[ignore]
    fn profile_phases() {
        let mut c = new_collector();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = take_snapshot(&mut c);
        let n = 20;
        let mut t = [0f64; 8];
        for _ in 0..n {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let mut lap = Instant::now();
            let mut mark = |slot: usize, lap: &mut Instant| {
                t[slot] += lap.elapsed().as_secs_f64() * 1000.0;
                *lap = Instant::now();
            };
            c.system.refresh_cpu_all();
            c.system.refresh_memory();
            mark(0, &mut lap);
            c.system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                process_refresh_kind(),
            );
            mark(1, &mut lap);
            c.disks.refresh(true);
            c.networks.refresh(true);
            mark(2, &mut lap);
            let _ = c.gpu.sample();
            mark(3, &mut lap);
            let _ = c.perf.sample();
            mark(4, &mut lap);
            let _ = procinfo::process_table();
            mark(5, &mut lap);
            for pid in c.system.processes().keys() {
                if let Some((h, _)) = identity::open_for_query(pid.as_u32()) {
                    let _ = procinfo::read_extra(&h);
                }
            }
            mark(6, &mut lap);
            let _ = memory_detail();
            mark(7, &mut lap);
        }
        // Which sysinfo process options cost the most?
        for (label, kind) in [
            (
                "sysinfo: list only (exe+cmd cached)",
                ProcessRefreshKind::nothing()
                    .with_exe(UpdateKind::OnlyIfNotSet)
                    .with_cmd(UpdateKind::OnlyIfNotSet),
            ),
            (
                "sysinfo: + cpu",
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_exe(UpdateKind::OnlyIfNotSet)
                    .with_cmd(UpdateKind::OnlyIfNotSet),
            ),
            (
                "sysinfo: + memory",
                ProcessRefreshKind::nothing()
                    .with_memory()
                    .with_exe(UpdateKind::OnlyIfNotSet)
                    .with_cmd(UpdateKind::OnlyIfNotSet),
            ),
            ("sysinfo: + cpu + memory (current)", process_refresh_kind()),
        ] {
            let mut total = 0.0;
            for _ in 0..n {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let s = Instant::now();
                c.system
                    .refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
                total += s.elapsed().as_secs_f64() * 1000.0;
            }
            println!("{label:<38} {:>7.2} ms", total / n as f64);
        }
        let names = [
            "cpu+mem refresh",
            "process refresh (sysinfo)",
            "disks+networks refresh",
            "GPU PDH",
            "disk/memory PDH",
            "toolhelp table",
            "per-process handle queries",
            "memory detail",
        ];
        for (i, n_) in names.iter().enumerate() {
            println!("{:<30} {:>7.2} ms", n_, t[i] / n as f64);
        }
    }
}
