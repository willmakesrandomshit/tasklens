//! Windows Service Control Manager access: list services with their configuration and
//! start/stop/restart them. Uses the documented SCM APIs only.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA,
    ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_NOT_ACTIVE,
};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, ControlService, EnumServicesStatusExW, OpenSCManagerW, OpenServiceW,
    QueryServiceConfig2W, QueryServiceConfigW, QueryServiceStatusEx, StartServiceW,
    ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW, SC_ENUM_PROCESS_INFO, SC_MANAGER_CONNECT,
    SC_MANAGER_ENUMERATE_SERVICE, SC_STATUS_PROCESS_INFO, SERVICE_ACCEPT_STOP,
    SERVICE_CONFIG_DESCRIPTION, SERVICE_CONTROL_STOP, SERVICE_DESCRIPTIONW, SERVICE_QUERY_CONFIG,
    SERVICE_QUERY_STATUS, SERVICE_START, SERVICE_STATE_ALL, SERVICE_STATUS, SERVICE_STATUS_PROCESS,
    SERVICE_STOP, SERVICE_WIN32,
};

/// Services that must never be stopped or restarted from a task manager: stopping them
/// destabilises Windows or silently disables security protection.
const PROTECTED: &[&str] = &[
    "rpcss",
    "rpceptmapper",
    "dcomlaunch",
    "lsm",
    "samss",
    "eventlog",
    "windefend",
    "wdnissvc",
    "sense",
    "mpssvc",
    "bfe",
    "winmgmt",
    "cryptsvc",
    "wscsvc",
    "trustedinstaller",
    "profsvc",
    "gpsvc",
    "schedule",
    "userinit",
];

#[derive(Serialize, Clone, Debug)]
pub struct ServiceInfo {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    /// Running, Stopped, Starting, Stopping, Paused, ...
    pub state: String,
    /// Automatic, Manual, Disabled (Boot/System never appear for Win32 services).
    pub start_type: String,
    pub pid: Option<u32>,
    pub path: Option<String>,
    pub account: Option<String>,
    pub dependencies: Vec<String>,
    pub can_stop: bool,
    pub protected: bool,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ServiceError {
    InvalidName,
    NotFound,
    AccessDenied,
    Protected(String),
    Timeout,
    Os(u32),
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidName => write!(f, "Invalid service name."),
            Self::NotFound => write!(f, "That service no longer exists."),
            Self::AccessDenied => write!(
                f,
                "Windows denied access. Starting or stopping most services needs administrator rights."
            ),
            Self::Protected(name) => write!(
                f,
                "Refused: {name} is a core Windows or security service and cannot be stopped from here."
            ),
            Self::Timeout => write!(f, "The service did not reach the requested state in time."),
            Self::Os(code) => write!(f, "Windows reported error {code}."),
        }
    }
}

fn map_error(code: u32) -> ServiceError {
    match code {
        ERROR_ACCESS_DENIED => ServiceError::AccessDenied,
        ERROR_SERVICE_DOES_NOT_EXIST => ServiceError::NotFound,
        other => ServiceError::Os(other),
    }
}

struct ScHandle(*mut core::ffi::c_void);

impl Drop for ScHandle {
    fn drop(&mut self) {
        // SAFETY: handle came from OpenSCManagerW/OpenServiceW and is closed once.
        unsafe { CloseServiceHandle(self.0) };
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// SAFETY: `p` must be null or point to a NUL-terminated UTF-16 string.
unsafe fn pwstr(p: *const u16) -> Option<String> {
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

/// Parses a double-NUL-terminated multi-string, dropping load-order-group entries
/// (which Windows prefixes with `+`).
///
/// SAFETY: `p` must be null or point to a valid double-NUL-terminated UTF-16 list.
unsafe fn multi_string(p: *const u16) -> Vec<String> {
    let mut out = Vec::new();
    if p.is_null() {
        return out;
    }
    let mut cur = p;
    loop {
        let mut len = 0;
        while *cur.add(len) != 0 {
            len += 1;
        }
        if len == 0 {
            break;
        }
        let item = String::from_utf16_lossy(std::slice::from_raw_parts(cur, len));
        if !item.starts_with('+') {
            out.push(item);
        }
        cur = cur.add(len + 1);
    }
    out
}

fn open_scm(access: u32) -> Result<ScHandle, ServiceError> {
    // SAFETY: null machine/database names select the local active database.
    let h = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), access) };
    if h.is_null() {
        // SAFETY: immediately after the failing call.
        return Err(map_error(unsafe { GetLastError() }));
    }
    Ok(ScHandle(h))
}

