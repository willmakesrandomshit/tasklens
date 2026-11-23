//! Static system information, memory accounting, user sessions and per-file version/signature data.

use crate::gpu::{self, GpuAdapterInfo};
use serde::Serialize;
use std::mem::{size_of, zeroed};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSEnumerateSessionsW, WTSFreeMemory, WTSQuerySessionInformationW, WTS_SESSION_INFOW,
};
use windows_sys::Win32::System::SystemInformation::GetFirmwareType;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

#[derive(Serialize, Clone, Debug)]
pub struct SystemInfo {
    pub os_name: String,
    pub os_version: Option<String>,
    pub os_build: Option<String>,
    pub device_name: Option<String>,
    pub uptime_secs: u64,
    pub architecture: &'static str,
    /// "UEFI", "Legacy BIOS" or `None` when Windows does not say.
    pub boot_mode: Option<&'static str>,
    pub cpu_name: Option<String>,
    pub cpu_base_mhz: Option<u32>,
    pub gpus: Vec<GpuAdapterInfo>,
}

fn nt_current_version() -> Option<RegKey> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", KEY_READ)
        .ok()
}

fn boot_mode() -> Option<&'static str> {
    let mut kind = 0i32;
    // SAFETY: `kind` is a live local.
    if unsafe { GetFirmwareType(&mut kind) } == 0 {
        return None;
    }
    match kind {
        1 => Some("Legacy BIOS"),
        2 => Some("UEFI"),
        _ => None,
    }
}

