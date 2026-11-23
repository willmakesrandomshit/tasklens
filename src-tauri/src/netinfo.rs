//! Network adapter facts from the IP Helper API: friendly name, status, type and negotiated link speed.
//! Names match the ones used by the throughput counters, so rows can be joined reliably.

use serde::Serialize;
use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
    IP_ADAPTER_ADDRESSES_LH,
};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AdapterInfo {
    pub name: String,
    pub description: String,
    pub status: &'static str,
    pub kind: &'static str,
    /// Negotiated link speed in bits per second; `None` when Windows reports it as unknown.
    pub link_speed_bps: Option<u64>,
}

pub fn status_name(status: i32) -> &'static str {
    match status {
        1 => "Connected",
        2 => "Disconnected",
        3 => "Testing",
        5 => "Dormant",
        6 => "Not present",
        7 => "Lower layer down",
        _ => "Unknown",
    }
}

pub fn kind_name(if_type: u32) -> &'static str {
    match if_type {
        6 => "Ethernet",
        71 => "Wi-Fi",
        24 => "Loopback",
        131 | 53 => "Virtual / tunnel",
        23 => "PPP",
        243 | 244 => "Mobile broadband",
        _ => "Other",
    }
}

/// SAFETY: `p` must be null or a NUL-terminated UTF-16 string.
unsafe fn wstr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

pub fn adapters() -> Vec<AdapterInfo> {
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size = 32 * 1024u32;
    for _ in 0..6 {
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let head = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        // SAFETY: aligned buffer of `size` bytes; Windows fills a linked list inside it.
        let status = unsafe { GetAdaptersAddresses(0, flags, std::ptr::null(), head, &mut size) };
        if status == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if status != NO_ERROR {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut cur = head as *const IP_ADAPTER_ADDRESSES_LH;
        // SAFETY: the list lives inside `buf`, which outlives this loop; `Next` is null-terminated.
        unsafe {
            while !cur.is_null() {
                let a = &*cur;
                let speed = a.TransmitLinkSpeed.max(a.ReceiveLinkSpeed);
                out.push(AdapterInfo {
                    name: wstr(a.FriendlyName),
                    description: wstr(a.Description),
                    status: status_name(a.OperStatus),
                    kind: kind_name(a.IfType),
                    link_speed_bps: (speed != 0 && speed != u64::MAX).then_some(speed),
                });
                cur = a.Next;
            }
        }
        return out;
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_real_adapters_with_status_and_speed() {
        let list = adapters();
        assert!(!list.is_empty(), "at least one adapter");
        assert!(list.iter().all(|a| !a.name.is_empty()));
        assert!(
            list.iter()
                .any(|a| a.status == "Connected" && a.link_speed_bps.is_some_and(|s| s > 0)),
            "a connected adapter with a known link speed: {list:?}"
        );
    }

    #[test]
    fn maps_status_and_type_codes() {
        assert_eq!(status_name(1), "Connected");
        assert_eq!(status_name(2), "Disconnected");
        assert_eq!(status_name(99), "Unknown");
        assert_eq!(kind_name(71), "Wi-Fi");
        assert_eq!(kind_name(6), "Ethernet");
        assert_eq!(kind_name(9999), "Other");
    }
}