fn open_service(scm: &ScHandle, name: &str, access: u32) -> Result<ScHandle, ServiceError> {
    let name = wide(name);
    // SAFETY: `name` is NUL-terminated and outlives the call.
    let h = unsafe { OpenServiceW(scm.0, name.as_ptr(), access) };
    if h.is_null() {
        // SAFETY: immediately after the failing call.
        return Err(map_error(unsafe { GetLastError() }));
    }
    Ok(ScHandle(h))
}

pub fn state_name(state: u32) -> &'static str {
    match state {
        1 => "Stopped",
        2 => "Starting",
        3 => "Stopping",
        4 => "Running",
        5 => "Continuing",
        6 => "Pausing",
        7 => "Paused",
        _ => "Unknown",
    }
}

pub fn start_type_name(start: u32) -> &'static str {
    match start {
        0 => "Boot",
        1 => "System",
        2 => "Automatic",
        3 => "Manual",
        4 => "Disabled",
        _ => "Unknown",
    }
}

pub fn is_protected(name: &str) -> bool {
    PROTECTED.contains(&name.to_lowercase().as_str())
}

/// Per-service configuration read through an opened service handle.
struct Config {
    start_type: String,
    path: Option<String>,
    account: Option<String>,
    dependencies: Vec<String>,
    description: Option<String>,
}

