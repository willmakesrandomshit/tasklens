//! Persistent, validated application settings stored as JSON in the app config directory.
//!
//! Writes are atomic (temp file + rename). A file that fails to parse is moved aside to
//! `settings.json.corrupt` and defaults are used, so a damaged file can never stop the app starting.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct AlertRule {
    pub id: String,
    pub name: String,
    /// cpu, memory, gpu, disk_active, disk_free (below), process_cpu, process_exit
    pub metric: String,
    pub threshold: f64,
    pub duration_s: u64,
    pub cooldown_s: u64,
    pub enabled: bool,
    /// Process image name (case-insensitive) for process_* metrics.
    pub process: Option<String>,
}

impl Default for AlertRule {
    fn default() -> Self {
        AlertRule {
            id: String::new(),
            name: String::new(),
            metric: "cpu".into(),
            threshold: 90.0,
            duration_s: 30,
            cooldown_s: 300,
            enabled: true,
            process: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct HistorySettings {
    pub enabled: bool,
    pub interval_s: u64,
    pub retention_days: u64,
    pub max_mb: u64,
}

impl Default for HistorySettings {
    fn default() -> Self {
        HistorySettings {
            enabled: false,
            interval_s: 5,
            retention_days: 7,
            max_mb: 100,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub start_minimized: bool,
    pub always_on_top: bool,
    pub tray_enabled: bool,
    pub minimize_to_tray: bool,
    pub compact: bool,
    pub notify_in_app: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            start_minimized: false,
            always_on_top: false,
            tray_enabled: false,
            minimize_to_tray: false,
            compact: false,
            notify_in_app: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// system | dark | light
    pub theme: String,
    /// `#rrggbb`
    pub accent: String,
    /// compact | comfortable
    pub density: String,
    pub font_scale: f64,
    pub reduced_motion: bool,
    pub refresh_ms: u64,
    pub confirm_destructive: bool,
    pub history: HistorySettings,
    pub app: AppSettings,
    pub alerts: Vec<AlertRule>,
    /// Free-form UI state (column layout, saved filters). Size-limited; never executed.
    pub ui: serde_json::Value,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            accent: "#4f8cff".into(),
            density: "compact".into(),
            font_scale: 1.0,
            reduced_motion: false,
            refresh_ms: 2000,
            confirm_destructive: true,
            history: HistorySettings::default(),
            app: AppSettings::default(),
            alerts: Vec::new(),
            ui: serde_json::Value::Null,
        }
    }
}

const METRICS: &[&str] = &[
    "cpu",
    "memory",
    "gpu",
    "disk_active",
    "disk_free",
    "process_cpu",
    "process_exit",
];

fn valid_accent(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl Settings {
    /// Clamps every value into its supported range and replaces unknown enum values with defaults.
    pub fn validate(&mut self) {
        let d = Settings::default();
        if !["system", "dark", "light"].contains(&self.theme.as_str()) {
            self.theme = d.theme;
        }
        if !valid_accent(&self.accent) {
            self.accent = d.accent;
        }
        if !["compact", "comfortable"].contains(&self.density.as_str()) {
            self.density = d.density;
        }
        self.font_scale = if self.font_scale.is_finite() {
            self.font_scale.clamp(0.85, 1.5)
        } else {
            1.0
        };
        self.refresh_ms = self.refresh_ms.clamp(500, 10_000);
        self.history.interval_s = self.history.interval_s.clamp(1, 300);
        self.history.retention_days = self.history.retention_days.clamp(1, 90);
        self.history.max_mb = self.history.max_mb.clamp(5, 1000);
        self.alerts.truncate(50);
        for (i, a) in self.alerts.iter_mut().enumerate() {
            if a.id.is_empty() || a.id.len() > 64 {
                a.id = format!("rule-{i}");
            }
            a.name.truncate(80);
            if !METRICS.contains(&a.metric.as_str()) {
                a.enabled = false;
                a.metric = "cpu".into();
            }
            a.threshold = if a.threshold.is_finite() {
                a.threshold.clamp(0.0, 100.0)
            } else {
                90.0
            };
            a.duration_s = a.duration_s.min(86_400);
            a.cooldown_s = a.cooldown_s.clamp(10, 86_400);
            if let Some(p) = a.process.as_mut() {
                p.truncate(260);
            }
        }
        // Cap UI blob size so a runaway frontend cannot bloat the file.
        if serde_json::to_string(&self.ui).map_or(true, |s| s.len() > 64 * 1024) {
            self.ui = serde_json::Value::Null;
        }
    }
}

/// Loads settings, falling back to defaults. Returns a note when the file was corrupt.
pub fn load(path: &Path) -> (Settings, Option<String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Settings::default(), None);
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut s) => {
            s.validate();
            (s, None)
        }
        Err(e) => {
            let aside = path.with_extension("json.corrupt");
            let _ = std::fs::rename(path, &aside);
            (
                Settings::default(),
                Some(format!("Settings file was unreadable ({e}); it was kept as {} and defaults were restored.", aside.display())),
            )
        }
    }
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create the settings folder: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("Could not write settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not save settings: {e}"))
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tasklens-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn roundtrips_and_defaults_missing_fields() {
        let p = temp("roundtrip");
        let mut s = Settings::default();
        s.theme = "dark".into();
        s.history.enabled = true;
        save(&p, &s).unwrap();
        let (loaded, note) = load(&p);
        assert!(note.is_none());
        assert_eq!(loaded, s);
        std::fs::write(&p, r#"{"theme":"light"}"#).unwrap();
        let (partial, _) = load(&p);
        assert_eq!(partial.theme, "light");
        assert_eq!(partial.refresh_ms, 2000);
    }

    #[test]
    fn validation_clamps_and_repairs() {
        let mut s = Settings::default();
        s.theme = "neon".into();
        s.accent = "red".into();
        s.font_scale = f64::NAN;
        s.refresh_ms = 5;
        s.history.retention_days = 9999;
        s.alerts.push(AlertRule {
            metric: "bogus".into(),
            threshold: 500.0,
            cooldown_s: 0,
            ..Default::default()
        });
        s.validate();
        assert_eq!(s.theme, "system");
        assert_eq!(s.accent, "#4f8cff");
        assert_eq!(s.font_scale, 1.0);
        assert_eq!(s.refresh_ms, 500);
        assert_eq!(s.history.retention_days, 90);
        assert!(!s.alerts[0].enabled);
        assert_eq!(s.alerts[0].threshold, 100.0);
        assert_eq!(s.alerts[0].cooldown_s, 10);
        assert!(!s.alerts[0].id.is_empty());
    }

    #[test]
    fn corrupt_file_is_kept_aside_and_defaults_used() {
        let p = temp("corrupt");
        std::fs::write(&p, "{ not json").unwrap();
        let (s, note) = load(&p);
        assert_eq!(s, Settings::default());
        assert!(note.unwrap().contains("corrupt"));
        assert!(p.with_extension("json.corrupt").exists());
        assert!(!p.exists());
    }

    #[test]
    fn oversized_ui_blob_is_dropped() {
        let mut s = Settings::default();
        s.ui = serde_json::json!({ "blob": "x".repeat(70_000) });
        s.validate();
        assert!(s.ui.is_null());
    }
}
