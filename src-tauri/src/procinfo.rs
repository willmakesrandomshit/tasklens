//! Per-process details and controls built on documented Win32 APIs.
//!
//! Cheap properties (handles, priority, memory counters, I/O counters, session, CPU time) are read for
//! every process on each snapshot through ONE short-lived handle. Expensive or sensitive data (threads,
//! modules, file signature, command line) is fetched only on demand for the process the user inspects.
//! Every state-changing action re-validates the process identity on the handle it acts on.

use crate::identity::{self, open_verified, OwnedHandle, TerminateError};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::mem::{size_of, zeroed};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::{GetTokenInformation, LookupAccountSidW, TOKEN_QUERY};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::ProcessStatus::{
    EnumProcessModulesEx, GetModuleFileNameExW, GetProcessMemoryInfo, LIST_MODULES_ALL,
    PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{
    GetPriorityClass, GetProcessAffinityMask, GetProcessHandleCount, GetProcessIoCounters,
    GetProcessTimes, GetThreadTimes, IsWow64Process2, OpenProcessToken, OpenThread, ResumeThread,
    SetPriorityClass, SetProcessAffinityMask, SuspendThread, IO_COUNTERS,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    PROCESS_VM_READ, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// Properties read for every process on every snapshot.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Extra {
    pub handle_count: Option<u32>,
    pub priority: Option<&'static str>,
    pub session_id: Option<u32>,
    pub architecture: Option<&'static str>,
    /// Private bytes (memory that cannot be shared); this is commit charge, not working set.
    pub private_bytes: Option<u64>,
    pub peak_working_set: Option<u64>,
    /// Total bytes read/written by the process across ALL I/O (files, pipes, devices) - not
    /// necessarily physical disk traffic.
    pub io_read_bytes: Option<u64>,
    pub io_write_bytes: Option<u64>,
    pub cpu_time_ms: Option<u64>,
}

fn filetime_u64(ft: FILETIME) -> u64 {
    (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
}

pub fn priority_name(class: u32) -> Option<&'static str> {
    Some(match class {
        0x40 => "Idle",
        0x4000 => "Below normal",
        0x20 => "Normal",
        0x8000 => "Above normal",
        0x80 => "High",
        0x100 => "Realtime",
        _ => return None,
    })
}

fn machine_name(machine: u16) -> Option<&'static str> {
    Some(match machine {
        0x014c => "x86",
        0x8664 => "x64",
        0xAA64 => "ARM64",
        0x01c4 => "ARM",
        _ => return None,
    })
}

/// Reads the cheap per-process properties through a handle the caller already opened.
pub fn read_extra(h: &OwnedHandle) -> Extra {
    let mut e = Extra::default();
    let mut handles = 0u32;
    // SAFETY (all calls below): `h` is a live process handle with query rights and every out-pointer
    // refers to a live stack local of the documented type.
    if unsafe { GetProcessHandleCount(h.raw(), &mut handles) } != 0 {
        e.handle_count = Some(handles);
    }
    e.priority = priority_name(unsafe { GetPriorityClass(h.raw()) });

    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { zeroed() };
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    if unsafe {
        GetProcessMemoryInfo(
            h.raw(),
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            counters.cb,
        )
    } != 0
    {
        e.private_bytes = Some(counters.PrivateUsage as u64);
        e.peak_working_set = Some(counters.PeakWorkingSetSize as u64);
    }

    let mut io: IO_COUNTERS = unsafe { zeroed() };
    if unsafe { GetProcessIoCounters(h.raw(), &mut io) } != 0 {
        e.io_read_bytes = Some(io.ReadTransferCount);
        e.io_write_bytes = Some(io.WriteTransferCount);
    }

    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut c, mut x, mut k, mut u) = (zero, zero, zero, zero);
    if unsafe { GetProcessTimes(h.raw(), &mut c, &mut x, &mut k, &mut u) } != 0 {
        // FILETIME units are 100 ns.
        e.cpu_time_ms = Some((filetime_u64(k) + filetime_u64(u)) / 10_000);
    }

    let mut session = 0u32;
    if unsafe { ProcessIdToSessionId(pid_of(h), &mut session) } != 0 {
        e.session_id = Some(session);
    }

    let (mut machine, mut native) = (0u16, 0u16);
    if unsafe { IsWow64Process2(h.raw(), &mut machine, &mut native) } != 0 {
        // IMAGE_FILE_MACHINE_UNKNOWN (0) means "not WOW64": the process matches the native machine.
        e.architecture = machine_name(if machine == 0 { native } else { machine });
    }
    e
}