fn read_config(svc: &ScHandle) -> Option<Config> {
    let mut needed = 0u32;
    // SAFETY: size probe with a null buffer.
    unsafe { QueryServiceConfigW(svc.0, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let cfg = buf.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW;
    // SAFETY: buffer is 8-byte aligned and at least `needed` bytes.
    if unsafe { QueryServiceConfigW(svc.0, cfg, (buf.len() * 8) as u32, &mut needed) } == 0 {
        return None;
    }
    // SAFETY: the call succeeded so `cfg` and its string pointers (into `buf`) are valid.
    let (start, path, account, deps) = unsafe {
        let c = &*cfg;
        (
            c.dwStartType,
            pwstr(c.lpBinaryPathName),
            pwstr(c.lpServiceStartName),
            multi_string(c.lpDependencies),
        )
    };

    let mut dneeded = 0u32;
    // SAFETY: size probe.
    unsafe {
        QueryServiceConfig2W(
            svc.0,
            SERVICE_CONFIG_DESCRIPTION,
            std::ptr::null_mut(),
            0,
            &mut dneeded,
        )
    };
    let description = if dneeded > 0 {
        let mut dbuf = vec![0u64; (dneeded as usize).div_ceil(8)];
        // SAFETY: aligned buffer of the requested size; pointer read only after success.
        let ok = unsafe {
            QueryServiceConfig2W(
                svc.0,
                SERVICE_CONFIG_DESCRIPTION,
                dbuf.as_mut_ptr() as *mut u8,
                (dbuf.len() * 8) as u32,
                &mut dneeded,
            )
        };
        if ok != 0 {
            // SAFETY: success means the buffer holds a SERVICE_DESCRIPTIONW.
            unsafe { pwstr((*(dbuf.as_ptr() as *const SERVICE_DESCRIPTIONW)).lpDescription) }
        } else {
            None
        }
    } else {
        None
    };

    Some(Config {
        start_type: start_type_name(start).to_string(),
        path,
        account,
        dependencies: deps,
        description,
    })
}

/// Lists all Win32 services (not kernel drivers) with state and configuration.
pub fn list() -> Result<Vec<ServiceInfo>, ServiceError> {
    let scm = open_scm(SC_MANAGER_ENUMERATE_SERVICE | SC_MANAGER_CONNECT)?;
    let mut size = 64 * 1024u32;
    let (buf, count) = loop {
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let (mut needed, mut count, mut resume) = (0u32, 0u32, 0u32);
        // SAFETY: aligned buffer of `size` bytes; out-params are live locals.
        let ok = unsafe {
            EnumServicesStatusExW(
                scm.0,
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_STATE_ALL,
                buf.as_mut_ptr() as *mut u8,
                (buf.len() * 8) as u32,
                &mut needed,
                &mut count,
                &mut resume,
                std::ptr::null(),
            )
        };
        if ok != 0 {
            break (buf, count);
        }
        // SAFETY: immediately after the failing call.
        let err = unsafe { GetLastError() };
        if err == ERROR_MORE_DATA || err == ERROR_INSUFFICIENT_BUFFER {
            size = needed.max(size) + 4096;
            continue;
        }
        return Err(map_error(err));
    };

    let entries = buf.as_ptr() as *const ENUM_SERVICE_STATUS_PROCESSW;
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        // SAFETY: Windows wrote `count` entries at the start of the buffer.
        let (name, display, status) = unsafe {
            let e = &*entries.add(i);
            (
                pwstr(e.lpServiceName),
                pwstr(e.lpDisplayName),
                e.ServiceStatusProcess,
            )
        };
        let Some(name) = name else { continue };
        let cfg = open_service(&scm, &name, SERVICE_QUERY_CONFIG)
            .ok()
            .and_then(|svc| read_config(&svc));
        out.push(ServiceInfo {
            display_name: display.unwrap_or_else(|| name.clone()),
            description: cfg.as_ref().and_then(|c| c.description.clone()),
            state: state_name(status.dwCurrentState).to_string(),
            start_type: cfg
                .as_ref()
                .map_or("Unknown".into(), |c| c.start_type.clone()),
            pid: (status.dwProcessId != 0).then_some(status.dwProcessId),
            path: cfg.as_ref().and_then(|c| c.path.clone()),
            account: cfg.as_ref().and_then(|c| c.account.clone()),
            dependencies: cfg.map(|c| c.dependencies).unwrap_or_default(),
            can_stop: status.dwControlsAccepted & SERVICE_ACCEPT_STOP != 0
                && status.dwCurrentState == 4,
            protected: is_protected(&name),
            name,
        });
    }
    out.sort_by_key(|s| s.display_name.to_lowercase());
    Ok(out)
}

fn current_state(svc: &ScHandle) -> Result<u32, ServiceError> {
    let mut status = SERVICE_STATUS_PROCESS {
        dwServiceType: 0,
        dwCurrentState: 0,
        dwControlsAccepted: 0,
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: 0,
        dwProcessId: 0,
        dwServiceFlags: 0,
    };
    let mut needed = 0u32;
    // SAFETY: `status` is a live SERVICE_STATUS_PROCESS of the declared size.
    let ok = unsafe {
        QueryServiceStatusEx(
            svc.0,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut _ as *mut u8,
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        // SAFETY: immediately after the failing call.
        return Err(map_error(unsafe { GetLastError() }));
    }
    Ok(status.dwCurrentState)
}

fn wait_for_state(svc: &ScHandle, want: u32, within: Duration) -> Result<(), ServiceError> {
    let start = Instant::now();
    while start.elapsed() < within {
        if current_state(svc)? == want {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(ServiceError::Timeout)
}

fn validate_name(name: &str) -> Result<(), ServiceError> {
    // Service names are at most 256 chars and cannot contain slashes.
    if name.is_empty() || name.len() > 256 || name.contains(['/', '\\', '\0']) {
        return Err(ServiceError::InvalidName);
    }
    Ok(())
}

/// Pure policy check so it can be unit tested without touching real services.
pub fn check_action(name: &str, action: ServiceAction) -> Result<(), ServiceError> {
    validate_name(name)?;
    if matches!(action, ServiceAction::Stop | ServiceAction::Restart) && is_protected(name) {
        return Err(ServiceError::Protected(name.to_string()));
    }
    Ok(())
}

fn start_service(svc: &ScHandle) -> Result<(), ServiceError> {
    // SAFETY: no arguments are passed.
    if unsafe { StartServiceW(svc.0, 0, std::ptr::null()) } == 0 {
        // SAFETY: immediately after the failing call.
        let err = unsafe { GetLastError() };
        if err == ERROR_SERVICE_ALREADY_RUNNING {
            return Ok(());
        }
        return Err(map_error(err));
    }
    Ok(())
}

fn stop_service(svc: &ScHandle) -> Result<(), ServiceError> {
    let mut status = SERVICE_STATUS {
        dwServiceType: 0,
        dwCurrentState: 0,
        dwControlsAccepted: 0,
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: 0,
    };
    // SAFETY: `status` is a live SERVICE_STATUS.
    if unsafe { ControlService(svc.0, SERVICE_CONTROL_STOP, &mut status) } == 0 {
        // SAFETY: immediately after the failing call.
        let err = unsafe { GetLastError() };
        if err == ERROR_SERVICE_NOT_ACTIVE {
            return Ok(());
        }
        return Err(map_error(err));
    }
    Ok(())
}

pub fn control(name: &str, action: ServiceAction) -> Result<(), ServiceError> {
    check_action(name, action)?;
    let scm = open_scm(SC_MANAGER_CONNECT)?;
    let access = SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP;
    let svc = open_service(&scm, name, access)?;
    match action {
        ServiceAction::Start => {
            start_service(&svc)?;
            wait_for_state(&svc, 4, Duration::from_secs(30))
        }
        ServiceAction::Stop => {
            stop_service(&svc)?;
            wait_for_state(&svc, 1, Duration::from_secs(30))
        }
        ServiceAction::Restart => {
            stop_service(&svc)?;
            wait_for_state(&svc, 1, Duration::from_secs(30))?;
            start_service(&svc)?;
            wait_for_state(&svc, 4, Duration::from_secs(30))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_real_services_with_configuration() {
        let services = list().expect("enumerate services");
        assert!(services.len() > 50, "found only {}", services.len());
        let rpc = services
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case("RpcSs"))
            .expect("RpcSs always exists");
        assert_eq!(rpc.state, "Running");
        assert!(rpc.protected);
        assert!(rpc.pid.is_some());
        assert!(
            services.iter().any(|s| s.description.is_some()),
            "descriptions should resolve for at least one service"
        );
        assert!(
            services.iter().any(|s| !s.dependencies.is_empty()),
            "at least one service has dependencies"
        );
        assert!(services.iter().any(|s| s.start_type == "Automatic"));
        assert!(services.iter().any(|s| s.state == "Stopped"));
    }

    #[test]
    fn policy_refuses_stopping_protected_services() {
        assert_eq!(
            check_action("RpcSs", ServiceAction::Stop),
            Err(ServiceError::Protected("RpcSs".into()))
        );
        assert!(check_action("WinDefend", ServiceAction::Restart).is_err());
        assert!(check_action("Spooler", ServiceAction::Stop).is_ok());
        assert!(check_action("RpcSs", ServiceAction::Start).is_ok());
        assert_eq!(
            check_action("", ServiceAction::Start),
            Err(ServiceError::InvalidName)
        );
        assert_eq!(
            check_action("a\\b", ServiceAction::Start),
            Err(ServiceError::InvalidName)
        );
    }

    #[test]
    fn missing_service_reports_not_found() {
        assert_eq!(
            control("TaskLensNoSuchService", ServiceAction::Start),
            Err(ServiceError::NotFound)
        );
    }

    #[test]
    fn multi_string_parsing_skips_groups() {
        let raw: Vec<u16> = "RPCSS\0+NetworkProvider\0Tcpip\0\0"
            .encode_utf16()
            .collect();
        // SAFETY: `raw` is a valid double-NUL-terminated list.
        let items = unsafe { multi_string(raw.as_ptr()) };
        assert_eq!(items, vec!["RPCSS", "Tcpip"]);
    }
}
