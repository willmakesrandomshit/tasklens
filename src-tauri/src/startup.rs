//! Startup application discovery and reversible enable/disable.
//!
//! Supported sources: the `Run` registry keys (HKCU, HKLM, HKLM\WOW6432Node) and the per-user and
//! all-users Startup folders. NOT covered: Run-Once keys, scheduled tasks, services, logon scripts,
//! Winlogon/Userinit hooks and other persistence mechanisms.
//!
//! Enabled/disabled state follows the `StartupApproved` convention used by Windows' own Task Manager:
//! a 12-byte binary value whose first byte is even for enabled and odd for disabled. Changes are
//! written only to the current user's `StartupApproved` key, so no entry is ever deleted and every
//! change is reversible.

use serde::Serialize;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_BINARY};
use winreg::{RegKey, RegValue};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    HkcuRun,
    HklmRun,
    HklmRun32,
    UserFolder,
    CommonFolder,
}

impl Source {
    const ALL: [Source; 5] = [
        Source::HkcuRun,
        Source::HklmRun,
        Source::HklmRun32,
        Source::UserFolder,
        Source::CommonFolder,
    ];
    fn id(self) -> &'static str {
        match self {
            Source::HkcuRun => "hkcu-run",
            Source::HklmRun => "hklm-run",
            Source::HklmRun32 => "hklm-run32",
            Source::UserFolder => "user-folder",
            Source::CommonFolder => "common-folder",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Source::HkcuRun => "Registry: current user (Run)",
            Source::HklmRun => "Registry: all users (Run)",
            Source::HklmRun32 => "Registry: all users, 32-bit (Run)",
            Source::UserFolder => "Startup folder: current user",
            Source::CommonFolder => "Startup folder: all users",
        }
    }
    /// Name of the `StartupApproved` subkey that stores this source's enabled flags.
    fn approval_key(self) -> &'static str {
        match self {
            Source::HkcuRun | Source::HklmRun => "Run",
            Source::HklmRun32 => "Run32",
            Source::UserFolder | Source::CommonFolder => "StartupFolder",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct StartupEntry {
    /// Stable identifier `<source>|<name>`, validated again by the backend on every change.
    pub id: String,
    pub name: String,
    pub command: String,
    pub path: Option<String>,
    pub source: &'static str,
    pub enabled: bool,
    pub scope: &'static str,
}

/// Expands `%VAR%` references (REG_EXPAND_SZ-style) using the process environment.
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => match std::env::var(&after[..end]) {
                Ok(v) if end > 0 => out.push_str(&v),
                _ => {
                    out.push('%');
                    out.push_str(&after[..end]);
                    out.push('%');
                }
            },
            None => {
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
        rest = &after[after.find('%').map_or(after.len(), |e| e + 1)..];
    }
    out.push_str(rest);
    out
}

/// Extracts the executable path from a Run-key command line.
pub fn executable_of(command: &str) -> Option<String> {
    let c = command.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest
            .split('"')
            .next()
            .filter(|p| !p.is_empty())
            .map(expand_env);
    }
    let lower = c.to_lowercase();
    let end = [".exe", ".bat", ".cmd", ".com"]
        .iter()
        .filter_map(|ext| lower.find(ext).map(|i| i + ext.len()))
        .min()
        .or_else(|| c.find(' '))
        .unwrap_or(c.len());
    let p = c[..end].trim();
    (!p.is_empty()).then(|| expand_env(p))
}

/// First byte even => enabled, odd => disabled. Missing/short data means "no override" => enabled.
pub fn approved_enabled(data: &[u8]) -> bool {
    data.first().is_none_or(|b| b & 1 == 0)
}

fn filetime_now() -> u64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    (secs + 11_644_473_600) * 10_000_000
}

pub fn approval_bytes(enabled: bool) -> [u8; 12] {
    let mut b = [0u8; 12];
    if enabled {
        b[0] = 2;
    } else {
        b[0] = 3;
        b[4..].copy_from_slice(&filetime_now().to_le_bytes());
    }
    b
}

fn read_approval(source: Source, name: &str) -> bool {
    // The user's own override wins over the machine-wide one.
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let path = format!(r"{APPROVED}\{}", source.approval_key());
        if let Ok(key) = RegKey::predef(root).open_subkey_with_flags(path, KEY_READ) {
            if let Ok(v) = key.get_raw_value(name) {
                return approved_enabled(&v.bytes);
            }
        }
    }
    true
}

fn registry_entries(
    source: Source,
    root: winreg::HKEY,
    subkey: &str,
    scope: &'static str,
) -> Vec<StartupEntry> {
    let Ok(key) = RegKey::predef(root).open_subkey_with_flags(subkey, KEY_READ) else {
        return Vec::new();
    };
    key.enum_values()
        .filter_map(Result::ok)
        .filter_map(|(name, _)| {
            let command: String = key.get_value(&name).ok()?;
            Some(StartupEntry {
                id: format!("{}|{}", source.id(), name),
                path: executable_of(&command),
                enabled: read_approval(source, &name),
                command,
                name,
                source: source.label(),
                scope,
            })
        })
        .collect()
}

fn folder_for(source: Source) -> Option<PathBuf> {
    let (var, scope_dir) = match source {
        Source::UserFolder => ("APPDATA", r"Microsoft\Windows\Start Menu\Programs\Startup"),
        Source::CommonFolder => (
            "ProgramData",
            r"Microsoft\Windows\Start Menu\Programs\StartUp",
        ),
        _ => return None,
    };
    std::env::var_os(var).map(|b| PathBuf::from(b).join(scope_dir))
}

