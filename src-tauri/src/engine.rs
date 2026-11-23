//! Background sampling engine.
//!
//! One thread owns the [`Collector`]. It samples at the UI refresh interval while the window is
//! visible, at the (slower) history interval when only recording/alerts/tray need data, and not at all
//! when nothing needs it. The frontend reads the latest cached snapshot, so opening more views never
//! multiplies collection work.

use crate::alerts::{self, AlertEvent, AlertState};
use crate::collector::{self, Collector, Snapshot};
use crate::history::{History, ProcBrief, ProcEvent};
use crate::settings::{self, Settings};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub struct Engine {
    collector: Mutex<Collector>,
    latest: RwLock<Option<Arc<Snapshot>>>,
    settings: RwLock<Settings>,
    settings_path: PathBuf,
    settings_note: Mutex<Option<String>>,
    ui_active: AtomicBool,
    wake: Mutex<()>,
    cv: Condvar,
    history: Mutex<Option<History>>,
    history_path: PathBuf,
    alert_log: Mutex<VecDeque<AlertEvent>>,
}

impl Engine {
    pub fn new(dir: PathBuf) -> Arc<Engine> {
        let settings_path = dir.join("settings.json");
        let (settings, note) = settings::load(&settings_path);
        let history_path = dir.join("history.db");
        let history = settings
            .history
            .enabled
            .then(|| History::open(&history_path).ok())
            .flatten();
        Arc::new(Engine {
            collector: Mutex::new(collector::new_collector()),
            latest: RwLock::new(None),
            settings: RwLock::new(settings),
            settings_path,
            settings_note: Mutex::new(note),
            ui_active: AtomicBool::new(true),
            wake: Mutex::new(()),
            cv: Condvar::new(),
            history: Mutex::new(history),
            history_path,
            alert_log: Mutex::new(VecDeque::new()),
        })
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn take_settings_note(&self) -> Option<String> {
        self.settings_note.lock().ok().and_then(|mut n| n.take())
    }

    pub fn set_ui_active(&self, active: bool) {
        self.ui_active.store(active, Ordering::Relaxed);
        self.cv.notify_all();
    }

    /// Validates, persists and applies new settings; returns the sanitised result.
    pub fn update_settings(&self, mut new: Settings) -> Result<Settings, String> {
        new.validate();
        settings::save(&self.settings_path, &new)?;
        if let Ok(mut h) = self.history.lock() {
            if new.history.enabled && h.is_none() {
                *h = Some(History::open(&self.history_path)?);
            } else if !new.history.enabled {
                *h = None; // pause: stop recording, keep the data
            }
        }
        if let Ok(mut s) = self.settings.write() {
            *s = new.clone();
        }
        self.cv.notify_all();
        Ok(new)
    }

    fn collect_now(&self) -> Arc<Snapshot> {
        let snap = {
            let mut c = self.collector.lock().unwrap_or_else(|e| e.into_inner());
            Arc::new(collector::take_snapshot(&mut c))
        };
        if let Ok(mut l) = self.latest.write() {
            *l = Some(snap.clone());
        }
        snap
    }

    /// The most recent snapshot; samples synchronously only if the engine has not produced one yet.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        if let Some(s) = self.latest.read().ok().and_then(|l| l.clone()) {
            return s;
        }
        self.collect_now()
    }

    pub fn with_history<T>(
        &self,
        f: impl FnOnce(&History) -> Result<T, String>,
    ) -> Result<T, String> {
        // Reading works even while recording is paused.
        let guard = self
            .history
            .lock()
            .map_err(|_| "History is busy".to_string())?;
        match guard.as_ref() {
            Some(h) => f(h),
            None => {
                drop(guard);
                if !self.history_path.exists() {
                    return Err(
                        "No history has been recorded yet. Turn on recording in Settings.".into(),
                    );
                }
                let h = History::open(&self.history_path)?;
                f(&h)
            }
        }
    }

    pub fn clear_history(&self) -> Result<(), String> {
        let mut guard = self
            .history
            .lock()
            .map_err(|_| "History is busy".to_string())?;
        match guard.as_mut() {
            Some(h) => h.clear(),
            None if self.history_path.exists() => History::open(&self.history_path)?.clear(),
            None => Ok(()),
        }
    }

    pub fn alert_log(&self) -> Vec<AlertEvent> {
        self.alert_log
            .lock()
            .map(|l| l.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let engine = self.clone();
        std::thread::Builder::new()
            .name("tasklens-engine".into())
            .spawn(move || engine.run(app))
            .expect("spawn engine thread");
    }

    fn run(&self, app: AppHandle) {
        let mut alert_state = AlertState::default();
        let mut previous: HashMap<String, ProcBrief> = HashMap::new();
        let (mut last_record, mut last_purge) = (0i64, 0i64);
        let mut first = true;
        loop {
            let s = self.settings();
            let ui = self.ui_active.load(Ordering::Relaxed);
            let has_alerts = s.alerts.iter().any(|a| a.enabled);
            let track = s.history.enabled || has_alerts || s.app.tray_enabled;
            if ui || track {
                let snap = self.collect_now();
                let now = snap.to_sample().ts;
                let mut events: Vec<ProcEvent> = Vec::new();
                let mut exited: Vec<String> = Vec::new();
                if track {
                    let current: HashMap<String, ProcBrief> = snap
                        .brief_processes()
                        .into_iter()
                        .map(|p| {
                            (
                                format!("{}:{}", p.pid, p.identity.clone().unwrap_or_default()),
                                p,
                            )
                        })
                        .collect();
                    if !first {
                        for (k, p) in &current {
                            if !previous.contains_key(k) {
                                events.push(ProcEvent {
                                    ts: now,
                                    kind: "start".into(),
                                    pid: p.pid,
                                    name: p.name.clone(),
                                });
                            }
                        }
                        for (k, p) in &previous {
                            if !current.contains_key(k) {
                                events.push(ProcEvent {
                                    ts: now,
                                    kind: "exit".into(),
                                    pid: p.pid,
                                    name: p.name.clone(),
                                });
                                exited.push(p.name.to_lowercase());
                            }
                        }
                    }
                    previous = current;
                    first = false;
                }
                if s.history.enabled && now - last_record >= s.history.interval_s as i64 {
                    last_record = now;
                    let mut tops = snap.brief_processes();
                    tops.sort_by(|a, b| {
                        b.cpu
                            .partial_cmp(&a.cpu)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let mut tops: Vec<ProcBrief> = tops.into_iter().take(3).collect();
                    let mut by_mem = snap.brief_processes();
                    by_mem.sort_by_key(|p| std::cmp::Reverse(p.mem));
                    let extra: Vec<ProcBrief> = by_mem
                        .into_iter()
                        .take(2)
                        .filter(|m| !tops.iter().any(|t| t.pid == m.pid))
                        .collect();
                    tops.extend(extra);
                    if let Ok(mut h) = self.history.lock() {
                        if let Some(h) = h.as_mut() {
                            let _ = h.record(&snap.to_sample(), &tops, &events);
                            if now - last_purge >= 3600 {
                                last_purge = now;
                                let _ = h.purge(
                                    now,
                                    s.history.retention_days,
                                    s.history.max_mb * 1024 * 1024,
                                );
                            }
                        }
                    }
                }
                if has_alerts {
                    for event in alerts::evaluate(
                        &s.alerts,
                        &mut alert_state,
                        &snap.alert_metrics(exited),
                        now,
                    ) {
                        if let Ok(mut log) = self.alert_log.lock() {
                            log.push_back(event.clone());
                            while log.len() > 200 {
                                log.pop_front();
                            }
                        }
                        if s.app.notify_in_app {
                            let _ = app.emit("tasklens://alert", &event);
                        }
                    }
                }
                if s.app.tray_enabled {
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_tooltip(Some(snap.tray_text()));
                    }
                }
            }
            let wait = if ui {
                s.refresh_ms
            } else if track {
                (s.history.interval_s * 1000).max(1000)
            } else {
                30_000
            };
            if let Ok(guard) = self.wake.lock() {
                let _ = self.cv.wait_timeout(guard, Duration::from_millis(wait));
            }
        }
    }
}

/// Convenience for commands: the engine stored in Tauri state.
pub fn from(app: &AppHandle) -> Arc<Engine> {
    app.state::<Arc<Engine>>().inner().clone()
}