pub fn system_info() -> SystemInfo {
    let nt = nt_current_version();
    let get = |name: &str| {
        nt.as_ref()
            .and_then(|k| k.get_value::<String, _>(name).ok())
    };
    let build: Option<u32> = get("CurrentBuildNumber").and_then(|b| b.parse().ok());
    let ubr = nt.as_ref().and_then(|k| k.get_value::<u32, _>("UBR").ok());
    // The registry still says "Windows 10" on Windows 11; the build number is authoritative.
    let os_name = match (get("ProductName"), build) {
        (Some(n), Some(b)) if b >= 22000 => n.replace("Windows 10", "Windows 11"),
        (Some(n), _) => n,
        _ => "Windows".to_string(),
    };
    let cpu = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", KEY_READ)
        .ok();
    SystemInfo {
        os_name,
        os_version: get("DisplayVersion"),
        os_build: build.map(|b| match ubr {
            Some(u) => format!("{b}.{u}"),
            None => b.to_string(),
        }),
        device_name: sysinfo::System::host_name(),
        uptime_secs: sysinfo::System::uptime(),
        architecture: if cfg!(target_arch = "aarch64") {
            "ARM64"
        } else {
            "x64"
        },
        boot_mode: boot_mode(),
        cpu_name: cpu
            .as_ref()
            .and_then(|k| k.get_value::<String, _>("ProcessorNameString").ok())
            .map(|s| s.trim().to_string()),
        cpu_base_mhz: cpu
            .as_ref()
            .and_then(|k| k.get_value::<u32, _>("~MHz").ok()),
        gpus: gpu::adapters(),
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct MemoryDetail {
    /// Committed bytes and the limit (RAM + page files). Commit is promised memory, not resident memory.
    pub commit_total: Option<u64>,
    pub commit_limit: Option<u64>,
    pub commit_peak: Option<u64>,
    /// File cache held by the system, in bytes.
    pub system_cache: Option<u64>,
    pub kernel_paged: Option<u64>,
    pub kernel_nonpaged: Option<u64>,
    pub handle_count: Option<u32>,
    pub process_count: Option<u32>,
    pub thread_count: Option<u32>,
}

pub fn memory_detail() -> MemoryDetail {
    // SAFETY: `info` is a live PERFORMANCE_INFORMATION with `cb` set to its size.
    let mut info: PERFORMANCE_INFORMATION = unsafe { zeroed() };
    info.cb = size_of::<PERFORMANCE_INFORMATION>() as u32;
    if unsafe { GetPerformanceInfo(&mut info, info.cb) } == 0 {
        return MemoryDetail::default();
    }
    let page = info.PageSize as u64;
    MemoryDetail {
        commit_total: Some(info.CommitTotal as u64 * page),
        commit_limit: Some(info.CommitLimit as u64 * page),
        commit_peak: Some(info.CommitPeak as u64 * page),
        system_cache: Some(info.SystemCache as u64 * page),
        kernel_paged: Some(info.KernelPaged as u64 * page),
        kernel_nonpaged: Some(info.KernelNonpaged as u64 * page),
        handle_count: Some(info.HandleCount),
        process_count: Some(info.ProcessCount),
        thread_count: Some(info.ThreadCount),
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionInfo {
    pub id: u32,
    pub station: String,
    pub state: &'static str,
    pub user: Option<String>,
}

fn state_name(state: i32) -> &'static str {
    match state {
        0 => "Active",
        1 => "Connected",
        2 => "Connecting",
        3 => "Shadowing",
        4 => "Disconnected",
        5 => "Idle",
        6 => "Listening",
        7 => "Resetting",
        8 => "Down",
        9 => "Initializing",
        _ => "Unknown",
    }
}

/// SAFETY: `p` must be null or a NUL-terminated UTF-16 string.
unsafe fn read_wstr(p: *const u16) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let mut len = 0;
    while *p.add(len) != 0 {
        len += 1;
    }
    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
    (!s.is_empty()).then_some(s)
}

fn session_string(id: u32, class: i32) -> Option<String> {
    let mut p: *mut u16 = std::ptr::null_mut();
    let mut bytes = 0u32;
    // SAFETY: on success WTS allocates a string we must free with WTSFreeMemory.
    unsafe {
        if WTSQuerySessionInformationW(std::ptr::null_mut(), id, class, &mut p, &mut bytes) == 0 {
            return None;
        }
        let s = read_wstr(p);
        WTSFreeMemory(p as *mut _);
        s
    }
}

/// Sessions on this machine. Reads names and states only; nothing about session contents.
pub fn sessions() -> Vec<SessionInfo> {
    let mut ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: on success `ptr` points to `count` entries owned by WTS, freed below.
    unsafe {
        if WTSEnumerateSessionsW(std::ptr::null_mut(), 0, 1, &mut ptr, &mut count) == 0 {
            return Vec::new();
        }
        let list = std::slice::from_raw_parts(ptr, count as usize);
        let out = list
            .iter()
            .map(|s| {
                let user = session_string(s.SessionId, 5);
                let domain = session_string(s.SessionId, 7);
                SessionInfo {
                    id: s.SessionId,
                    station: read_wstr(s.pWinStationName).unwrap_or_default(),
                    state: state_name(s.State),
                    user: user.map(|u| match domain {
                        Some(d) => format!("{d}\\{u}"),
                        None => u,
                    }),
                }
            })
            .collect();
        WTSFreeMemory(ptr as *mut _);
        out
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FileInfo {
    pub description: Option<String>,
    pub company: Option<String>,
    pub product: Option<String>,
    pub version: Option<String>,
    /// Embedded Authenticode result: "Valid", "Not signed (embedded)", "Invalid", or "Unknown".
    /// Windows system files are often signed through catalogs and show as "Not signed (embedded)";
    /// "unsigned" never means "malicious".
    pub signature: &'static str,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn version_strings(path: &str) -> FileInfo {
    let mut info = FileInfo {
        signature: "Unknown",
        ..Default::default()
    };
    let w = wide(path);
    let mut handle = 0u32;
    // SAFETY: `w` is NUL-terminated; sizes come from the API itself.
    let size = unsafe { GetFileVersionInfoSizeW(w.as_ptr(), &mut handle) };
    if size == 0 {
        return info;
    }
    let mut block = vec![0u8; size as usize];
    // SAFETY: `block` is `size` bytes.
    if unsafe { GetFileVersionInfoW(w.as_ptr(), 0, size, block.as_mut_ptr() as *mut _) } == 0 {
        return info;
    }
    let query = |sub: &str| -> Option<String> {
        let s = wide(sub);
        let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: `block` stays alive while `p` (which points into it) is read.
        let ok =
            unsafe { VerQueryValueW(block.as_ptr() as *const _, s.as_ptr(), &mut p, &mut len) };
        if ok == 0 || p.is_null() || len == 0 {
            return None;
        }
        let units = unsafe { std::slice::from_raw_parts(p as *const u16, len as usize) };
        let end = units.iter().position(|&c| c == 0).unwrap_or(units.len());
        let v = String::from_utf16_lossy(&units[..end]).trim().to_string();
        (!v.is_empty()).then_some(v)
    };
    // First language/codepage pair of the file's translation table.
    let translation = {
        let s = wide(r"\VarFileInfo\Translation");
        let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: as above; the table is an array of (lang, codepage) u16 pairs.
        let ok =
            unsafe { VerQueryValueW(block.as_ptr() as *const _, s.as_ptr(), &mut p, &mut len) };
        (ok != 0 && len >= 4).then(|| unsafe { *(p as *const [u16; 2]) })
    };
    if let Some([lang, cp]) = translation {
        let get = |name: &str| query(&format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\{name}"));
        info.description = get("FileDescription");
        info.company = get("CompanyName");
        info.product = get("ProductName");
        info.version = get("FileVersion");
    }
    info
}

/// Version-resource details plus an embedded-signature check for an executable on disk.
pub fn file_info(path: &str) -> FileInfo {
    let mut info = version_strings(path);
    info.signature = verify_signature(path);
    info
}

fn verify_signature(path: &str) -> &'static str {
    use windows_sys::Win32::Security::WinTrust::{
        WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
        WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };
    let w = wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: w.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    // SAFETY: all-zero is a valid initial WINTRUST_DATA; the fields we need are set below.
    let mut data: WINTRUST_DATA = unsafe { zeroed() };
    data.cbStruct = size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE; // never hit the network
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous = WINTRUST_DATA_0 { pFile: &mut file };
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: `data`, `file` and `w` outlive both calls; the second call releases the state.
    let status = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut _ as *mut _,
        )
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut(),
            &mut action,
            &mut data as *mut _ as *mut _,
        )
    };
    match status as u32 {
        0 => "Valid",
        0x800B0100 => "Not signed (embedded)",
        _ => "Invalid",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_info_is_populated() {
        let s = system_info();
        assert!(s.os_name.starts_with("Windows"));
        assert!(s.os_build.is_some());
        assert!(s.uptime_secs > 0);
        assert!(s.device_name.is_some());
        assert!(s.cpu_name.is_some_and(|n| !n.is_empty()));
    }

    #[test]
    fn memory_detail_is_consistent() {
        let m = memory_detail();
        let (total, limit) = (m.commit_total.unwrap(), m.commit_limit.unwrap());
        assert!(total > 0 && limit >= total);
        assert!(m.kernel_paged.unwrap() > 0 && m.process_count.unwrap() > 10);
    }

    #[test]
    fn lists_at_least_the_console_or_services_session() {
        let s = sessions();
        assert!(
            s.iter()
                .any(|x| x.id == 0 || x.station.eq_ignore_ascii_case("console")),
            "{s:?}"
        );
    }

    #[test]
    fn reads_version_info_and_signature_of_a_real_file() {
        let path = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let f = file_info(path);
        assert_eq!(f.company.as_deref(), Some("Microsoft Corporation"));
        assert!(f.description.is_some() && f.version.is_some());
        assert!(
            ["Valid", "Not signed (embedded)"].contains(&f.signature),
            "{}",
            f.signature
        );
    }

    #[test]
    fn missing_files_degrade_gracefully() {
        let f = file_info(r"C:\definitely\not\here.exe");
        assert!(f.company.is_none());
        assert_eq!(f.signature, "Invalid"); // WinVerifyTrust reports file-not-found as a failure
    }
}
