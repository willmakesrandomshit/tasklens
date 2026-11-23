//! GPU monitoring from Windows' own performance counters (the same source Task Manager uses) plus
//! static adapter details from the display-driver registry class. No vendor SDK is needed.
//!
//! Not available through these interfaces, and therefore reported as unavailable instead of guessed:
//! temperatures, clock speeds and power draw. Per-process figures exist only for processes that
//! currently have GPU engine counters.

use crate::pdh::Query;
use serde::Serialize;
use std::collections::HashMap;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

const DISPLAY_CLASS: &str =
    r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

#[derive(Serialize, Clone, Debug)]
pub struct GpuAdapterInfo {
    pub name: String,
    pub driver_version: Option<String>,
    pub driver_date: Option<String>,
    pub provider: Option<String>,
    /// Dedicated video memory in bytes as recorded by the driver; `None` when the driver omits it.
    pub dedicated_memory: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuEngine {
    pub engine_type: String,
    pub percent: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuLive {
    /// Adapter locally-unique id as it appears in the counters (e.g. `luid_0x00000000_0x0000a1b2`).
    pub luid: String,
    /// Highest utilisation across this adapter's engines.
    pub percent: f64,
    pub engines: Vec<GpuEngine>,
    pub dedicated_used: Option<u64>,
    pub shared_used: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct GpuSnapshot {
    /// False when Windows exposes no GPU counters on this machine.
    pub supported: bool,
    pub live: Vec<GpuLive>,
}

pub struct GpuSampler {
    query: Option<Query>,
}

/// Reads the display-adapter list from the driver registry class.
pub fn adapters() -> Vec<GpuAdapterInfo> {
    let Ok(class) =
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(DISPLAY_CLASS, KEY_READ)
    else {
        return Vec::new();
    };
    let mut out: Vec<GpuAdapterInfo> = class
        .enum_keys()
        .filter_map(Result::ok)
        .filter(|k| k.len() == 4 && k.bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|k| {
            let key = class.open_subkey_with_flags(&k, KEY_READ).ok()?;
            let name: String = key.get_value("DriverDesc").ok()?;
            let memory = key
                .get_value::<u64, _>("HardwareInformation.qwMemorySize")
                .ok()
                .or_else(|| {
                    key.get_value::<u32, _>("HardwareInformation.MemorySize")
                        .ok()
                        .map(u64::from)
                })
                .filter(|m| *m > 0);
            Some(GpuAdapterInfo {
                name,
                driver_version: key.get_value("DriverVersion").ok(),
                driver_date: key.get_value("DriverDate").ok(),
                provider: key.get_value("ProviderName").ok(),
                dedicated_memory: memory,
            })
        })
        .collect();
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// Extracts `(pid, luid, engine_index_key, engine_type)` from an instance name such as
/// `pid_1234_luid_0x00000000_0x0000A1B2_phys_0_eng_3_engtype_3D`.
pub fn parse_engine_instance(name: &str) -> Option<(u32, String, String, String)> {
    let rest = name.strip_prefix("pid_")?;
    let (pid, rest) = rest.split_once("_luid_")?;
    let (luid, rest) = rest.split_once("_phys_")?;
    let (engine, engtype) = rest.split_once("_engtype_")?;
    Some((
        pid.parse().ok()?,
        format!("luid_{luid}"),
        format!("{luid}_phys_{engine}"),
        engtype.to_string(),
    ))
}

impl GpuSampler {
    pub fn new() -> GpuSampler {
        let query = Query::new(&[
            ("engine", r"\GPU Engine(*)\Utilization Percentage"),
            ("dedicated", r"\GPU Adapter Memory(*)\Dedicated Usage"),
            ("shared", r"\GPU Adapter Memory(*)\Shared Usage"),
        ]);
        GpuSampler {
            query: query.filter(|q| q.has("engine")),
        }
    }

    /// Collects a new sample. Returns the adapter-level snapshot and per-process peak engine use.
    pub fn sample(&mut self) -> (GpuSnapshot, HashMap<u32, f32>) {
        let Some(q) = self.query.as_mut() else {
            return (GpuSnapshot::default(), HashMap::new());
        };
        q.collect();
        // Sum per physical engine across processes (an engine is busy for all its clients together).
        let mut per_engine: HashMap<(String, String, String), f64> = HashMap::new();
        let mut per_pid_engine: HashMap<(u32, String), f64> = HashMap::new();
        for (name, value) in q.values("engine") {
            if let Some((pid, luid, engine, engtype)) = parse_engine_instance(&name) {
                *per_engine
                    .entry((luid, engine.clone(), engtype))
                    .or_default() += value;
                *per_pid_engine.entry((pid, engine)).or_default() += value;
            }
        }
        let mut per_pid: HashMap<u32, f32> = HashMap::new();
        for ((pid, _), v) in per_pid_engine {
            let e = per_pid.entry(pid).or_default();
            *e = e.max(v.min(100.0) as f32);
        }

        let mut by_luid: HashMap<String, Vec<GpuEngine>> = HashMap::new();
        let mut max_by_luid: HashMap<String, f64> = HashMap::new();
        for ((luid, _engine, engtype), v) in per_engine {
            let v = v.min(100.0);
            let m = max_by_luid.entry(luid.clone()).or_default();
            *m = m.max(v);
            let list = by_luid.entry(luid).or_default();
            match list.iter_mut().find(|e| e.engine_type == engtype) {
                Some(e) => e.percent = e.percent.max(v),
                None => list.push(GpuEngine {
                    engine_type: engtype,
                    percent: v,
                }),
            }
        }
        let mem = |key: &str| -> HashMap<String, u64> {
            q.values(key)
                .into_iter()
                .filter_map(|(n, v)| {
                    // Memory instance names look like `luid_0x..._0x..._phys_0`.
                    n.split("_phys_")
                        .next()
                        .map(|l| (l.to_string(), v.max(0.0) as u64))
                })
                .collect()
        };
        let (dedicated, shared) = (mem("dedicated"), mem("shared"));
        let mut live: Vec<GpuLive> = by_luid
            .into_iter()
            .map(|(luid, mut engines)| {
                engines.sort_by(|a, b| a.engine_type.cmp(&b.engine_type));
                GpuLive {
                    percent: max_by_luid.get(&luid).copied().unwrap_or(0.0),
                    dedicated_used: dedicated.get(&luid).copied(),
                    shared_used: shared.get(&luid).copied(),
                    luid,
                    engines,
                }
            })
            .collect();
        live.sort_by(|a, b| a.luid.cmp(&b.luid));
        (
            GpuSnapshot {
                supported: true,
                live,
            },
            per_pid,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_instance_names() {
        let (pid, luid, engine, ty) =
            parse_engine_instance("pid_4321_luid_0x00000000_0x0000A1B2_phys_0_eng_3_engtype_3D")
                .unwrap();
        assert_eq!(pid, 4321);
        assert_eq!(luid, "luid_0x00000000_0x0000A1B2");
        assert_eq!(engine, "0x00000000_0x0000A1B2_phys_0_eng_3");
        assert_eq!(ty, "3D");
        assert!(parse_engine_instance("garbage").is_none());
        assert!(parse_engine_instance("pid_x_luid_1_phys_0_eng_0_engtype_3D").is_none());
    }

    #[test]
    fn sampler_never_panics_and_reports_support_honestly() {
        let mut s = GpuSampler::new();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let (snap, per_pid) = s.sample();
        if snap.supported {
            assert!(snap.live.iter().all(|g| (0.0..=100.0).contains(&g.percent)));
            assert!(per_pid.values().all(|v| (0.0..=100.0).contains(v)));
        } else {
            assert!(snap.live.is_empty() && per_pid.is_empty());
        }
    }

    #[test]
    fn adapter_list_is_readable() {
        // May be empty on exotic machines, but must not panic; names are non-empty when present.
        assert!(adapters().iter().all(|a| !a.name.is_empty()));
    }
}