fn folder_entries(source: Source, scope: &'static str) -> Vec<StartupEntry> {
    let Some(dir) = folder_for(source) else {
        return Vec::new();
    };
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case("desktop.ini") {
                return None;
            }
            let path = e.path().to_string_lossy().into_owned();
            Some(StartupEntry {
                id: format!("{}|{}", source.id(), name),
                enabled: read_approval(source, &name),
                command: path.clone(),
                path: Some(path),
                name,
                source: source.label(),
                scope,
            })
        })
        .collect()
}

pub fn list() -> Vec<StartupEntry> {
    let mut out = Vec::new();
    for source in Source::ALL {
        out.extend(match source {
            Source::HkcuRun => registry_entries(source, HKEY_CURRENT_USER, RUN, "Current user"),
            Source::HklmRun => registry_entries(source, HKEY_LOCAL_MACHINE, RUN, "All users"),
            Source::HklmRun32 => registry_entries(source, HKEY_LOCAL_MACHINE, RUN32, "All users"),
            Source::UserFolder => folder_entries(source, "Current user"),
            Source::CommonFolder => folder_entries(source, "All users"),
        });
    }
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

/// Enables or disables one startup entry for the current user. The entry must exist right now;
/// the registry value name comes from the freshly enumerated list, never from the caller.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let entry = list()
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "That startup entry no longer exists.".to_string())?;
    let source = Source::ALL
        .into_iter()
        .find(|s| id.starts_with(&format!("{}|", s.id())))
        .ok_or_else(|| "Unknown startup source.".to_string())?;
    let path = format!(r"{APPROVED}\{}", source.approval_key());
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(path, KEY_SET_VALUE | KEY_READ)
        .map_err(|e| format!("Could not open the startup approval key: {e}"))?;
    let value = RegValue {
        bytes: approval_bytes(enabled).to_vec().into(),
        vtype: REG_BINARY,
    };
    key.set_raw_value(&entry.name, &value)
        .map_err(|e| format!("Could not update the startup entry: {e}"))
}

const AUTOSTART_NAME: &str = "TaskLens";

pub fn autostart_enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(AUTOSTART_NAME))
        .is_ok()
}

/// Explicit opt-in "start with Windows": one HKCU Run value, removable here or on the Startup page.
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(RUN, KEY_SET_VALUE | KEY_READ)
        .map_err(|e| format!("Could not open the Run key: {e}"))?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value(
            AUTOSTART_NAME,
            &format!("\"{}\" --minimized", exe.display()),
        )
        .map_err(|e| format!("Could not register startup: {e}"))
    } else {
        match key.delete_value(AUTOSTART_NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not remove startup: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_executables_from_commands() {
        assert_eq!(
            executable_of(r#""C:\Program Files\App\app.exe" --silent"#).as_deref(),
            Some(r"C:\Program Files\App\app.exe")
        );
        assert_eq!(
            executable_of(r"C:\Tools\thing.exe /minimized").as_deref(),
            Some(r"C:\Tools\thing.exe")
        );
        assert_eq!(executable_of("   ").as_deref(), None);
        assert_eq!(executable_of(r#""""#).as_deref(), None);
    }

    #[test]
    fn expands_environment_references() {
        std::env::set_var("TASKLENS_TEST_DIR", r"C:\X");
        assert_eq!(expand_env(r"%TASKLENS_TEST_DIR%\a.exe"), r"C:\X\a.exe");
        assert_eq!(expand_env("100%"), "100%");
        assert_eq!(expand_env("%NOPE_NOT_SET_12345%"), "%NOPE_NOT_SET_12345%");
    }

    #[test]
    fn approval_flag_semantics() {
        assert!(approved_enabled(&[2, 0, 0, 0]));
        assert!(approved_enabled(&[6, 0, 0, 0]));
        assert!(!approved_enabled(&[3, 0, 0, 0]));
        assert!(approved_enabled(&[]));
        assert!(approval_bytes(true)[0].is_multiple_of(2));
        let off = approval_bytes(false);
        assert_eq!(off[0], 3);
        assert_ne!(off[4..], [0u8; 8]);
    }

    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            if let Ok(k) = hkcu.open_subkey_with_flags(RUN, KEY_SET_VALUE) {
                let _ = k.delete_value(&self.0);
            }
            if let Ok(k) = hkcu.open_subkey_with_flags(format!(r"{APPROVED}\Run"), KEY_SET_VALUE) {
                let _ = k.delete_value(&self.0);
            }
        }
    }

    #[test]
    fn discovers_toggles_and_restores_a_real_registry_entry() {
        let name = format!("TaskLensTest_{}", std::process::id());
        let _cleanup = Cleanup(name.clone());
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu.create_subkey(RUN).unwrap();
        run.set_value(
            &name,
            &r#""C:\Windows\System32\notepad.exe" /tasklens-test"#,
        )
        .unwrap();

        let id = format!("hkcu-run|{name}");
        let find = || list().into_iter().find(|e| e.id == id);
        let e = find().expect("entry discovered");
        assert!(e.enabled);
        assert_eq!(e.path.as_deref(), Some(r"C:\Windows\System32\notepad.exe"));
        assert_eq!(e.source, "Registry: current user (Run)");

        set_enabled(&id, false).unwrap();
        assert!(!find().unwrap().enabled, "should be disabled");
        // The Run value itself must be untouched (reversible, nothing deleted).
        assert!(run.get_value::<String, _>(&name).is_ok());

        set_enabled(&id, true).unwrap();
        assert!(find().unwrap().enabled, "should be re-enabled");
    }

    #[test]
    fn refuses_unknown_entries() {
        assert!(set_enabled("hkcu-run|definitely-not-an-entry-xyz", false).is_err());
        assert!(set_enabled("../../evil|x", false).is_err());
    }
}
