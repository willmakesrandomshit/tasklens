#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alerts;
mod collector;
mod connections;
mod engine;
mod gpu;
mod history;
mod identity;
mod netinfo;
mod pdh;
mod perf;
mod procinfo;
mod services;
mod settings;
mod startup;
mod system;

use engine::Engine;
use settings::Settings;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent};

// Commands are `async` so Tauri runs them on its thread pool instead of the UI thread;
// enumerating services or processes can take tens of milliseconds and must not freeze the window.

type Eng<'a> = State<'a, Arc<Engine>>;

#[tauri::command(async)]
fn snapshot(engine: Eng<'_>) -> Arc<collector::Snapshot> {
    engine.snapshot()
}

#[tauri::command(async)]
fn set_ui_active(engine: Eng<'_>, active: bool) {
    engine.set_ui_active(active);
}

/// Ends one process. `identity` is the creation-time token from the snapshot; it
/// is verified against the live process on the same handle that is terminated,
/// so a recycled PID can never cause the wrong process to be ended.
#[tauri::command(async)]
fn terminate_process(pid: u32, identity: Option<String>) -> Result<(), String> {
    let identity = identity.ok_or_else(|| {
        "This process's identity could not be read, so it cannot be ended safely.".to_string()
    })?;
    identity::terminate(pid, &identity).map_err(|e| e.to_string())
}

fn verified<T>(r: Result<T, identity::TerminateError>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn process_threads(pid: u32, identity: String) -> Result<Vec<procinfo::ThreadInfo>, String> {
    verified(procinfo::threads(pid, &identity))
}

#[tauri::command(async)]
fn process_modules(pid: u32, identity: String) -> Result<Vec<procinfo::ModuleInfo>, String> {
    verified(procinfo::modules(pid, &identity))
}

#[tauri::command(async)]
fn process_file_info(path: String) -> Result<system::FileInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err("That file does not exist.".into());
    }
    Ok(system::file_info(&path))
}

#[tauri::command(async)]
fn set_process_priority(pid: u32, identity: String, priority: String) -> Result<(), String> {
    procinfo::set_priority(pid, &identity, &priority)
}

#[tauri::command(async)]
fn get_process_affinity(pid: u32, identity: String) -> Result<(u64, u64), String> {
    procinfo::affinity(pid, &identity)
}

#[tauri::command(async)]
fn set_process_affinity(pid: u32, identity: String, mask: u64) -> Result<(), String> {
    procinfo::set_affinity(pid, &identity, mask)
}

#[tauri::command(async)]
fn suspend_process(pid: u32, identity: String, suspend: bool) -> Result<u32, String> {
    procinfo::set_suspended(pid, &identity, suspend)
}

#[tauri::command(async)]
fn terminate_process_tree(pid: u32, identity: String) -> Result<procinfo::TreeResult, String> {
    procinfo::terminate_tree(pid, &identity)
}

#[tauri::command(async)]
fn system_info() -> system::SystemInfo {
    system::system_info()
}

#[tauri::command(async)]
fn list_sessions() -> Vec<system::SessionInfo> {
    system::sessions()
}

#[tauri::command(async)]
fn list_services() -> Result<Vec<services::ServiceInfo>, String> {
    services::list().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn control_service(name: String, action: services::ServiceAction) -> Result<(), String> {
    services::control(&name, action).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn list_connections() -> Result<Vec<connections::Connection>, String> {
    connections::list()
}

#[tauri::command(async)]
fn list_startup() -> Vec<startup::StartupEntry> {
    startup::list()
}

#[tauri::command(async)]
fn set_startup_enabled(id: String, enabled: bool) -> Result<(), String> {
    startup::set_enabled(&id, enabled)
}

/// Shows a file in Explorer. The path must be absolute, exist, and contain no quotes, so it cannot
/// smuggle extra arguments into the Explorer command line.
#[tauri::command(async)]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let p = std::path::Path::new(&path);
    if !p.is_absolute() || path.contains(['"', '\0']) || std::fs::metadata(p).is_err() {
        return Err("That file does not exist or its path is not valid.".into());
    }
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}

#[derive(serde::Serialize)]
struct SettingsReply {
    settings: Settings,
    /// Set when a corrupt settings file was replaced by defaults.
    note: Option<String>,
    autostart: bool,
}

#[tauri::command(async)]
fn get_settings(engine: Eng<'_>) -> SettingsReply {
    SettingsReply {
        settings: engine.settings(),
        note: engine.take_settings_note(),
        autostart: startup::autostart_enabled(),
    }
}

#[tauri::command(async)]
fn save_settings(app: AppHandle, engine: Eng<'_>, settings: Settings) -> Result<Settings, String> {
    let saved = engine.update_settings(settings)?;
    apply_window_settings(&app, &saved);
    Ok(saved)
}

#[tauri::command(async)]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    startup::set_autostart(enabled)?;
    Ok(startup::autostart_enabled())
}

