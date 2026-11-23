//! Tauri commands (contract: `docs/api.md`). Every command returns
//! `Result<T, CommandError>`.

use std::sync::Arc;

use tauri::State;

use crate::dish::WriteAction;
use crate::error::{AppError, ClientError};
use crate::keyring_store;
use crate::models::{
    AiReport, CommandError, ConnectionStatus, DailyUsage, DataUsage, DiagnosticSummary,
    DishCapabilities, DishEvent, HistoryPoint, ObstructionMap, Settings, SnowMeltMode,
    TelemetrySnapshot, UptimeStats, WeatherPlace, WeatherSeries,
};
use crate::state::{AppState, lock_db};
use crate::storage::MAX_RANGE_MINUTES;
use crate::time::now_ms;

type CmdResult<T> = Result<T, CommandError>;

/// Rejects write actions in read-only mode or when the dish lacks the capability.
pub fn check_write_allowed(
    settings: &Settings,
    caps: &DishCapabilities,
    action: WriteAction,
) -> Result<(), AppError> {
    if settings.read_only {
        return Err(AppError::ReadOnly);
    }
    let (supported, what) = match action {
        WriteAction::Reboot => (caps.can_reboot, "reboot"),
        WriteAction::Stow | WriteAction::Unstow => (caps.can_stow, "stow/unstow"),
        WriteAction::SetSnowMelt(_) => (caps.can_set_snow_melt, "snow melt configuration"),
    };
    if !supported {
        return Err(AppError::Unsupported(format!(
            "{what} is not available on this dish"
        )));
    }
    Ok(())
}

/// Single entry point for every write action (ADR-006).
pub async fn perform_write(state: &AppState, action: WriteAction) -> Result<(), AppError> {
    let settings = state.settings.read().await.clone();
    if settings.read_only {
        return Err(AppError::ReadOnly);
    }
    let (caps, client) = match state.session_caps_and_client().await {
        Some(v) => v,
        None if state.client.read().await.is_none() => {
            return Err(ClientError::Unreachable("not connected".into()).into());
        }
        None => {
            return Err(AppError::Unsupported(
                "dish capabilities are still being detected; try again in a moment".into(),
            ));
        }
    };
    check_write_allowed(&settings, &caps, action)?;
    match client.write(action).await {
        Ok(()) => {
            if let WriteAction::SetSnowMelt(mode) = action {
                // Re-read the dish config; fall back to the requested mode.
                let current = client
                    .get_snow_melt_mode()
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or(mode);
                state.update_snow_melt_mode(current).await;
            }
            Ok(())
        }
        // The dish drops the connection while rebooting: the request was delivered.
        Err(e) if action == WriteAction::Reboot && e.is_connectivity() => {
            tracing::info!("reboot sent; dish is restarting");
            Ok(())
        }
        Err(ClientError::PermissionDenied) => {
            // Firmware blocks local writes: remember it, never retry automatically.
            state.record_write_denial(action).await;
            Err(AppError::WriteDenied)
        }
        Err(e) => Err(e.into()),
    }
}

fn validate_range(range_minutes: u32) -> Result<u32, AppError> {
    if range_minutes == 0 {
        return Err(AppError::InvalidInput("rangeMinutes must be > 0".into()));
    }
    Ok(range_minutes.min(MAX_RANGE_MINUTES))
}

pub async fn history_points(
    state: &AppState,
    range_minutes: u32,
) -> Result<Vec<HistoryPoint>, AppError> {
    let range = validate_range(range_minutes)?;
    let db = state.current_db().await;
    tokio::task::spawn_blocking(move || lock_db(&db).history(range, now_ms()))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)
}

