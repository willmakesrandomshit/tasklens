//! Handle-bound process identity.
//!
//! A PID alone is not an identity: Windows reuses PIDs, so a PID picked in the UI
//! may refer to a different process by the time an action runs. We therefore
//! identify a process by `(pid, creation time)`, where the creation time is a
//! 64-bit FILETIME. Destructive actions open ONE handle, read the creation time
//! from that same handle, compare it with what the user selected, and then act on
//! that handle. A handle keeps referring to the same process object even if the
//! PID is later recycled, so there is no window between "check" and "act".

use std::fmt;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes, IsProcessCritical, OpenProcess,
    QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

/// Image names that must never be terminated even if `IsProcessCritical`
/// cannot be queried. Terminating these can crash or lock the machine.
const PROTECTED_IMAGES: &[&str] = &[
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "lsm.exe",
    "memory compression",
];

#[derive(Debug, PartialEq, Eq)]
pub enum TerminateError {
    InvalidIdentity,
    NotFound,
    AccessDenied,
    IdentityMismatch,
    SelfProcess,
    Protected(String),
    Os(u32),
}

impl fmt::Display for TerminateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentity => write!(f, "The process identity token is invalid."),
            Self::NotFound => write!(f, "The process has already exited."),
            Self::AccessDenied => write!(
                f,
                "Windows denied access to this process. It may be protected or run with higher privileges."
            ),
            Self::IdentityMismatch => write!(
                f,
                "The process with this PID is no longer the one you selected (the PID was reused). Nothing was ended."
            ),
            Self::SelfProcess => write!(f, "TaskLens will not end itself."),
            Self::Protected(why) => write!(f, "Refused: {why}."),
            Self::Os(code) => write!(f, "Windows reported error {code}."),
        }
    }
}

/// Owned process handle, closed on drop.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by OpenProcess and is closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

fn open(pid: u32, access: u32) -> Result<OwnedHandle, TerminateError> {
    // SAFETY: plain FFI call; a null return means failure.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        // SAFETY: reads the calling thread's last error immediately after the failing call.
        let code = unsafe { GetLastError() };
        return Err(match code {
            ERROR_ACCESS_DENIED => TerminateError::AccessDenied,
            ERROR_INVALID_PARAMETER => TerminateError::NotFound,
            other => TerminateError::Os(other),
        });
    }
    Ok(OwnedHandle(handle))
}

fn creation_time_of(handle: &OwnedHandle) -> Option<u64> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: all pointers refer to live stack locals.
    let ok =
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

fn image_path_of(handle: &OwnedHandle) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: buf is valid for `len` u16s; len is updated to the written length.
    let ok = unsafe { QueryFullProcessImageNameW(handle.0, 0, buf.as_mut_ptr(), &mut len) };
    (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

fn is_critical(handle: &OwnedHandle) -> Option<bool> {
    let mut critical = 0;
    // SAFETY: `critical` is a live stack local.
    let ok = unsafe { IsProcessCritical(handle.0, &mut critical) };
    (ok != 0).then_some(critical != 0)
}

fn has_exited(handle: &OwnedHandle) -> bool {
    const STILL_ACTIVE: u32 = 259;
    let mut code = 0u32;
    // SAFETY: `code` is a live stack local.
    let ok = unsafe { GetExitCodeProcess(handle.0, &mut code) };
    ok != 0 && code != STILL_ACTIVE
}

/// Opening for termination was denied. Work out whether that is a genuinely
/// protected process, or just a process that already exited / a recycled PID.
fn classify_denied(pid: u32, expected: u64) -> TerminateError {
    match open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
        Ok(probe) => match creation_time_of(&probe) {
            Some(actual) if actual != expected => TerminateError::IdentityMismatch,
            _ if has_exited(&probe) => TerminateError::NotFound,
            _ => TerminateError::AccessDenied,
        },
        Err(_) => TerminateError::AccessDenied,
    }
}

/// Creation time of a process as an opaque identity token, or `None` when the
/// process cannot be opened (exited, or access denied).
pub fn identity_of(pid: u32) -> Option<String> {
    let handle = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?;
    creation_time_of(&handle).map(|t| t.to_string())
}