#[tauri::command(async)]
fn history_query(
    engine: Eng<'_>,
    from: i64,
    to: i64,
    max_points: i64,
) -> Result<Vec<history::Sample>, String> {
    engine.with_history(|h| h.query(from, to, max_points.clamp(10, 2000)))
}

#[tauri::command(async)]
fn history_spikes(engine: Eng<'_>, from: i64, to: i64) -> Result<Vec<history::Spike>, String> {
    engine.with_history(|h| h.spikes(from, to))
}

#[tauri::command(async)]
fn history_events(engine: Eng<'_>, from: i64, to: i64) -> Result<Vec<history::ProcEvent>, String> {
    engine.with_history(|h| h.events(from, to, 200))
}

#[tauri::command(async)]
fn history_stats(engine: Eng<'_>) -> Option<history::Stats> {
    engine.with_history(|h| Ok(h.stats())).ok()
}

#[tauri::command(async)]
fn history_export(engine: Eng<'_>, from: i64, to: i64) -> Result<String, String> {
    engine.with_history(|h| h.export_csv(from, to))
}

#[tauri::command(async)]
fn history_clear(engine: Eng<'_>) -> Result<(), String> {
    engine.clear_history()
}

#[tauri::command(async)]
fn alert_log(engine: Eng<'_>) -> Vec<alerts::AlertEvent> {
    engine.alert_log()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Window size/position remembered while the compact monitor is active.
#[derive(Default)]
struct CompactState(Mutex<Option<(PhysicalSize<u32>, PhysicalPosition<i32>)>>);

fn apply_window_settings(app: &AppHandle, s: &Settings) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(s.app.tray_enabled);
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let compact = app.state::<CompactState>();
    let Ok(mut saved) = compact.0.lock() else {
        return;
    };
    if s.app.compact {
        if saved.is_none() {
            if let (Ok(size), Ok(pos)) = (window.outer_size(), window.outer_position()) {
                *saved = Some((size, pos));
            }
        }
        let _ = window.set_min_size(Some(LogicalSize::new(320.0, 180.0)));
        let _ = window.set_size(LogicalSize::new(400.0, 320.0));
        let _ = window.set_always_on_top(true);
    } else {
        let _ = window.set_min_size(Some(LogicalSize::new(780.0, 520.0)));
        if let Some((size, pos)) = saved.take() {
            let _ = window.set_size(size);
            let _ = window.set_position(pos);
        }
        let _ = window.set_always_on_top(s.app.always_on_top);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show TaskLens", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("TaskLens")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    tray.set_visible(false)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(CompactState::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let engine = Engine::new(dir);
            app.manage(engine.clone());
            engine.start(app.handle().clone());
            build_tray(app.handle())?;
            let s = engine.settings();
            apply_window_settings(app.handle(), &s);
            let minimized = std::env::args().any(|a| a == "--minimized") || s.app.start_minimized;
            if minimized {
                if let Some(w) = app.get_webview_window("main") {
                    if s.app.tray_enabled {
                        let _ = w.hide();
                    } else {
                        let _ = w.minimize();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let s = engine::from(window.app_handle()).settings();
                if s.app.minimize_to_tray && s.app.tray_enabled {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            set_ui_active,
            terminate_process,
            process_threads,
            process_modules,
            process_file_info,
            set_process_priority,
            get_process_affinity,
            set_process_affinity,
            suspend_process,
            terminate_process_tree,
            system_info,
            list_sessions,
            list_services,
            control_service,
            list_connections,
            list_startup,
            set_startup_enabled,
            reveal_in_explorer,
            get_settings,
            save_settings,
            set_autostart,
            history_query,
            history_spikes,
            history_events,
            history_stats,
            history_export,
            history_clear,
            alert_log,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run TaskLens");
}