pub async fn history_events(
    state: &AppState,
    range_minutes: u32,
) -> Result<Vec<DishEvent>, AppError> {
    let range = validate_range(range_minutes)?;
    let db = state.current_db().await;
    // Outages only (BOOTING = reboot); other event-log entries stay internal.
    tokio::task::spawn_blocking(move || lock_db(&db).outages(range, now_ms()))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> CmdResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn get_connection_status(state: State<'_, Arc<AppState>>) -> CmdResult<ConnectionStatus> {
    Ok(state.status.read().await.clone())
}

#[tauri::command]
pub async fn get_capabilities(state: State<'_, Arc<AppState>>) -> CmdResult<DishCapabilities> {
    Ok(state.capabilities.read().await.clone())
}

#[tauri::command]
pub async fn get_live_snapshot(state: State<'_, Arc<AppState>>) -> CmdResult<TelemetrySnapshot> {
    state
        .snapshot
        .read()
        .await
        .clone()
        .ok_or_else(|| ClientError::Unreachable("no telemetry available yet".into()).into())
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, Arc<AppState>>,
    range_minutes: u32,
) -> CmdResult<Vec<HistoryPoint>> {
    Ok(history_points(&state, range_minutes).await?)
}

#[tauri::command]
pub async fn get_events(
    state: State<'_, Arc<AppState>>,
    range_minutes: u32,
) -> CmdResult<Vec<DishEvent>> {
    Ok(history_events(&state, range_minutes).await?)
}

/// Asks for a destination with the native save dialog and writes the CSV.
/// Returns the saved path, or `None` when the user cancels.
#[tauri::command]
pub async fn export_history_csv(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    range_minutes: u32,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let points = history_points(&state, range_minutes).await?;
    let csv = crate::export::history_csv(&points);
    let name = crate::export::default_file_name(now_ms());
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("CSV", &["csv"])
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| AppError::InvalidInput("unsupported save location".into()))?;
    let write_path = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, csv))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)?;
    tracing::info!(rows = points.len(), "history exported to CSV");
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn get_obstruction_map(state: State<'_, Arc<AppState>>) -> CmdResult<ObstructionMap> {
    if !state.capabilities.read().await.has_obstruction_map {
        return Err(
            AppError::Unsupported("obstruction map is not available on this dish".into()).into(),
        );
    }
    let client = state
        .client
        .read()
        .await
        .clone()
        .ok_or_else(|| ClientError::Unreachable("not connected".into()))?;
    Ok(client.get_obstruction_map().await?)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, Arc<AppState>>) -> CmdResult<Settings> {
    Ok(state.settings.read().await.clone())
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> CmdResult<Settings> {
    Ok(state.update_settings(settings).await?)
}

#[tauri::command]
pub async fn reboot_dish(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    Ok(perform_write(&state, WriteAction::Reboot).await?)
}

#[tauri::command]
pub async fn stow_dish(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    Ok(perform_write(&state, WriteAction::Stow).await?)
}

#[tauri::command]
pub async fn unstow_dish(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    Ok(perform_write(&state, WriteAction::Unstow).await?)
}

#[tauri::command]
pub async fn set_snow_melt(state: State<'_, Arc<AppState>>, mode: SnowMeltMode) -> CmdResult<()> {
    Ok(perform_write(&state, WriteAction::SetSnowMelt(mode)).await?)
}

#[tauri::command]
pub async fn preview_ai_payload(state: State<'_, Arc<AppState>>) -> CmdResult<DiagnosticSummary> {
    Ok(crate::ai::current_summary(&state).await?)
}

#[tauri::command]
pub async fn analyze_network_with_ai(
    state: State<'_, Arc<AppState>>,
    payload: DiagnosticSummary,
) -> CmdResult<AiReport> {
    let client = crate::ai::anthropic::AnthropicClient::new()?;
    Ok(crate::ai::analyze(&state, &client, None, payload).await?)
}

/// Built-in rule engine diagnosis (offline, no key).
#[tauri::command]
pub async fn run_diagnostics(state: State<'_, Arc<AppState>>) -> CmdResult<AiReport> {
    Ok(crate::ai::run_diagnostics(&state).await?)
}

/// Models available on the configured local AI server.
#[tauri::command]
pub async fn list_local_models(state: State<'_, Arc<AppState>>) -> CmdResult<Vec<String>> {
    Ok(crate::ai::list_local_models(&state).await?)
}

/// Geocoding search for the weather place picker.
#[tauri::command]
pub async fn search_weather_locations(query: String) -> CmdResult<Vec<WeatherPlace>> {
    Ok(crate::weather::search(&query, crate::i18n::current()).await?)
}

/// Hourly weather for the last `range_minutes` at the configured place.
#[tauri::command]
pub async fn get_weather(
    state: State<'_, Arc<AppState>>,
    range_minutes: u32,
) -> CmdResult<WeatherSeries> {
    let loc = state.settings.read().await.weather_location.clone();
    Ok(crate::weather::get(loc, range_minutes).await?)
}

/// Last report of the built-in rule engine (`run_diagnostics`) for the active data source.
pub async fn last_rules_report(state: &AppState) -> Result<Option<AiReport>, AppError> {
    let db = state.current_db().await;
    tokio::task::spawn_blocking(move || lock_db(&db).last_rules_report())
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn get_last_rules_report(state: State<'_, Arc<AppState>>) -> CmdResult<Option<AiReport>> {
    Ok(last_rules_report(&state).await?)
}

/// Checks GitHub Releases for a newer version (`updaterConfigured: false` when the build
/// has no updater key; never an error in that case).
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> CmdResult<crate::models::UpdateInfo> {
    Ok(crate::updater::check(&app).await?)
}

/// Opens the fixed GitHub Releases page of this build in the system browser.
#[tauri::command]
pub async fn open_releases_page(app: tauri::AppHandle) -> CmdResult<()> {
    Ok(crate::updater::open_releases_page(&app)?)
}

/// Downloads, verifies and installs the update, then restarts the app.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> CmdResult<()> {
    Ok(crate::updater::install(&app).await?)
}

/// Guided alignment mode: 1 s read-only polling, auto-off after 10 min (dishes without
/// motors only).
#[tauri::command]
pub async fn set_alignment_mode(state: State<'_, Arc<AppState>>, enabled: bool) -> CmdResult<()> {
    crate::alignment::set_mode(&state, enabled).await?;
    Ok(())
}

/// Reported by the frontend on `visibilitychange`; a hidden dashboard slows the live poll.
#[tauri::command]
pub fn set_ui_visible(state: State<'_, Arc<AppState>>, visible: bool) {
    let was = state
        .ui_visible
        .swap(visible, std::sync::atomic::Ordering::Relaxed);
    if visible && !was {
        // Refresh the live view right away instead of waiting for the slow interval.
        state.alignment_changed.notify_one();
    }
}

// ---- Phase 6 ----------------------------------------------------------------

async fn on_db<T: Send + 'static>(
    state: &AppState,
    f: impl FnOnce(&mut crate::storage::Db) -> Result<T, rusqlite::Error> + Send + 'static,
) -> Result<T, AppError> {
    let db = state.current_db().await;
    tokio::task::spawn_blocking(move || f(&mut lock_db(&db)))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)
}