fn basename_lower(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

/// Decide whether a process may be terminated. Pure so it can be unit-tested.
pub fn check_policy(
    pid: u32,
    own_pid: u32,
    image: Option<&str>,
    critical: Option<bool>,
) -> Result<(), TerminateError> {
    if pid == own_pid {
        return Err(TerminateError::SelfProcess);
    }
    if pid == 0 || pid == 4 {
        return Err(TerminateError::Protected(
            "system processes cannot be ended".into(),
        ));
    }
    if critical == Some(true) {
        return Err(TerminateError::Protected(
            "Windows marks this process as critical; ending it would crash the system".into(),
        ));
    }
    if let Some(image) = image {
        let name = basename_lower(image);
        if PROTECTED_IMAGES.contains(&name.as_str()) {
            return Err(TerminateError::Protected(format!(
                "{name} is a core Windows process"
            )));
        }
    }
    Ok(())
}

/// Terminate the process `pid` only if its creation time equals `identity`.
/// Identity is verified and the kill is issued on the same handle.
pub fn terminate(pid: u32, identity: &str) -> Result<(), TerminateError> {
    let expected: u64 = identity
        .parse()
        .map_err(|_| TerminateError::InvalidIdentity)?;
    let handle = match open(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION) {
        Ok(handle) => handle,
        Err(TerminateError::AccessDenied) => return Err(classify_denied(pid, expected)),
        Err(other) => return Err(other),
    };
    let actual = creation_time_of(&handle).ok_or(TerminateError::NotFound)?;
    if actual != expected {
        return Err(TerminateError::IdentityMismatch);
    }
    if has_exited(&handle) {
        return Err(TerminateError::NotFound);
    }
    // SAFETY: trivial FFI call with no arguments.
    let own = unsafe { GetCurrentProcessId() };
    check_policy(
        pid,
        own,
        image_path_of(&handle).as_deref(),
        is_critical(&handle),
    )?;
    // SAFETY: handle was opened with PROCESS_TERMINATE and is still owned by us.
    if unsafe { TerminateProcess(handle.0, 1) } == 0 {
        // SAFETY: last-error read immediately after the failing call.
        return Err(match unsafe { GetLastError() } {
            ERROR_ACCESS_DENIED => TerminateError::AccessDenied,
            other => TerminateError::Os(other),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    /// A harmless long-lived child process (pings localhost for ~2 minutes).
    fn spawn_dummy() -> Child {
        Command::new("ping")
            .args(["-n", "120", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping")
    }

    fn wait_exit(child: &mut Child, within: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < within {
            if child.try_wait().expect("try_wait").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn identity_is_stable_and_distinct() {
        let mut a = spawn_dummy();
        let mut b = spawn_dummy();
        let ia = identity_of(a.id()).expect("identity a");
        assert_eq!(identity_of(a.id()).as_deref(), Some(ia.as_str()));
        assert_ne!(Some(ia), identity_of(b.id()));
        let _ = a.kill();
        let _ = b.kill();
        let _ = a.wait();
        let _ = b.wait();
    }

    #[test]
    fn terminates_the_intended_process() {
        let mut child = spawn_dummy();
        let identity = identity_of(child.id()).expect("identity");
        assert_eq!(terminate(child.id(), &identity), Ok(()));
        assert!(
            wait_exit(&mut child, Duration::from_secs(5)),
            "child should exit"
        );
    }

    #[test]
    fn wrong_identity_never_kills() {
        let mut child = spawn_dummy();
        let real: u64 = identity_of(child.id()).unwrap().parse().unwrap();
        // Simulates PID reuse: same PID, but the identity belongs to another process.
        let stale = (real + 1).to_string();
        assert_eq!(
            terminate(child.id(), &stale),
            Err(TerminateError::IdentityMismatch)
        );
        assert!(
            !wait_exit(&mut child, Duration::from_millis(300)),
            "child must still be alive"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn exited_process_is_not_found() {
        let mut child = spawn_dummy();
        let identity = identity_of(child.id()).unwrap();
        let pid = child.id();
        child.kill().unwrap();
        child.wait().unwrap();
        // Dropping Child releases its handle, so the process object (and PID) is gone.
        drop(child);
        let result = terminate(pid, &identity);
        assert!(
            matches!(
                result,
                Err(TerminateError::NotFound) | Err(TerminateError::IdentityMismatch)
            ),
            "got {result:?}"
        );
    }

    #[test]
    fn rejects_garbage_identity_and_self() {
        assert_eq!(
            terminate(4242, "not-a-number"),
            Err(TerminateError::InvalidIdentity)
        );
        let own = std::process::id();
        let identity = identity_of(own).unwrap();
        assert_eq!(terminate(own, &identity), Err(TerminateError::SelfProcess));
    }

    #[test]
    fn policy_blocks_critical_and_core_images() {
        assert!(check_policy(100, 1, Some(r"C:\Windows\System32\csrss.exe"), None).is_err());
        assert!(check_policy(100, 1, Some(r"C:\Windows\System32\LSASS.EXE"), Some(false)).is_err());
        assert!(check_policy(100, 1, Some(r"C:\Tools\app.exe"), Some(true)).is_err());
        assert!(check_policy(4, 1, None, None).is_err());
        assert!(check_policy(0, 1, None, None).is_err());
        assert_eq!(
            check_policy(100, 100, None, None),
            Err(TerminateError::SelfProcess)
        );
        assert_eq!(
            check_policy(100, 1, Some(r"C:\Tools\app.exe"), Some(false)),
            Ok(())
        );
    }
}
