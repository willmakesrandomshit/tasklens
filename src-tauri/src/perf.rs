//! PDH-backed metrics that sysinfo cannot supply: physical-disk activity and latency, the memory page
//! lists (standby/modified/free). Every value is `Option` so "not measurable"
//! is never shown as zero.

use crate::pdh::Query;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct PhysicalDisk {
    /// PDH instance, e.g. `0 C:` (disk number and its volume letters).
    pub name: String,
    /// Percent of time the disk was busy (clamped to 100).
    pub active_percent: Option<f64>,
    /// Average time per transfer in milliseconds.
    pub response_ms: Option<f64>,
    pub read_per_s: Option<f64>,
    pub write_per_s: Option<f64>,
    pub queue_length: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct MemoryLists {
    pub standby: Option<u64>,
    pub modified: Option<u64>,
    pub free: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct PerfSnapshot {
    pub physical_disks: Vec<PhysicalDisk>,
    pub memory_lists: MemoryLists,
}

pub struct PerfSampler {
    query: Option<Query>,
}

impl PerfSampler {
    pub fn new() -> PerfSampler {
        PerfSampler {
            query: Query::new(&[
                ("disk_busy", r"\PhysicalDisk(*)\% Disk Time"),
                ("disk_lat", r"\PhysicalDisk(*)\Avg. Disk sec/Transfer"),
                ("disk_read", r"\PhysicalDisk(*)\Disk Read Bytes/sec"),
                ("disk_write", r"\PhysicalDisk(*)\Disk Write Bytes/sec"),
                ("disk_queue", r"\PhysicalDisk(*)\Current Disk Queue Length"),
                ("standby_core", r"\Memory\Standby Cache Core Bytes"),
                (
                    "standby_normal",
                    r"\Memory\Standby Cache Normal Priority Bytes",
                ),
                ("standby_reserve", r"\Memory\Standby Cache Reserve Bytes"),
                ("modified", r"\Memory\Modified Page List Bytes"),
                ("free", r"\Memory\Free & Zero Page List Bytes"),
                ("link", r"\Network Interface(*)\Current Bandwidth"),
            ]),
        }
    }

    pub fn sample(&mut self) -> PerfSnapshot {
        let Some(q) = self.query.as_mut() else {
            return PerfSnapshot::default();
        };
        q.collect();
        let busy = q.map("disk_busy");
        let lat = q.map("disk_lat");
        let read = q.map("disk_read");
        let write = q.map("disk_write");
        let queue = q.map("disk_queue");
        let mut physical_disks: Vec<PhysicalDisk> = busy
            .keys()
            .chain(read.keys())
            .filter(|n| *n != "_Total")
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|name| PhysicalDisk {
                name: name.clone(),
                active_percent: busy.get(name).map(|v| v.clamp(0.0, 100.0)),
                response_ms: lat.get(name).map(|v| v * 1000.0),
                read_per_s: read.get(name).copied(),
                write_per_s: write.get(name).copied(),
                queue_length: queue.get(name).copied(),
            })
            .collect();
        physical_disks.sort_by(|a, b| a.name.cmp(&b.name));

        let sum = |keys: &[&str]| -> Option<u64> {
            let parts: Vec<f64> = keys.iter().filter_map(|k| q.single(k)).collect();
            (!parts.is_empty()).then(|| parts.iter().sum::<f64>().max(0.0) as u64)
        };
        let memory_lists = MemoryLists {
            standby: sum(&["standby_core", "standby_normal", "standby_reserve"]),
            modified: sum(&["modified"]),
            free: sum(&["free"]),
        };
        PerfSnapshot {
            physical_disks,
            memory_lists,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_real_disk_and_memory_data() {
        let mut s = PerfSampler::new();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let snap = s.sample();
        assert!(
            !snap.physical_disks.is_empty(),
            "at least one physical disk"
        );
        assert!(snap
            .physical_disks
            .iter()
            .all(|d| d.active_percent.is_none_or(|p| (0.0..=100.0).contains(&p))));
        assert!(snap.memory_lists.free.is_some_and(|f| f > 0));
        assert!(snap.memory_lists.standby.is_some());
    }
}