fn pid_of(h: &OwnedHandle) -> u32 {
    // SAFETY: handle is a live process handle.
    unsafe { windows_sys::Win32::System::Threading::GetProcessId(h.raw()) }
}

/// Resolves the account that owns a process, e.g. `DESKTOP\owner`; `None` if the token is not readable.
pub fn user_of(h: &OwnedHandle) -> Option<String> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` receives a new handle on success, closed below.
    if unsafe { OpenProcessToken(h.raw(), TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let result = (|| {
        let mut needed = 0u32;
        // SAFETY: size probe (TokenUser = 1).
        unsafe { GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut needed) };
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        // SAFETY: aligned buffer of at least `needed` bytes.
        if unsafe { GetTokenInformation(token, 1, buf.as_mut_ptr() as *mut _, needed, &mut needed) }
            == 0
        {
            return None;
        }
        // TOKEN_USER begins with a SID_AND_ATTRIBUTES whose first field is the SID pointer.
        let sid = unsafe { *(buf.as_ptr() as *const *mut core::ffi::c_void) };
        let (mut nlen, mut dlen, mut kind) = (256u32, 256u32, 0i32);
        let (mut name, mut domain) = (vec![0u16; 256], vec![0u16; 256]);
        // SAFETY: buffers sized as declared; `sid` points into `buf`, which is still alive.
        let ok = unsafe {
            LookupAccountSidW(
                std::ptr::null(),
                sid,
                name.as_mut_ptr(),
                &mut nlen,
                domain.as_mut_ptr(),
                &mut dlen,
                &mut kind,
            )
        };
        (ok != 0).then(|| {
            let n = String::from_utf16_lossy(&name[..nlen as usize]);
            let d = String::from_utf16_lossy(&domain[..dlen as usize]);
            if d.is_empty() {
                n
            } else {
                format!("{d}\\{n}")
            }
        })
    })();
    // SAFETY: closes the token handle opened above.
    unsafe { CloseHandle(token) };
    result
}

/// One Toolhelp snapshot of all processes: PID -> (thread count, parent PID).
pub fn process_table() -> HashMap<u32, (u32, u32)> {
    let mut out = HashMap::new();
    // SAFETY: standard Toolhelp enumeration; the snapshot handle is closed before returning.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            out.insert(
                entry.th32ProcessID,
                (entry.cntThreads, entry.th32ParentProcessID),
            );
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    out
}

#[derive(Serialize, Debug, Clone)]
pub struct ThreadInfo {
    pub tid: u32,
    pub base_priority: i32,
    pub cpu_time_ms: Option<u64>,
}

fn thread_ids(pid: u32) -> Vec<(u32, i32)> {
    let mut out = Vec::new();
    // SAFETY: standard Toolhelp thread enumeration; snapshot closed before returning.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut entry: THREADENTRY32 = zeroed();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut ok = Thread32First(snap, &mut entry);
        while ok != 0 {
            if entry.th32OwnerProcessID == pid {
                out.push((entry.th32ThreadID, entry.tpBasePri));
            }
            ok = Thread32Next(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    out
}

pub fn threads(pid: u32, identity: &str) -> Result<Vec<ThreadInfo>, TerminateError> {
    let _guard = open_verified(pid, identity, PROCESS_QUERY_LIMITED_INFORMATION)?;
    Ok(thread_ids(pid)
        .into_iter()
        .map(|(tid, base_priority)| {
            let mut cpu = None;
            // SAFETY: OpenThread returns null on failure; the handle is closed after use.
            let th = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, tid) };
            if !th.is_null() {
                let zero = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let (mut c, mut x, mut k, mut u) = (zero, zero, zero, zero);
                if unsafe { GetThreadTimes(th, &mut c, &mut x, &mut k, &mut u) } != 0 {
                    cpu = Some((filetime_u64(k) + filetime_u64(u)) / 10_000);
                }
                unsafe { CloseHandle(th) };
            }
            ThreadInfo {
                tid,
                base_priority,
                cpu_time_ms: cpu,
            }
        })
        .collect())
}

#[derive(Serialize, Debug, Clone)]
pub struct ModuleInfo {
    pub name: String,
    pub path: String,
}

pub fn modules(pid: u32, identity: &str) -> Result<Vec<ModuleInfo>, TerminateError> {
    let h = open_verified(pid, identity, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)?;
    let mut mods = vec![std::ptr::null_mut(); 1024];
    let mut needed = 0u32;
    // SAFETY: buffer holds 1024 HMODULEs; `needed` receives the byte size required.
    let ok = unsafe {
        EnumProcessModulesEx(
            h.raw(),
            mods.as_mut_ptr(),
            (mods.len() * size_of::<HANDLE>()) as u32,
            &mut needed,
            LIST_MODULES_ALL,
        )
    };
    if ok == 0 {
        return Err(TerminateError::AccessDenied);
    }
    let count = (needed as usize / size_of::<HANDLE>()).min(mods.len());
    Ok(mods[..count]
        .iter()
        .filter_map(|&m| {
            let mut buf = vec![0u16; 1024];
            // SAFETY: `buf` is valid for 1024 u16s.
            let n = unsafe { GetModuleFileNameExW(h.raw(), m, buf.as_mut_ptr(), 1024) } as usize;
            (n > 0).then(|| {
                let path = String::from_utf16_lossy(&buf[..n]);
                let name = path.rsplit('\\').next().unwrap_or(&path).to_string();
                ModuleInfo { name, path }
            })
        })
        .collect())
}

/// Priority classes users may select. REALTIME is deliberately excluded: it can starve the system.
pub fn priority_class(name: &str) -> Option<u32> {
    Some(match name {
        "idle" => 0x40,
        "below_normal" => 0x4000,
        "normal" => 0x20,
        "above_normal" => 0x8000,
        "high" => 0x80,
        _ => return None,
    })
}

pub fn set_priority(pid: u32, identity: &str, name: &str) -> Result<(), String> {
    let class = priority_class(name).ok_or_else(|| "Unsupported priority.".to_string())?;
    let h = open_verified(
        pid,
        identity,
        PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
    )
    .map_err(|e| e.to_string())?;
    guard(&h, pid).map_err(|e| e.to_string())?;
    // SAFETY: `h` was opened with PROCESS_SET_INFORMATION.
    if unsafe { SetPriorityClass(h.raw(), class) } == 0 {
        return Err("Windows refused to change the priority (access denied).".into());
    }
    Ok(())
}

pub fn affinity(pid: u32, identity: &str) -> Result<(u64, u64), String> {
    let h = open_verified(pid, identity, PROCESS_QUERY_LIMITED_INFORMATION)
        .map_err(|e| e.to_string())?;
    let (mut process, mut system) = (0usize, 0usize);
    // SAFETY: out-pointers are live locals.
    if unsafe { GetProcessAffinityMask(h.raw(), &mut process, &mut system) } == 0 {
        return Err("Could not read the affinity mask.".into());
    }
    Ok((process as u64, system as u64))
}

pub fn set_affinity(pid: u32, identity: &str, mask: u64) -> Result<(), String> {
    let h = open_verified(
        pid,
        identity,
        PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
    )
    .map_err(|e| e.to_string())?;
    guard(&h, pid).map_err(|e| e.to_string())?;
    let (mut process, mut system) = (0usize, 0usize);
    // SAFETY: out-pointers are live locals.
    if unsafe { GetProcessAffinityMask(h.raw(), &mut process, &mut system) } == 0 {
        return Err("Could not read the affinity mask.".into());
    }
    if mask == 0 || (mask as usize) & !system != 0 {
        return Err(
            "The affinity mask must select at least one existing logical processor.".into(),
        );
    }
    // SAFETY: `h` was opened with PROCESS_SET_INFORMATION.
    if unsafe { SetProcessAffinityMask(h.raw(), mask as usize) } == 0 {
        return Err("Windows refused to change the affinity (access denied).".into());
    }
    Ok(())
}

/// Applies the same self/critical/core-process policy used for termination to other disruptive actions.
fn guard(h: &OwnedHandle, pid: u32) -> Result<(), TerminateError> {
    identity::check_policy_for_handle(h, pid)
}

static SUSPENDED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn is_suspended(pid: u32, identity: &str) -> bool {
    SUSPENDED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.contains(&format!("{pid}:{identity}"))))
        .unwrap_or(false)
}

fn mark_suspended(pid: u32, identity: &str, on: bool) {
    if let Ok(mut g) = SUSPENDED.lock() {
        let set = g.get_or_insert_with(HashSet::new);
        let key = format!("{pid}:{identity}");
        if on {
            set.insert(key);
        } else {
            set.remove(&key);
        }
    }
}

/// Suspends or resumes every thread of the verified process. Holding the process handle for the whole
/// operation keeps the PID reserved, so a recycled PID cannot be hit mid-way.
pub fn set_suspended(pid: u32, identity: &str, suspend: bool) -> Result<u32, String> {
    let h = open_verified(pid, identity, PROCESS_QUERY_LIMITED_INFORMATION)
        .map_err(|e| e.to_string())?;
    guard(&h, pid).map_err(|e| e.to_string())?;
    let mut changed = 0;
    for (tid, _) in thread_ids(pid) {
        // SAFETY: OpenThread returns null on failure; the handle is closed after use.
        let th = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, tid) };
        if th.is_null() {
            continue;
        }
        // SAFETY: `th` has THREAD_SUSPEND_RESUME access.
        let prev = unsafe {
            if suspend {
                SuspendThread(th)
            } else {
                ResumeThread(th)
            }
        };
        if prev != u32::MAX {
            changed += 1;
        }
        unsafe { CloseHandle(th) };
    }
    if changed == 0 {
        return Err(
            "No threads could be changed (access denied or the process is protected).".into(),
        );
    }
    mark_suspended(pid, identity, suspend);
    Ok(changed)
}

#[derive(Serialize, Debug, Clone)]
pub struct TreeResult {
    pub ended: u32,
    pub failed: Vec<String>,
}

/// Direct and indirect children of `root`, deepest first, each paired with the identity captured now.
/// A child counts only if its parent existed when the child started (creation time order), so a
/// recycled parent PID never pulls unrelated processes into the tree.
pub fn descendants(root: u32) -> Vec<(u32, String)> {
    let table = process_table();
    let ids: HashMap<u32, Option<u64>> = table
        .keys()
        .map(|&pid| (pid, identity::identity_of(pid).and_then(|s| s.parse().ok())))
        .collect();
    let mut order: Vec<(u32, usize)> = vec![(root, 0)];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut i = 0;
    while i < order.len() {
        let (parent, depth) = order[i];
        i += 1;
        for (&pid, &(_, ppid)) in &table {
            if ppid == parent && pid != parent && !seen.contains(&pid) {
                let valid = match (
                    ids.get(&parent).copied().flatten(),
                    ids.get(&pid).copied().flatten(),
                ) {
                    (Some(pc), Some(cc)) => pc <= cc,
                    _ => false,
                };
                if valid {
                    seen.insert(pid);
                    order.push((pid, depth + 1));
                }
            }
        }
    }
    order.sort_by_key(|&(_, depth)| std::cmp::Reverse(depth));
    order
        .into_iter()
        .filter(|&(pid, _)| pid != root)
        .filter_map(|(pid, _)| {
            ids.get(&pid)
                .copied()
                .flatten()
                .map(|t| (pid, t.to_string()))
        })
        .collect()
}

pub fn terminate_tree(root: u32, root_identity: &str) -> Result<TreeResult, String> {
    // Verify the root first so a stale selection ends nothing at all.
    {
        let _h = open_verified(root, root_identity, PROCESS_QUERY_LIMITED_INFORMATION)
            .map_err(|e| e.to_string())?;
    }
    let kids = descendants(root);
    let mut result = TreeResult {
        ended: 0,
        failed: Vec::new(),
    };
    for (pid, identity) in kids {
        match identity::terminate(pid, &identity) {
            Ok(()) => result.ended += 1,
            Err(TerminateError::NotFound) => {} // exited on its own in the meantime
            Err(e) => result.failed.push(format!("PID {pid}: {e}")),
        }
    }
    match identity::terminate(root, root_identity) {
        Ok(()) => result.ended += 1,
        Err(TerminateError::NotFound) => {}
        Err(e) => result.failed.push(format!("PID {root}: {e}")),
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    fn dummy() -> Child {
        Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    fn alive(c: &mut Child) -> bool {
        c.try_wait().unwrap().is_none()
    }

    #[test]
    fn reads_extra_for_this_process() {
        let me = std::process::id();
        let h = open_verified(
            me,
            &identity::identity_of(me).unwrap(),
            PROCESS_QUERY_LIMITED_INFORMATION,
        )
        .unwrap();
        let e = read_extra(&h);
        assert!(e.handle_count.unwrap() > 0);
        assert!(e.priority.is_some(), "priority class must be readable");
        assert!(e.private_bytes.unwrap() > 1024 * 1024);
        assert!(e.session_id.is_some());
        assert_eq!(
            e.architecture,
            Some(if cfg!(target_arch = "x86_64") {
                "x64"
            } else {
                "ARM64"
            })
        );
        assert!(user_of(&h).is_some_and(|u| u.contains('\\')));
    }

    #[test]
    fn process_table_has_threads_and_parent() {
        let t = process_table();
        let (threads, parent) = t[&std::process::id()];
        assert!(threads >= 1);
        assert!(parent > 0);
    }

    #[test]
    fn suspend_and_resume_a_child() {
        let mut c = dummy();
        let id = identity::identity_of(c.id()).unwrap();
        assert!(set_suspended(c.id(), &id, true).unwrap() >= 1);
        assert!(is_suspended(c.id(), &id));
        assert!(set_suspended(c.id(), &id, false).unwrap() >= 1);
        assert!(!is_suspended(c.id(), &id));
        assert!(alive(&mut c));
        let _ = c.kill();
        let _ = c.wait();
    }

    #[test]
    fn priority_change_and_wrong_identity() {
        let mut c = dummy();
        let id = identity::identity_of(c.id()).unwrap();
        set_priority(c.id(), &id, "below_normal").unwrap();
        let h = open_verified(c.id(), &id, PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert_eq!(read_extra(&h).priority, Some("Below normal"));
        let stale = (id.parse::<u64>().unwrap() + 1).to_string();
        assert!(set_priority(c.id(), &stale, "high").is_err());
        assert!(set_priority(c.id(), &id, "realtime").is_err());
        let _ = c.kill();
        let _ = c.wait();
    }

    #[test]
    fn affinity_roundtrip_and_validation() {
        let mut c = dummy();
        let id = identity::identity_of(c.id()).unwrap();
        let (proc_mask, sys_mask) = affinity(c.id(), &id).unwrap();
        assert_ne!(sys_mask, 0);
        set_affinity(c.id(), &id, 1).unwrap();
        assert_eq!(affinity(c.id(), &id).unwrap().0, 1);
        assert!(set_affinity(c.id(), &id, 0).is_err());
        assert!(set_affinity(c.id(), &id, u64::MAX).is_err());
        set_affinity(c.id(), &id, proc_mask).unwrap();
        let _ = c.kill();
        let _ = c.wait();
    }

    #[test]
    fn lists_threads_of_a_child() {
        let mut c = dummy();
        let id = identity::identity_of(c.id()).unwrap();
        assert!(!threads(c.id(), &id).unwrap().is_empty());
        let _ = c.kill();
        let _ = c.wait();
    }

    #[test]
    fn modules_of_this_process_include_the_executable() {
        let me = std::process::id();
        let id = identity::identity_of(me).unwrap();
        let mods = modules(me, &id).unwrap();
        assert!(mods
            .iter()
            .any(|m| m.name.eq_ignore_ascii_case("ntdll.dll")));
    }

    #[test]
    fn terminates_a_whole_tree_but_not_an_unrelated_process() {
        // cmd (root) -> ping (child). A separate unrelated ping must survive.
        let mut root = Command::new("cmd")
            .args(["/c", "ping -n 120 127.0.0.1 >nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut unrelated = dummy();
        std::thread::sleep(Duration::from_millis(800)); // let cmd start its child
        let id = identity::identity_of(root.id()).unwrap();
        let kids = descendants(root.id());
        assert!(!kids.is_empty(), "cmd should have spawned a ping child");
        assert!(kids.iter().all(|(pid, _)| *pid != unrelated.id()));
        let result = terminate_tree(root.id(), &id).unwrap();
        assert!(result.failed.is_empty(), "{:?}", result.failed);
        assert!(result.ended >= 2);
        std::thread::sleep(Duration::from_millis(300));
        assert!(root.try_wait().unwrap().is_some(), "root should be gone");
        assert!(alive(&mut unrelated), "unrelated process must survive");
        let _ = unrelated.kill();
        let _ = unrelated.wait();
    }

    #[test]
    fn tree_termination_refuses_a_stale_root() {
        let mut c = dummy();
        let stale = (identity::identity_of(c.id())
            .unwrap()
            .parse::<u64>()
            .unwrap()
            + 1)
        .to_string();
        assert!(terminate_tree(c.id(), &stale).is_err());
        assert!(alive(&mut c));
        let _ = c.kill();
        let _ = c.wait();
    }
}
