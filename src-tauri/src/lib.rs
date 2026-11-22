pub mod ai;
pub mod capabilities;
pub mod commands;
pub mod dish;
pub mod error;
pub mod export;
pub mod keyring_store;
pub mod models;
pub mod notify;
pub mod service;
pub mod settings;
pub mod state;
pub mod storage;
pub mod time;
pub mod tray;
pub mod uptime;
pub mod usage;
pub mod write_denials;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use crate::state::{AppState, EventSink};

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

/// Whether closing the main window should hide it to the tray (setting `closeToTray`).
fn close_to_tray(app: &tauri::AppHandle) -> bool {
    app.try_state::<Arc<AppState>>()
        .and_then(|s| s.settings.try_read().ok().map(|g| g.close_to_tray))
        .unwrap_or_else(|| models::Settings::default().close_to_tray)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            keyring_store::init_file_fallback(&data_dir);
            let state = Arc::new(AppState::new(&data_dir)?);
            app.manage(state.clone());
            let sink: Arc<dyn EventSink> = Arc::new(tray::setup(app.handle())?);
            tauri::async_runtime::spawn(service::run(state, sink));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == tray::MAIN_WINDOW
            {
                if close_to_tray(window.app_handle()) {
                    // Keep running in the tray.
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_connection_status,
            commands::get_capabilities,
            commands::get_live_snapshot,
            commands::get_history,
            commands::get_events,
            commands::export_history_csv,
            commands::get_obstruction_map,
            commands::get_settings,
            commands::update_settings,
            commands::reboot_dish,
            commands::stow_dish,
            commands::unstow_dish,
            commands::set_snow_melt,
            commands::set_api_key,
            commands::has_api_key,
            commands::delete_api_key,
            commands::preview_ai_payload,
            commands::analyze_network_with_ai,
            commands::get_last_ai_report,
            commands::get_uptime_stats,
            commands::get_data_usage,
            commands::send_test_notification,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // macOS: clicking the Dock icon re-shows the hidden dashboard.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event
            && let Some(win) = _app.get_webview_window(tray::MAIN_WINDOW)
        {
            let _ = win.show();
            let _ = win.set_focus();
        }
    });
}
