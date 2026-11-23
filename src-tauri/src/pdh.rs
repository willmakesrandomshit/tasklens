//! Thin wrapper over the Windows Performance Data Helper (PDH).
//!
//! PDH is the supported way to read GPU engine utilisation, physical-disk activity/latency, memory
//! list sizes and link speeds without vendor SDKs or administrator rights. Counter names are added in
//! their English form so the app works on localised Windows installs.

use std::collections::HashMap;
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
};

const PDH_MORE_DATA: u32 = 0x8000_07D2;
const ERROR_SUCCESS: u32 = 0;

pub struct Query {
    handle: isize,
    counters: Vec<(&'static str, isize)>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl Query {
    /// Opens a query and adds each `(key, english_counter_path)`. Counters that do not exist on this
    /// machine (e.g. no GPU counters) are skipped, so the query still works for the rest.
    pub fn new(paths: &[(&'static str, &str)]) -> Option<Query> {
        let mut handle = 0isize;
        // SAFETY: null data source = real-time local data; `handle` receives the query handle.
        if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut handle) } != ERROR_SUCCESS {
            return None;
        }
        let mut q = Query {
            handle,
            counters: Vec::new(),
        };
        for (key, path) in paths {
            let mut counter = 0isize;
            let w = wide(path);
            // SAFETY: `w` is NUL-terminated and outlives the call.
            if unsafe { PdhAddEnglishCounterW(handle, w.as_ptr(), 0, &mut counter) }
                == ERROR_SUCCESS
            {
                q.counters.push((key, counter));
            }
        }
        // Prime rate counters: they need two samples before they produce values.
        q.collect();
        Some(q)
    }

    pub fn has(&self, key: &str) -> bool {
        self.counters.iter().any(|(k, _)| *k == key)
    }

    pub fn collect(&mut self) -> bool {
        // SAFETY: valid query handle.
        unsafe { PdhCollectQueryData(self.handle) == ERROR_SUCCESS }
    }

    /// All instances of a wildcard counter as `(instance_name, value)`. Instances without valid data
    /// are omitted rather than reported as zero.
    pub fn values(&self, key: &str) -> Vec<(String, f64)> {
        let Some(&(_, counter)) = self.counters.iter().find(|(k, _)| *k == key) else {
            return Vec::new();
        };
        let mut size = 0u32;
        let mut count = 0u32;
        // SAFETY: size probe with a null buffer.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                std::ptr::null_mut(),
            )
        };
        if status != PDH_MORE_DATA || size == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        // SAFETY: aligned buffer of at least `size` bytes.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, items)
        };
        if status != ERROR_SUCCESS {
            return Vec::new();
        }
        (0..count as usize)
            .filter_map(|i| {
                // SAFETY: PDH wrote `count` items; names point into `buf`, which is alive.
                let item = unsafe { &*items.add(i) };
                if item.FmtValue.CStatus > 1 || item.szName.is_null() {
                    return None; // 0 = valid, 1 = new data; anything else is not usable
                }
                let mut len = 0;
                // SAFETY: `szName` is a NUL-terminated UTF-16 string inside `buf`.
                unsafe {
                    while *item.szName.add(len) != 0 {
                        len += 1;
                    }
                }
                let name = String::from_utf16_lossy(unsafe {
                    std::slice::from_raw_parts(item.szName, len)
                });
                let value = unsafe { item.FmtValue.Anonymous.doubleValue };
                value.is_finite().then_some((name, value))
            })
            .collect()
    }

    pub fn map(&self, key: &str) -> HashMap<String, f64> {
        self.values(key).into_iter().collect()
    }

    pub fn single(&self, key: &str) -> Option<f64> {
        self.values(key).into_iter().next().map(|(_, v)| v)
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        // SAFETY: closes the query and its counters exactly once.
        unsafe { PdhCloseQuery(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_real_counter_after_two_samples() {
        let mut q = Query::new(&[("cpu", r"\Processor Information(_Total)\% Processor Time")])
            .expect("open");
        assert!(q.has("cpu"));
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(q.collect());
        let v = q.single("cpu").expect("a value");
        assert!((0.0..=100.5).contains(&v), "cpu {v}");
    }

    #[test]
    fn missing_counters_are_skipped_not_fatal() {
        let q = Query::new(&[
            ("nope", r"\ThisObjectDoesNotExist(*)\Nothing"),
            ("mem", r"\Memory\Available Bytes"),
        ])
        .unwrap();
        assert!(!q.has("nope"));
        assert!(q.has("mem"));
        assert!(q.values("nope").is_empty());
    }

    #[test]
    fn physical_disk_counters_have_instances() {
        let mut q = Query::new(&[("busy", r"\PhysicalDisk(*)\% Disk Time")]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        q.collect();
        assert!(q.values("busy").iter().any(|(n, _)| n == "_Total"));
    }
}