pub async fn location_stats(
    state: &AppState,
) -> Result<Vec<crate::models::LocationStats>, AppError> {
    on_db(state, |db| db.location_stats()).await
}

/// Renames a location tag (`from` may be "" to tag untagged data); keeps the active
/// location setting in sync.
pub async fn rename_location_impl(state: &AppState, from: &str, to: &str) -> Result<(), AppError> {
    let from = from.trim().to_string();
    if from.chars().count() > 40 || from.chars().any(char::is_control) {
        return Err(AppError::InvalidInput("invalid location name".into()));
    }
    let to = crate::settings::validate_location_name(to)?;
    move_location(state, from, to).await
}

/// Removes a location tag (the data stays, untagged).
pub async fn delete_location_impl(state: &AppState, name: &str) -> Result<(), AppError> {
    let name = crate::settings::validate_location_name(name)?;
    move_location(state, name, String::new()).await
}

async fn move_location(state: &AppState, from: String, to: String) -> Result<(), AppError> {
    let (f, t) = (from.clone(), to.clone());
    on_db(state, move |db| db.rename_location(&f, &t)).await?;
    let settings = state.settings.read().await.clone();
    if settings.active_location.as_deref() == Some(from.as_str()) {
        let active = (!to.is_empty()).then_some(to);
        state
            .update_settings(Settings {
                active_location: active,
                ..settings
            })
            .await?;
    }
    Ok(())
}

pub async fn time_of_day_stats(
    state: &AppState,
    days: u32,
) -> Result<crate::models::TimeOfDayStats, AppError> {
    if !(7..=90).contains(&days) {
        return Err(AppError::InvalidInput(
            "days must be between 7 and 90".into(),
        ));
    }
    let dates = crate::insights::last_dates(now_ms(), days, &chrono::Local);
    let from = dates
        .first()
        .map(|d| crate::usage::date_key(*d))
        .unwrap_or(0);
    let rows = on_db(state, move |db| db.hourly_since(from)).await?;
    Ok(crate::insights::time_of_day(&rows, days))
}

pub async fn energy(
    state: &AppState,
    days: u32,
) -> Result<Vec<crate::models::DailyEnergy>, AppError> {
    if !(1..=90).contains(&days) {
        return Err(AppError::InvalidInput(
            "days must be between 1 and 90".into(),
        ));
    }
    let dates = crate::insights::last_dates(now_ms(), days, &chrono::Local);
    let from = dates
        .first()
        .map(|d| crate::usage::date_key(*d))
        .unwrap_or(0);
    let rows = on_db(state, move |db| db.hourly_since(from)).await?;
    Ok(crate::insights::daily_energy(&rows, &dates, &chrono::Local))
}

