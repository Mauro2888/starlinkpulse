pub mod ai;
pub mod alignment;
pub mod autostart;
pub mod capabilities;
pub mod commands;
pub mod dish;
pub mod error;
pub mod export;
pub mod i18n;
pub mod insights;
pub mod keyring_store;
pub mod models;
pub mod notify;
pub mod readiness;
pub mod rules;
pub mod service;
pub mod settings;
pub mod state;
pub mod storage;
pub mod time;
pub mod tray;
pub mod updater;
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![autostart::AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Opener is used from Rust only (fixed releases URL); no webview permission granted.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            keyring_store::init_file_fallback(&data_dir);
            let state = Arc::new(AppState::new(&data_dir)?);
            app.manage(state.clone());
            // Resolve the UI language before the tray menu is built.
            if let Ok(settings) = state.settings.try_read() {
                i18n::set_current(i18n::resolve(
                    settings.language,
                    i18n::os_locale().as_deref(),
                ));
            }
            // Launch at login: the setting is the source of truth; sync the OS state.
            let login_item: Arc<dyn autostart::LoginItem> =
                Arc::new(autostart::TauriLoginItem(app.handle().clone()));
            if let Ok(settings) = state.settings.try_read() {
                if let Err(e) =
                    autostart::sync_login_item(login_item.as_ref(), settings.launch_at_login)
                {
                    tracing::warn!(error = %e, "could not sync launch at login");
                }
                // Started by the login item: stay in the tray (only if the tray keeps the
                // app reachable, i.e. close-to-tray is on).
                if settings.close_to_tray
                    && std::env::args().any(|a| a == autostart::AUTOSTART_FLAG)
                    && let Some(win) = app.get_webview_window(tray::MAIN_WINDOW)
                {
                    let _ = win.hide();
                }
            }
            if let Ok(mut slot) = state.login_item.try_write() {
                *slot = Some(login_item);
            }
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
            commands::set_alignment_mode,
            commands::get_location_stats,
            commands::rename_location,
            commands::delete_location,
            commands::get_time_of_day_stats,
            commands::get_energy,
            commands::check_for_update,
            commands::install_update,
            commands::open_releases_page,
            commands::run_diagnostics,
            commands::get_last_rules_report,
            commands::list_local_models,
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