#[tauri::command]
pub async fn get_location_stats(
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<crate::models::LocationStats>> {
    Ok(location_stats(&state).await?)
}

#[tauri::command]
pub async fn rename_location(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
) -> CmdResult<()> {
    Ok(rename_location_impl(&state, &from, &to).await?)
}

#[tauri::command]
pub async fn delete_location(state: State<'_, Arc<AppState>>, name: String) -> CmdResult<()> {
    Ok(delete_location_impl(&state, &name).await?)
}

#[tauri::command]
pub async fn get_time_of_day_stats(
    state: State<'_, Arc<AppState>>,
    days: u32,
) -> CmdResult<crate::models::TimeOfDayStats> {
    Ok(time_of_day_stats(&state, days).await?)
}

#[tauri::command]
pub async fn get_energy(
    state: State<'_, Arc<AppState>>,
    days: u32,
) -> CmdResult<Vec<crate::models::DailyEnergy>> {
    Ok(energy(&state, days).await?)
}

#[tauri::command]
pub async fn get_last_ai_report(state: State<'_, Arc<AppState>>) -> CmdResult<Option<AiReport>> {
    let db = state.current_db().await;
    Ok(
        tokio::task::spawn_blocking(move || lock_db(&db).last_ai_report())
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
            .map_err(AppError::from)?,
    )
}

/// Uptime over 24 h (minute data), 7 d and 30 d (daily table).
pub async fn uptime_stats(state: &AppState) -> Result<UptimeStats, AppError> {
    let db = state.current_db().await;
    let now = now_ms();
    tokio::task::spawn_blocking(move || {
        let db = lock_db(&db);
        let covered = db.covered_seconds(24 * 60, now)?;
        let (count, out) =
            crate::uptime::clipped_outages(&db.outages(24 * 60, now)?, now - 86_400_000, now);
        let mut windows = vec![crate::uptime::window("24h", 86_400.0, covered, count, out)];
        for (label, days) in [("7d", 7u32), ("30d", 30)] {
            let (covered, count, out) = db.daily_uptime(days, now)?;
            windows.push(crate::uptime::window(
                label,
                days as f64 * 86_400.0,
                covered,
                count,
                out,
            ));
        }
        Ok::<_, rusqlite::Error>(UptimeStats { windows })
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?
    .map_err(AppError::from)
}

/// Estimated usage per local day (newest last, zero-filled) and for the billing cycle.
pub async fn data_usage(state: &AppState, days: u32) -> Result<DataUsage, AppError> {
    if !(1..=90).contains(&days) {
        return Err(AppError::InvalidInput(
            "days must be between 1 and 90".into(),
        ));
    }
    use crate::usage::{date_key, local_date, local_midnight_ms};
    let settings = state.settings.read().await.clone();
    let db = state.current_db().await;
    let now = now_ms();
    let tz = chrono::Local;
    let today = local_date(now, &tz);
    let dates: Vec<chrono::NaiveDate> = (0..days as i64)
        .rev()
        .filter_map(|back| today.checked_sub_signed(chrono::Duration::days(back)))
        .collect();
    let cycle_start = crate::usage::cycle_start_ms(now, settings.billing_cycle_day, &tz);
    let cycle_key = date_key(local_date(cycle_start, &tz));
    let from = dates
        .first()
        .map(|d| date_key(*d))
        .unwrap_or(cycle_key)
        .min(cycle_key);
    let rows = tokio::task::spawn_blocking(move || lock_db(&db).usage_since(from))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    let by_key: std::collections::HashMap<i64, &crate::storage::UsageRow> =
        rows.iter().map(|r| (r.date_key, r)).collect();
    let daily = dates
        .iter()
        .map(|d| {
            let row = by_key.get(&date_key(*d));
            DailyUsage {
                day_ms: local_midnight_ms(*d, &tz),
                download_bytes: row.map_or(0.0, |r| r.download_bytes),
                upload_bytes: row.map_or(0.0, |r| r.upload_bytes),
            }
        })
        .collect();
    let (down, up) = rows
        .iter()
        .filter(|r| r.date_key >= cycle_key)
        .fold((0.0, 0.0), |(d, u), r| {
            (d + r.download_bytes, u + r.upload_bytes)
        });
    Ok(DataUsage {
        daily,
        cycle_start_ms: cycle_start,
        cycle_download_bytes: down,
        cycle_upload_bytes: up,
        cap_gb: settings.data_cap_gb,
        is_estimate: true,
    })
}

#[tauri::command]
pub async fn get_uptime_stats(state: State<'_, Arc<AppState>>) -> CmdResult<UptimeStats> {
    Ok(uptime_stats(&state).await?)
}

#[tauri::command]
pub async fn get_data_usage(state: State<'_, Arc<AppState>>, days: u32) -> CmdResult<DataUsage> {
    Ok(data_usage(&state, days).await?)
}

/// Shows a test notification, bypassing settings, quiet hours, cooldown and mock suppression.
#[tauri::command]
pub async fn send_test_notification(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let sink = state
        .sink
        .read()
        .await
        .clone()
        .ok_or_else(|| AppError::Internal("notifications not ready yet".into()))?;
    sink.notify(&crate::notify::Notification {
        kind: crate::notify::NotificationKind::Test,
        title: "StarlinkPulse".into(),
        body: crate::i18n::NotifyTexts::get(crate::i18n::current())
            .test_body
            .into(),
        bypass_cooldown: true,
        tag: None,
    });
    Ok(())
}

#[tauri::command]
pub async fn set_api_key(key: String) -> CmdResult<()> {
    blocking(move || keyring_store::set_api_key(&key)).await
}

#[tauri::command]
pub async fn has_api_key() -> CmdResult<bool> {
    blocking(keyring_store::has_api_key).await
}

#[tauri::command]
pub async fn delete_api_key() -> CmdResult<()> {
    blocking(keyring_store::delete_api_key).await
}

// ---- Phase 7: Wi-Fi devices, support report ----

/// Starlink router clients for the live UI. Names are display-only (never logged/stored).
pub async fn wifi_devices(state: &AppState) -> crate::models::WifiDevices {
    let available = state.status.read().await.router_available;
    if !available {
        return crate::models::WifiDevices::default();
    }
    crate::models::WifiDevices {
        available,
        devices: crate::wifi::devices(&state.wifi_clients.read().await),
        updated_ms: *state.wifi_updated_ms.read().await,
    }
}

#[tauri::command]
pub async fn get_wifi_devices(
    state: State<'_, Arc<AppState>>,
) -> CmdResult<crate::models::WifiDevices> {
    Ok(wifi_devices(&state).await)
}

/// Anonymized Markdown support report in the UI language.
#[tauri::command]
pub async fn get_support_report(state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    Ok(crate::support_report::build(&state).await?)
}

/// Max size of an exported report.
const MAX_REPORT_BYTES: usize = 1_000_000;

/// Saves the given (previewed) support report with the native save dialog; `None` when cancelled.
#[tauri::command]
pub async fn export_support_report(
    app: tauri::AppHandle,
    report: String,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    if report.len() > MAX_REPORT_BYTES {
        return Err(AppError::InvalidInput("report too large".into()).into());
    }
    let name = crate::support_report::default_file_name(now_ms());
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| AppError::InvalidInput("unsupported save location".into()))?;
    let write_path = path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&write_path, report))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::from)?;
    tracing::info!("support report exported");
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{CapabilityInputs, Probe, detect};
    use crate::dish::StarlinkClient;
    use crate::dish::mock::MockClient;
    use crate::models::{MockProfile, Settings};

    async fn state_with_mock(
        profile: MockProfile,
        read_only: bool,
    ) -> (Arc<AppState>, Arc<MockClient>) {
        let settings = Settings {
            read_only,
            ..Default::default()
        };
        let state = Arc::new(AppState::in_memory(settings).unwrap());
        let mock = Arc::new(MockClient::new(profile));
        let caps = detect(&CapabilityInputs {
            status: mock.get_status().await.ok(),
            request_names: mock.request_names(),
            history_has_power: Some(true),
            obstruction_map: Probe::Supported,
            router_available: mock.has_router(),
            is_mock: true,
        });
        *state.capabilities.write().await = caps;
        *state.client.write().await = Some(mock.clone());
        (state, mock)
    }

    #[tokio::test]
    async fn read_only_rejects_every_write() {
        let (state, mock) = state_with_mock(MockProfile::StandardActuated, true).await;
        for action in [
            WriteAction::Reboot,
            WriteAction::Stow,
            WriteAction::Unstow,
            WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn),
        ] {
            let err = perform_write(&state, action).await.unwrap_err();
            assert_eq!(err.kind(), "read_only", "{action:?}");
        }
        assert!(mock.writes().is_empty(), "nothing reached the client");
    }

    #[tokio::test]
    async fn unsupported_write_is_rejected_before_client() {
        let (state, mock) = state_with_mock(MockProfile::Mini, false).await;
        let err = perform_write(&state, WriteAction::Stow).await.unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert!(mock.writes().is_empty());
    }

    #[tokio::test]
    async fn allowed_writes_reach_mock() {
        let (state, mock) = state_with_mock(MockProfile::StandardActuated, false).await;
        perform_write(&state, WriteAction::Stow).await.unwrap();
        perform_write(&state, WriteAction::Unstow).await.unwrap();
        perform_write(&state, WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn))
            .await
            .unwrap();
        perform_write(&state, WriteAction::Reboot).await.unwrap();
        assert_eq!(
            mock.writes(),
            vec![
                WriteAction::Stow,
                WriteAction::Unstow,
                WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn),
                WriteAction::Reboot
            ]
        );
    }

    #[tokio::test]
    async fn write_without_client_is_offline() {
        let state = AppState::in_memory(Settings {
            read_only: false,
            ..Default::default()
        })
        .unwrap();
        state.capabilities.write().await.can_reboot = true;
        let err = perform_write(&state, WriteAction::Reboot)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "offline");
    }

    #[tokio::test]
    async fn history_queries_use_mock_db_and_validate_range() {
        let (state, mock) = state_with_mock(MockProfile::Mini, true).await;
        let client: Arc<dyn StarlinkClient> = mock;
        crate::service::ingest_history(&state, &client).await;
        let pts = history_points(&state, 60).await.unwrap();
        assert!(!pts.is_empty());
        assert!(pts.windows(2).all(|w| w[0].minute_ms < w[1].minute_ms));
        // Real DB untouched by mock data.
        assert!(lock_db(&state.db).is_empty().unwrap());
        assert_eq!(
            history_points(&state, 0).await.unwrap_err().kind(),
            "invalid_input"
        );
        assert!(history_events(&state, 100_000).await.is_ok());
    }

    #[tokio::test]
    async fn settings_update_validates_and_signals_reconnect() {
        let state = AppState::in_memory(Settings::default()).unwrap();
        let bad = Settings {
            live_poll_interval_s: 0,
            ..Default::default()
        };
        assert_eq!(
            state.update_settings(bad).await.unwrap_err().kind(),
            "invalid_input"
        );
        let s = Settings {
            mock_mode: crate::models::MockMode::On,
            ..Default::default()
        };
        state.update_settings(s.clone()).await.unwrap();
        assert_eq!(*state.settings.read().await, s);
        // A permit is stored by notify_one.
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            state.reconnect.notified(),
        )
        .await
        .expect("reconnect notified");
    }

    #[derive(Default)]
    struct CapsRecorder(std::sync::Mutex<Vec<DishCapabilities>>);

    impl crate::state::EventSink for CapsRecorder {
        fn telemetry(&self, _: &TelemetrySnapshot) {}
        fn connection_status(&self, _: &ConnectionStatus) {}
        fn capabilities(&self, c: &DishCapabilities) {
            self.0.lock().unwrap().push(c.clone());
        }
    }

    #[tokio::test]
    async fn permission_denied_write_downgrades_and_persists() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-deny-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        crate::settings::save(
            &dir.join(crate::settings::SETTINGS_FILE),
            &Settings {
                read_only: false,
                ..Default::default()
            },
        )
        .unwrap();
        let state = AppState::new(&dir).unwrap();
        let rec = Arc::new(CapsRecorder::default());
        *state.sink.write().await = Some(rec.clone());
        let mock = Arc::new(MockClient::new(MockProfile::StandardActuated));
        mock.set_deny_writes(true);
        let fresh_caps = detect(&CapabilityInputs {
            status: mock.get_status().await.ok(),
            request_names: mock.request_names(),
            is_mock: true,
            ..Default::default()
        });
        assert!(fresh_caps.can_set_snow_melt && fresh_caps.can_reboot && fresh_caps.can_stow);
        *state.capabilities.write().await = fresh_caps.clone();
        *state.client.write().await = Some(mock.clone());

        let err: CommandError = perform_write(&state, WriteAction::SetSnowMelt(SnowMeltMode::Auto))
            .await
            .unwrap_err()
            .into();
        assert_eq!(err.kind, "unsupported");
        assert_eq!(
            err.message,
            "This dish firmware does not allow this change from the local network. Use the Starlink app."
        );
        assert!(mock.writes().is_empty(), "nothing applied");
        // Live capabilities downgraded and emitted; others untouched.
        let caps = state.capabilities.read().await.clone();
        assert!(!caps.can_set_snow_melt);
        assert!(caps.can_reboot && caps.can_stow);
        assert_eq!(rec.0.lock().unwrap().last(), Some(&caps));
        // A second attempt is rejected up front, without reaching the dish.
        let again = perform_write(&state, WriteAction::SetSnowMelt(SnowMeltMode::Auto))
            .await
            .unwrap_err();
        assert!(matches!(again, AppError::Unsupported(_)));

        // Unimplemented keeps the generic unsupported message.
        mock.set_deny_writes(false);
        let mini = Arc::new(MockClient::new(MockProfile::Mini));
        *state.client.write().await = Some(mini);
        let err = perform_write(&state, WriteAction::Stow).await.unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert!(!err.to_string().contains("Starlink app"));
        assert!(
            state.capabilities.read().await.can_stow,
            "Unimplemented is not persisted"
        );

        // Persisted: a new state (next app start) applies the downgrade on connect.
        drop(state);
        let restarted = AppState::new(&dir).unwrap();
        let mut caps2 = fresh_caps.clone();
        restarted.apply_write_denials(&mut caps2);
        assert!(!caps2.can_set_snow_melt);
        assert!(caps2.can_reboot && caps2.can_stow);
        // Another firmware version is not affected.
        let mut caps3 = DishCapabilities {
            software_version: Some("2027.01.01.other".into()),
            ..fresh_caps
        };
        restarted.apply_write_denials(&mut caps3);
        assert!(caps3.can_set_snow_melt);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn stale_capabilities_never_authorize_writes_after_reconnect() {
        // Session A: actuated mock, stow allowed.
        let (state, mock_a) = state_with_mock(MockProfile::StandardActuated, false).await;
        perform_write(&state, WriteAction::Stow).await.unwrap();
        assert_eq!(mock_a.writes().len(), 1);

        // Reconnect starts: client dropped and capabilities reset before the swap.
        let sid = state.begin_session().await;
        assert!(!state.capabilities.read().await.can_stow);
        assert_eq!(
            perform_write(&state, WriteAction::Stow)
                .await
                .unwrap_err()
                .kind(),
            "offline"
        );

        // New client installed, capabilities not detected yet -> rejected.
        let mock_b = Arc::new(MockClient::new(MockProfile::StandardActuated));
        *state.client.write().await = Some(mock_b.clone());
        // Even if someone restores the old capabilities without a session id.
        state.capabilities.write().await.can_stow = true;
        let err = perform_write(&state, WriteAction::Stow).await.unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert!(mock_b.writes().is_empty());

        // Capabilities from an older session are ignored.
        let caps = detect(&CapabilityInputs {
            status: mock_b.get_status().await.ok(),
            request_names: mock_b.request_names(),
            is_mock: true,
            ..Default::default()
        });
        assert!(!state.set_capabilities(sid - 1, caps.clone()).await);
        assert!(perform_write(&state, WriteAction::Stow).await.is_err());

        // Detection for the current session enables writes again.
        assert!(state.set_capabilities(sid, caps.clone()).await);
        perform_write(&state, WriteAction::Stow).await.unwrap();
        assert_eq!(mock_b.writes(), vec![WriteAction::Stow]);

        // Capabilities of a mock never authorize a real (non-mock) client and vice versa.
        let real_like = DishCapabilities {
            is_mock: false,
            ..caps
        };
        assert!(state.set_capabilities(sid, real_like).await);
        let err = perform_write(&state, WriteAction::Stow).await.unwrap_err();
        assert_eq!(err.kind(), "unsupported");
        assert_eq!(mock_b.writes().len(), 1);
    }

    #[tokio::test]
    async fn reboot_connection_loss_counts_as_sent() {
        let (state, mock) = state_with_mock(MockProfile::Mini, false).await;
        mock.set_write_error(Some(ClientError::Timeout));
        perform_write(&state, WriteAction::Reboot).await.unwrap();
        mock.set_write_error(Some(ClientError::Unreachable("reset".into())));
        perform_write(&state, WriteAction::Reboot).await.unwrap();
        // Other writes still report the timeout.
        mock.set_write_error(Some(ClientError::Timeout));
        let err = perform_write(&state, WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOn))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "timeout");
        mock.set_write_error(Some(ClientError::Rpc("Internal".into())));
        assert!(perform_write(&state, WriteAction::Reboot).await.is_err());
    }

    #[tokio::test]
    async fn snow_melt_mode_updated_after_set() {
        let (state, mock) = state_with_mock(MockProfile::Mini, false).await;
        let rec = Arc::new(CapsRecorder::default());
        *state.sink.write().await = Some(rec.clone());
        perform_write(&state, WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOff))
            .await
            .unwrap();
        assert_eq!(mock.snow_melt(), SnowMeltMode::AlwaysOff);
        let caps = state.capabilities.read().await.clone();
        assert_eq!(caps.snow_melt_mode, Some(SnowMeltMode::AlwaysOff));
        assert_eq!(rec.0.lock().unwrap().last(), Some(&caps));
    }

    #[tokio::test]
    async fn get_events_returns_outages_only() {
        let state = AppState::in_memory(Settings::default()).unwrap();
        let now = now_ms();
        let mut h = crate::dish::DishHistory {
            current: 10,
            latency_ms: vec![Some(20.0); 900],
            ..Default::default()
        };
        h.outages = vec![DishEvent {
            start_ms: now - 60_000,
            duration_ms: 1_000,
            cause: "BOOTING".into(),
            severity: None,
        }];
        h.other_events = vec![DishEvent {
            start_ms: now - 30_000,
            duration_ms: 0,
            cause: "SOFTWARE_UPDATE".into(),
            severity: Some("ADVISORY".into()),
        }];
        lock_db(&state.db).ingest_history(&h, now).unwrap();
        let ev = history_events(&state, 60).await.unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].cause, "BOOTING");
    }

    #[tokio::test]
    async fn last_rules_report_roundtrip_and_source_separation() {
        let (state, _mock) = state_with_mock(MockProfile::Mini, true).await;
        assert_eq!(last_rules_report(&state).await.unwrap(), None);
        // Seed 90 minutes of mock history, then run the rule engine.
        let now = now_ms();
        let pts: Vec<HistoryPoint> = (1..=90)
            .map(|i| HistoryPoint {
                minute_ms: crate::time::minute_floor(now) - i * crate::time::MINUTE_MS,
                samples: 60,
                latency_avg_ms: Some(30.0),
                ..Default::default()
            })
            .collect();
        lock_db(&state.mock_db)
            .insert_backfill(&pts, &[], now)
            .unwrap();
        let report = crate::ai::run_diagnostics(&state).await.unwrap();
        assert_eq!(report.source, crate::models::ReportSource::Rules);
        assert_eq!(last_rules_report(&state).await.unwrap(), Some(report));
        // The AI slot and the real dish's database are untouched.
        assert_eq!(lock_db(&state.mock_db).last_ai_report().unwrap(), None);
        assert_eq!(lock_db(&state.db).last_rules_report().unwrap(), None);
        // With the mock gone the real database is read: nothing there.
        *state.client.write().await = None;
        assert_eq!(last_rules_report(&state).await.unwrap(), None);
    }

    #[tokio::test]
    async fn launch_at_login_is_applied_before_saving() {
        use crate::autostart::tests::FakeLoginItem;
        let state = AppState::in_memory(Settings::default()).unwrap();
        let item = Arc::new(FakeLoginItem::default());
        *state.login_item.write().await = Some(item.clone());
        let on = Settings {
            launch_at_login: true,
            ..Default::default()
        };
        state.update_settings(on.clone()).await.unwrap();
        assert!(*item.enabled.lock().unwrap());
        // Unrelated changes do not touch the OS login item.
        let other = Settings {
            billing_cycle_day: 5,
            ..on
        };
        state.update_settings(other).await.unwrap();
        assert_eq!(*item.writes.lock().unwrap(), 1);

        // OS refuses: error, setting not changed.
        let broken = AppState::in_memory(Settings::default()).unwrap();
        *broken.login_item.write().await = Some(Arc::new(FakeLoginItem {
            fail: true,
            ..Default::default()
        }));
        let err = broken
            .update_settings(Settings {
                launch_at_login: true,
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "internal");
        assert!(!broken.settings.read().await.launch_at_login);
        assert!(!Settings::default().launch_at_login, "default off");
    }

    #[tokio::test]
    async fn wifi_devices_from_mock_router() {
        let (state, mock) = state_with_mock(MockProfile::Mini, true).await;
        assert!(!wifi_devices(&state).await.available);
        state.status.write().await.router_available = true;
        *state.wifi_clients.write().await = crate::dish::RouterClient::wifi_clients(mock.as_ref())
            .await
            .unwrap();
        *state.wifi_updated_ms.write().await = Some(1);
        let w = wifi_devices(&state).await;
        assert!(w.available);
        assert_eq!(w.updated_ms, Some(1));
        assert_eq!(w.devices.len(), 6, "router itself excluded");
        assert!(w.devices.iter().all(|d| d.name.is_some()));
        assert_eq!(w.devices[0].quality, Some(crate::models::WifiQuality::Poor));
        // Names reach the live UI only: not the AI payload, or the report.
        let names: Vec<String> = w.devices.iter().filter_map(|d| d.name.clone()).collect();
        let summary =
            serde_json::to_string(&crate::ai::current_summary(&state).await.unwrap()).unwrap();
        let report = crate::support_report::build(&state).await.unwrap();
        for n in &names {
            assert!(!summary.contains(n.as_str()), "{n} in AI payload");
            assert!(!report.contains(n.as_str()), "{n} in report");
        }
        assert!(report.contains("Wi-Fi") && report.contains("Devices: 6"));
    }
}
