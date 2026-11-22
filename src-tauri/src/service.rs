//! Background connection supervisor: connects to the dish (or the mock), detects
//! capabilities, polls live telemetry, ingests history and watches the optional router.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::{Instant, MissedTickBehavior, interval, interval_at};

use crate::capabilities::{self, CapabilityInputs, Probe};
use crate::dish::grpc::{DEFAULT_TIMEOUT, GrpcClient};
use crate::dish::mock::MockClient;
use crate::dish::{RouterClient, StarlinkClient};
use crate::models::{ConnectionState, ConnectionStatus, MockMode, Settings};
use crate::notify::{Notification, Observation};
use crate::state::{AppState, EventSink, lock_db};
use crate::storage::{BootInfo, aggregate_minutes};
use crate::time::now_ms;

/// History ingest period (ADR-004: every ~5 min, the ring buffer holds 15 min).
pub const HISTORY_PERIOD: Duration = Duration::from_secs(300);
/// Router poll period.
pub const ROUTER_PERIOD: Duration = Duration::from_secs(60);
/// How often Auto mode retries the real dish while showing mock data.
pub const REAL_RETRY_PERIOD: Duration = Duration::from_secs(60);
/// Back-off before reconnecting when the dish is unreachable (Mock Mode off).
pub const OFFLINE_RETRY: Duration = Duration::from_secs(10);
/// Consecutive failed polls before the real dish is considered offline.
pub const MAX_POLL_FAILURES: u32 = 3;
const ROUTER_TIMEOUT: Duration = Duration::from_secs(3);
const MOCK_BACKFILL_HOURS: u32 = 48;
/// Cached power older than this is not shown (refreshed by the 5-minute history ingest).
const POWER_STALE: Duration = Duration::from_secs(11 * 60);
/// Maximum delay between router reconnect attempts.
pub const ROUTER_BACKOFF_MAX: Duration = Duration::from_secs(30 * 60);

/// Runs forever; restarts the session whenever settings require a reconnect.
pub async fn run(state: Arc<AppState>, sink: Arc<dyn EventSink>) {
    *state.sink.write().await = Some(sink.clone());
    restore_data_cap_level(&state).await;
    loop {
        let settings = state.settings.read().await.clone();
        tokio::select! {
            _ = state.reconnect.notified() => {
                tracing::info!("reconnect requested");
            }
            _ = session(&state, &settings, &sink) => {}
        }
    }
}

/// Updates the connection status, emitting an event when anything but the timestamp changed.
async fn set_status(
    state: &AppState,
    sink: &Arc<dyn EventSink>,
    f: impl FnOnce(&mut ConnectionStatus),
) {
    let mut guard = state.status.write().await;
    let before = guard.clone();
    f(&mut guard);
    let changed = before.state != guard.state
        || before.router_available != guard.router_available
        || before.last_error != guard.last_error
        || before.dish_address != guard.dish_address;
    let snapshot = guard.clone();
    drop(guard);
    if changed {
        sink.connection_status(&snapshot);
    }
}

async fn connect_real(
    state: &AppState,
    settings: &Settings,
) -> Result<GrpcClient, crate::error::ClientError> {
    GrpcClient::connect(
        &settings.dish_address,
        state.schema_cache.as_ref(),
        "dish",
        DEFAULT_TIMEOUT,
    )
    .await
}

async fn connect_router(state: &AppState, settings: &Settings) -> Option<Arc<dyn RouterClient>> {
    if settings.router_address.trim().is_empty() {
        return None; // router disabled in settings
    }
    match GrpcClient::connect(
        &settings.router_address,
        state.schema_cache.as_ref(),
        "router",
        ROUTER_TIMEOUT,
    )
    .await
    {
        Ok(router) => match router.handle("wifi_get_clients").await {
            Ok(_) => Some(Arc::new(router)),
            Err(e) => {
                tracing::info!(error = %e, "router reachable but wifi_get_clients unavailable");
                None
            }
        },
        Err(e) => {
            tracing::debug!(error = %e, "no Starlink router");
            None
        }
    }
}

/// Ensures the mock database holds data for `mock`'s profile (backfilled 48 h).
async fn prepare_mock_db(state: &Arc<AppState>, mock: Arc<MockClient>) {
    let profile = mock.profile();
    {
        let mut current = state
            .mock_db_profile
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if *current == Some(profile) {
            return;
        }
        *current = Some(profile);
    }
    let db = state.mock_db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let fresh = crate::storage::Db::open_in_memory()?;
        let mut guard = lock_db(&db);
        *guard = fresh;
        let (samples, outages) = mock.backfill(MOCK_BACKFILL_HOURS);
        let points = aggregate_minutes(&samples);
        guard.insert_backfill(&points, &outages, now_ms())?;
        guard.add_usage(&crate::usage::usage_by_local_day(&samples, &chrono::Local))?;
        // Older days (3..=30) as daily aggregates for 7 d / 30 d uptime and usage.
        let (daily, usage) = mock.daily_backfill(30, 2);
        guard.insert_daily_if_missing(&daily)?;
        let usage: std::collections::BTreeMap<i64, (f64, f64)> =
            usage.into_iter().map(|(d, a, b)| (d, (a, b))).collect();
        guard.add_usage(&usage)
    })
    .await;
    match res {
        Ok(Ok(())) => tracing::info!(?profile, "mock history backfilled"),
        Ok(Err(e)) => tracing::warn!(error = %e, "mock backfill failed"),
        Err(e) => tracing::warn!(error = %e, "mock backfill task failed"),
    }
}

/// Fetches `get_history` and stores it. Returns whether power telemetry is present.
pub async fn ingest_history(state: &AppState, client: &Arc<dyn StarlinkClient>) -> Option<bool> {
    // Boot markers let storage detect reboots the `current` counter alone would miss.
    let boot = client.get_status().await.ok().map(|s| BootInfo {
        uptime_s: s.snapshot.uptime_s,
        bootcount: s.bootcount,
    });
    let history = match client.get_history().await {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(error = %e, "get_history failed");
            return None;
        }
    };
    let has_power = history.has_power();
    *state.power_cache.write().await = Some((history.latest_power(), now_ms()));
    let db = state.db_for(client.is_mock());
    let res = tokio::task::spawn_blocking(move || {
        lock_db(&db).ingest_history_with_boot(&history, now_ms(), boot)
    })
    .await;
    match res {
        Ok(Ok(report)) => tracing::debug!(
            new_samples = report.new_samples,
            minutes = report.minutes_updated,
            reset = report.counter_reset,
            "history ingested"
        ),
        Ok(Err(e)) => tracing::warn!(error = %e, "history ingest failed"),
        Err(e) => tracing::warn!(error = %e, "history ingest task failed"),
    }
    Some(has_power)
}

/// Probes the dish and publishes capabilities.
async fn detect_capabilities(
    state: &AppState,
    sink: &Arc<dyn EventSink>,
    client: &Arc<dyn StarlinkClient>,
    router_available: bool,
    session_id: u64,
) {
    let status = client.get_status().await.ok();
    let snow_melt_configurable = status.as_ref().is_some_and(|s| s.snow_melt_configurable);
    let history_has_power = ingest_history(state, client).await;
    let obstruction_map = if status.is_some() {
        Probe::from_result(&client.get_obstruction_map().await)
    } else {
        Probe::Unknown
    };
    let mut caps = capabilities::detect(&CapabilityInputs {
        status,
        request_names: client.request_names(),
        history_has_power,
        obstruction_map,
        router_available,
        is_mock: client.is_mock(),
    });
    state.apply_write_denials(&mut caps);
    if snow_melt_configurable {
        caps.snow_melt_mode = client.get_snow_melt_mode().await.ok().flatten();
    }
    tracing::info!(
        hardware = caps.hardware_version.as_deref().unwrap_or("unknown"),
        actuators = ?caps.actuators,
        mock = caps.is_mock,
        "capabilities detected"
    );
    if state.set_capabilities(session_id, caps.clone()).await {
        sink.capabilities(&caps);
    }
}

async fn session(state: &Arc<AppState>, settings: &Settings, sink: &Arc<dyn EventSink>) {
    // Drop the previous client and its capabilities before anything else (no write can be
    // authorized by stale capabilities of another dish or of the mock).
    // A reconnect or real/mock switch ends alignment mode.
    crate::alignment::stop(state).await;
    let session_id = state.begin_session().await;
    // Another dish address: its uptime/bootcount must not be compared with the old dish.
    let address_changed = {
        let mut addr = state
            .notified_dish_address
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let changed = addr.as_deref() != Some(settings.dish_address.as_str());
        *addr = Some(settings.dish_address.clone());
        changed
    };
    if address_changed {
        state
            .notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .forget_dish();
    }
    sink.capabilities(&state.capabilities.read().await.clone());
    set_status(state, sink, |s| {
        s.state = ConnectionState::Connecting;
        s.dish_address = settings.dish_address.clone();
    })
    .await;

    let mut fallback_reason: Option<String> = None;
    let (client, router): (Arc<dyn StarlinkClient>, Option<Arc<dyn RouterClient>>) =
        match settings.mock_mode {
            MockMode::On => {
                let mock = Arc::new(MockClient::new(settings.mock_profile));
                prepare_mock_db(state, mock.clone()).await;
                let router = mock
                    .has_router()
                    .then(|| mock.clone() as Arc<dyn RouterClient>);
                (mock, router)
            }
            MockMode::Off | MockMode::Auto => match connect_real(state, settings).await {
                Ok(real) => {
                    tracing::info!("connected to dish");
                    let router = connect_router(state, settings).await;
                    (Arc::new(real), router)
                }
                Err(e) if settings.mock_mode == MockMode::Auto => {
                    tracing::info!(error = %e, "dish unreachable, falling back to mock data");
                    report_unreachable(state, sink).await;
                    fallback_reason = Some(format!("Dish not reachable ({e}); showing mock data"));
                    let mock = Arc::new(MockClient::new(settings.mock_profile));
                    prepare_mock_db(state, mock.clone()).await;
                    let router = mock
                        .has_router()
                        .then(|| mock.clone() as Arc<dyn RouterClient>);
                    (mock, router)
                }
                Err(e) => {
                    tracing::info!(error = %e, "dish unreachable");
                    report_unreachable(state, sink).await;
                    set_status(state, sink, |s| {
                        s.state = ConnectionState::Offline;
                        s.router_available = false;
                        s.last_error = Some(e.to_string());
                    })
                    .await;
                    tokio::time::sleep(OFFLINE_RETRY).await;
                    return;
                }
            },
        };

    *state.client.write().await = Some(client.clone());
    *state.snapshot.write().await = None;
    *state.power_cache.write().await = None;
    let mut router = router;
    detect_capabilities(state, sink, &client, router.is_some(), session_id).await;
    check_data_cap(state, sink, client.is_mock()).await;
    set_status(state, sink, |s| {
        s.router_available = router.is_some();
        s.last_error = fallback_reason.clone();
    })
    .await;

    let auto_fallback = fallback_reason.is_some();
    // Live polling runs in its own task so slow work below (history ingest, router and
    // real-dish reconnect attempts) never delays `telemetry` events.
    let mut live = AbortOnDrop(tokio::spawn(live_poll(
        state.clone(),
        sink.clone(),
        client.clone(),
        Duration::from_secs(settings.live_poll_interval_s.max(1) as u64),
        auto_fallback,
    )));

    let mut history = interval_at(Instant::now() + HISTORY_PERIOD, HISTORY_PERIOD);
    history.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut router_tick = interval(ROUTER_PERIOD);
    router_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut real_retry = interval_at(Instant::now() + REAL_RETRY_PERIOD, REAL_RETRY_PERIOD);
    let mut router_misses = 0u32;
    let mut router_backoff = ROUTER_PERIOD;
    let mut next_router_attempt = Instant::now() + router_backoff;

    loop {
        tokio::select! {
            _ = &mut live.0 => {
                // The real dish stopped answering: reconnect (Auto mode falls back to mock).
                return;
            }
            _ = history.tick() => {
                ingest_history(state, &client).await;
                check_data_cap(state, sink, client.is_mock()).await;
            }
            _ = router_tick.tick() => {
                if let Some(r) = router.clone() {
                    match r.wifi_clients().await {
                        Ok(clients) => {
                            router_misses = 0;
                            *state.wifi_clients.write().await = clients;
                        }
                        Err(e) => {
                            router_misses += 1;
                            if router_misses >= 3 {
                                tracing::info!(error = %e, "router lost");
                                router = None;
                                state.wifi_clients.write().await.clear();
                                state.capabilities.write().await.has_router = false;
                                let caps = state.capabilities.read().await.clone();
                                sink.capabilities(&caps);
                                set_status(state, sink, |s| s.router_available = false).await;
                            }
                        }
                    }
                } else if !client.is_mock() && Instant::now() >= next_router_attempt {
                    let Some(r) = connect_router(state, settings).await else {
                        // Exponential backoff: 60 s -> 30 min.
                        router_backoff = next_router_backoff(router_backoff);
                        next_router_attempt = Instant::now() + router_backoff;
                        continue;
                    };
                    tracing::info!("router became available");
                    router = Some(r);
                    router_misses = 0;
                    router_backoff = ROUTER_PERIOD;
                    state.capabilities.write().await.has_router = true;
                    let caps = state.capabilities.read().await.clone();
                    sink.capabilities(&caps);
                    set_status(state, sink, |s| s.router_available = true).await;
                }
            }
            _ = real_retry.tick(), if auto_fallback => {
                if connect_real(state, settings).await.is_ok() {
                    tracing::info!("real dish reachable again, leaving mock mode");
                    return;
                }
                report_unreachable(state, sink).await;
            }
        }
    }
}

/// Aborts the wrapped task when the session ends (also when the session future is dropped
/// because of a reconnect).
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

const DATA_CAP_META_KEY: &str = "data_cap_notified";

/// Restores which data-cap level was already notified in the current cycle (survives restarts).
async fn restore_data_cap_level(state: &AppState) {
    let db = state.db.clone();
    let stored = tokio::task::spawn_blocking(move || lock_db(&db).meta_get(DATA_CAP_META_KEY))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    if let Some((start, level)) = stored.as_deref().and_then(|s| s.split_once(':'))
        && let (Ok(start), Ok(level)) = (start.parse::<i64>(), level.parse::<u8>())
    {
        state
            .notifier
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .set_data_cap_level(start, level);
    }
}

/// Filters candidate notifications (settings, quiet hours, cooldown, mock) and shows them.
async fn deliver(
    state: &AppState,
    sink: &Arc<dyn EventSink>,
    candidates: Vec<Notification>,
    is_mock: bool,
) {
    if candidates.is_empty() {
        return;
    }
    let settings = state.settings.read().await.notifications.clone();
    let now = now_ms();
    let hour = crate::usage::local_hour(now, &chrono::Local);
    let shown = state
        .notifier
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .filter(candidates, &settings, now, hour, is_mock);
    for n in &shown {
        tracing::info!(kind = ?n.kind, "notification shown");
        sink.notify(n);
    }
}

/// Records that the real dish did not answer; notifies after a few minutes.
async fn report_unreachable(state: &AppState, sink: &Arc<dyn EventSink>) {
    let candidates = state
        .notifier
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .observe_unreachable(now_ms());
    deliver(state, sink, candidates, false).await;
}

/// Compares the billing-cycle usage estimate with the cap (real dish only).
pub async fn check_data_cap(state: &AppState, sink: &Arc<dyn EventSink>, is_mock: bool) {
    if is_mock {
        return;
    }
    let settings = state.settings.read().await.clone();
    let Some(cap) = settings.data_cap_gb else {
        return;
    };
    let now = now_ms();
    let start = crate::usage::cycle_start_ms(now, settings.billing_cycle_day, &chrono::Local);
    let db = state.db.clone();
    let start_key = crate::usage::date_key(crate::usage::local_date(start, &chrono::Local));
    let Ok(Ok(rows)) =
        tokio::task::spawn_blocking(move || lock_db(&db).usage_since(start_key)).await
    else {
        return;
    };
    let used: f64 = rows.iter().map(|r| r.download_bytes + r.upload_bytes).sum();
    let (candidates, level) = {
        let mut engine = state.notifier.lock().unwrap_or_else(|p| p.into_inner());
        let c = engine.observe_usage(start, used, Some(cap));
        (c, engine.data_cap_level())
    };
    if !candidates.is_empty()
        && let Some((s, l)) = level
    {
        let db = state.db.clone();
        let value = format!("{s}:{l}");
        let _ =
            tokio::task::spawn_blocking(move || lock_db(&db).meta_set(DATA_CAP_META_KEY, &value))
                .await;
    }
    deliver(state, sink, candidates, false).await;
}

/// Latest power from the cache filled by the history ingest (no network call, so telemetry
/// is never delayed). Dropped once older than [`POWER_STALE`].
async fn cached_power(state: &AppState) -> Option<f64> {
    let now = now_ms();
    state
        .power_cache
        .read()
        .await
        .filter(|(_, at)| now - at < POWER_STALE.as_millis() as i64)
        .and_then(|(p, _)| p)
}

/// Next router reconnect delay: doubles after each failure, capped at [`ROUTER_BACKOFF_MAX`].
pub fn next_router_backoff(current: Duration) -> Duration {
    (current * 2).min(ROUTER_BACKOFF_MAX)
}

/// Polls `get_status` and emits `telemetry` on every success. Returns when a real dish fails
/// [`MAX_POLL_FAILURES`] times in a row; runs forever for the mock.
async fn live_poll(
    state: Arc<AppState>,
    sink: Arc<dyn EventSink>,
    client: Arc<dyn StarlinkClient>,
    period: Duration,
    auto_fallback: bool,
) {
    let mut failures = 0u32;
    let mut last_throttle_minute = i64::MIN;
    let mut last_alignment_event = now_ms();
    let mut first = true;
    loop {
        // Alignment mode switches to 1 s polling; a mode change wakes the wait at once.
        let aligning = crate::alignment::tick(&state, &mut last_alignment_event).await;
        if !first {
            let wait = crate::alignment::poll_period(period, aligning);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = state.alignment_changed.notified() => {}
            }
        }
        first = false;
        match client.get_status().await {
            Ok(st) => {
                failures = 0;
                let mut snap = st.snapshot;
                snap.power_w = cached_power(&state).await;
                *state.snapshot.write().await = Some(snap.clone());
                sink.telemetry(&snap);
                // Notifications describe the real dish only; mock data never feeds the engine.
                if !client.is_mock() {
                    let candidates = state
                        .notifier
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .observe(&Observation {
                            now_ms: snap.timestamp_ms,
                            snapshot: Some(&snap),
                            outage_cause: st.current_outage_cause.as_deref(),
                            bootcount: st.bootcount,
                        });
                    deliver(&state, &sink, candidates, false).await;
                }
                let throttled = [
                    &snap.dl_bandwidth_restricted_reason,
                    &snap.ul_bandwidth_restricted_reason,
                ]
                .iter()
                .any(|r| r.as_deref() == Some("POLICY_LIMIT"));
                let minute = crate::time::minute_floor(snap.timestamp_ms);
                if throttled && minute != last_throttle_minute {
                    last_throttle_minute = minute;
                    let db = state.db_for(client.is_mock());
                    let ts = snap.timestamp_ms;
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Err(e) = lock_db(&db).mark_throttled(ts) {
                            tracing::debug!(error = %e, "could not record throttled minute");
                        }
                    })
                    .await;
                }
                let target = if client.is_mock() {
                    ConnectionState::Mock
                } else {
                    ConnectionState::Connected
                };
                let ts = snap.timestamp_ms;
                set_status(&state, &sink, |s| {
                    s.state = target;
                    s.last_success_ms = Some(ts);
                    if !auto_fallback {
                        s.last_error = None;
                    }
                })
                .await;
            }
            Err(e) => {
                failures += 1;
                tracing::debug!(error = %e, failures, "get_status failed");
                if !client.is_mock() && e.is_connectivity() {
                    report_unreachable(&state, &sink).await;
                }
                if client.is_mock() || failures >= MAX_POLL_FAILURES {
                    set_status(&state, &sink, |s| {
                        s.state = ConnectionState::Offline;
                        s.last_error = Some(e.to_string());
                    })
                    .await;
                }
                if !client.is_mock() && failures >= MAX_POLL_FAILURES {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DishCapabilities, MockProfile, TelemetrySnapshot};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        telemetry: Mutex<Vec<TelemetrySnapshot>>,
        status: Mutex<Vec<ConnectionStatus>>,
        caps: Mutex<Vec<DishCapabilities>>,
        notes: Mutex<Vec<crate::notify::Notification>>,
        align: Mutex<Vec<crate::models::AlignmentModeEvent>>,
    }

    impl EventSink for Recorder {
        fn notify(&self, n: &crate::notify::Notification) {
            self.notes.lock().unwrap().push(n.clone());
        }
        fn alignment_mode(&self, e: &crate::models::AlignmentModeEvent) {
            self.align.lock().unwrap().push(*e);
        }
        fn telemetry(&self, s: &TelemetrySnapshot) {
            self.telemetry.lock().unwrap().push(s.clone());
        }
        fn connection_status(&self, s: &ConnectionStatus) {
            self.status.lock().unwrap().push(s.clone());
        }
        fn capabilities(&self, c: &DishCapabilities) {
            self.caps.lock().unwrap().push(c.clone());
        }
    }

    async fn wait_for(cond: impl Fn() -> bool) {
        for _ in 0..100 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test]
    async fn mock_session_emits_events_and_reconnects_on_settings_change() {
        let settings = Settings {
            mock_mode: MockMode::On,
            mock_profile: MockProfile::StandardActuated,
            live_poll_interval_s: 1,
            ..Default::default()
        };
        let state = Arc::new(AppState::in_memory(settings.clone()).unwrap());
        let rec = Arc::new(Recorder::default());
        let sink: Arc<dyn EventSink> = rec.clone();
        let task = tokio::spawn(run(state.clone(), sink));

        wait_for(|| !rec.telemetry.lock().unwrap().is_empty()).await;
        // First event is the reset at session start (no write capability).
        let first = rec.caps.lock().unwrap()[0].clone();
        assert!(!first.can_stow && !first.can_reboot && !first.can_set_snow_melt);
        let caps = rec.caps.lock().unwrap().last().cloned().unwrap();
        assert!(caps.is_mock);
        assert_eq!(
            rec.telemetry.lock().unwrap()[0].power_w,
            None,
            "no power on this profile"
        );
        assert!(caps.can_stow);
        assert!(!caps.has_router);
        assert!(!caps.has_power_telemetry);
        assert!(caps.has_obstruction_map);
        assert_eq!(caps.snow_melt_mode, Some(crate::models::SnowMeltMode::Auto));
        assert_eq!(state.status.read().await.state, ConnectionState::Mock);
        // Mock history was backfilled into the mock DB only.
        assert!(!lock_db(&state.mock_db).is_empty().unwrap());
        assert!(lock_db(&state.db).is_empty().unwrap());

        // Switching profile reconnects with the new capabilities.
        let new = Settings {
            mock_profile: MockProfile::Offline,
            ..settings
        };
        state.update_settings(new).await.unwrap();
        wait_for(|| {
            rec.status
                .lock()
                .unwrap()
                .last()
                .is_some_and(|s| s.state == ConnectionState::Offline)
        })
        .await;
        let caps = rec.caps.lock().unwrap().last().cloned().unwrap();
        assert!(caps.is_mock && !caps.can_reboot);
        task.abort();
    }

    #[test]
    fn router_backoff_doubles_up_to_30_minutes() {
        let mut d = ROUTER_PERIOD;
        let mut seen = vec![d.as_secs()];
        for _ in 0..8 {
            d = next_router_backoff(d);
            seen.push(d.as_secs());
        }
        assert_eq!(seen, vec![60, 120, 240, 480, 960, 1800, 1800, 1800, 1800]);
    }

    #[tokio::test]
    async fn telemetry_carries_power_from_history() {
        let settings = Settings {
            mock_mode: MockMode::On,
            mock_profile: MockProfile::Mini,
            live_poll_interval_s: 1,
            ..Default::default()
        };
        let state = Arc::new(AppState::in_memory(settings).unwrap());
        let rec = Arc::new(Recorder::default());
        let sink: Arc<dyn EventSink> = rec.clone();
        let task = tokio::spawn(run(state.clone(), sink));
        wait_for(|| rec.telemetry.lock().unwrap().len() >= 2).await;
        for snap in rec.telemetry.lock().unwrap().iter() {
            let p = snap.power_w.expect("mini mock reports power");
            assert!((10.0..=60.0).contains(&p), "{p}");
        }
        assert!(state.capabilities.read().await.has_power_telemetry);
        task.abort();
    }

    #[tokio::test]
    async fn mock_session_has_uptime_usage_and_no_notifications() {
        let settings = Settings {
            mock_mode: MockMode::On,
            mock_profile: MockProfile::Mini,
            live_poll_interval_s: 1,
            ..Default::default()
        };
        let state = Arc::new(AppState::in_memory(settings).unwrap());
        let rec = Arc::new(Recorder::default());
        let sink: Arc<dyn EventSink> = rec.clone();
        let task = tokio::spawn(run(state.clone(), sink));
        wait_for(|| !rec.telemetry.lock().unwrap().is_empty()).await;

        let up = crate::commands::uptime_stats(&state).await.unwrap();
        let labels: Vec<&str> = up.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["24h", "7d", "30d"]);
        for w in &up.windows {
            let pct = w.uptime_pct.expect("mock has enough coverage");
            assert!((90.0..=100.0).contains(&pct), "{} {pct}", w.label);
            assert!(w.covered_s <= w.window_s);
        }
        // 24 h backfilled (the oldest minute is cut at the window edge).
        assert!(
            up.windows[0].covered_s >= 86_280.0,
            "{}",
            up.windows[0].covered_s
        );

        let usage = crate::commands::data_usage(&state, 30).await.unwrap();
        assert_eq!(usage.daily.len(), 30);
        assert!(usage.is_estimate);
        assert!(usage.daily.windows(2).all(|w| w[0].day_ms < w[1].day_ms));
        let total_gb: f64 = usage.daily.iter().map(|d| d.download_bytes).sum::<f64>() / 1e9;
        assert!(
            (50.0..=1000.0).contains(&total_gb),
            "{total_gb} GB in 30 days"
        );
        assert!(usage.cycle_download_bytes > 0.0);
        assert!(crate::commands::data_usage(&state, 0).await.is_err());
        assert!(crate::commands::data_usage(&state, 91).await.is_err());

        // Mock mode never shows notifications.
        assert!(rec.notes.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn data_cap_notifies_once_and_persists() {
        let state = AppState::in_memory(Settings {
            data_cap_gb: Some(1.0),
            ..Default::default()
        })
        .unwrap();
        let rec = Arc::new(Recorder::default());
        let sink: Arc<dyn EventSink> = rec.clone();
        let today = crate::usage::date_key(crate::usage::local_date(now_ms(), &chrono::Local));
        let mut usage = std::collections::BTreeMap::new();
        usage.insert(today, (0.7e9, 0.15e9));
        lock_db(&state.db).add_usage(&usage).unwrap();

        check_data_cap(&state, &sink, false).await;
        check_data_cap(&state, &sink, false).await;
        // Mock never checks the cap.
        check_data_cap(&state, &sink, true).await;
        let notes = rec.notes.lock().unwrap().clone();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].kind, crate::notify::NotificationKind::DataCap);
        let stored = lock_db(&state.db)
            .meta_get(DATA_CAP_META_KEY)
            .unwrap()
            .unwrap();
        assert!(stored.ends_with(":80"));

        // After a restart the persisted level prevents a repeat.
        state.notifier.lock().unwrap().reset();
        *state.notifier.lock().unwrap() = crate::notify::NotificationEngine::new();
        restore_data_cap_level(&state).await;
        check_data_cap(&state, &sink, false).await;
        assert_eq!(rec.notes.lock().unwrap().len(), 1);
    }

    async fn start_mock(
        profile: MockProfile,
        poll_s: u32,
    ) -> (Arc<AppState>, Arc<Recorder>, tokio::task::JoinHandle<()>) {
        let state = Arc::new(
            AppState::in_memory(Settings {
                mock_mode: MockMode::On,
                mock_profile: profile,
                live_poll_interval_s: poll_s,
                ..Default::default()
            })
            .unwrap(),
        );
        let rec = Arc::new(Recorder::default());
        let sink: Arc<dyn EventSink> = rec.clone();
        let task = tokio::spawn(run(state.clone(), sink));
        wait_for(|| !rec.telemetry.lock().unwrap().is_empty()).await;
        (state, rec, task)
    }

    #[tokio::test]
    async fn alignment_mode_gating() {
        // Motorized dish: refused.
        let (state, rec, task) = start_mock(MockProfile::StandardActuated, 5).await;
        let e = crate::alignment::set_mode(&state, true).await.unwrap_err();
        assert_eq!(e.kind(), "invalid_input");
        assert!(rec.align.lock().unwrap().is_empty());
        task.abort();
        // Not connected: offline.
        let idle = AppState::in_memory(Settings::default()).unwrap();
        assert_eq!(
            crate::alignment::set_mode(&idle, true)
                .await
                .unwrap_err()
                .kind(),
            "offline"
        );
    }

    #[tokio::test]
    async fn alignment_mode_polls_every_second_and_stops() {
        let (state, rec, task) = start_mock(MockProfile::Mini, 5).await;
        // Normal 5 s interval: no second telemetry soon.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let before = rec.telemetry.lock().unwrap().len();
        assert_eq!(before, 1);

        let ev = crate::alignment::set_mode(&state, true).await.unwrap();
        assert_eq!((ev.enabled, ev.remaining_s), (true, 600));
        assert_eq!(rec.align.lock().unwrap().last().copied(), Some(ev));
        // The wait is interrupted immediately, then 1 s polling.
        wait_for(|| rec.telemetry.lock().unwrap().len() >= before + 3).await;
        let n = rec.telemetry.lock().unwrap().len();
        // The mock dish is being "moved": orientation data with estimator state.
        let last = rec.telemetry.lock().unwrap().last().cloned().unwrap();
        assert!(last.alignment.estimation_state.is_some());

        // Manual stop: event and back to the slow interval.
        crate::alignment::set_mode(&state, false).await.unwrap();
        assert_eq!(
            rec.align.lock().unwrap().last().copied(),
            Some(crate::models::AlignmentModeEvent::default())
        );
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(rec.telemetry.lock().unwrap().len() <= n + 2, "slow again");

        // Auto-off: force the deadline into the past.
        crate::alignment::set_mode(&state, true).await.unwrap();
        let sid = state.session.load(std::sync::atomic::Ordering::SeqCst);
        *state.alignment.lock().unwrap() = Some(crate::alignment::AlignmentSession {
            session_id: sid,
            until_ms: now_ms() - 1,
        });
        state.alignment_changed.notify_one();
        wait_for(|| state.alignment.lock().unwrap().is_none()).await;
        assert!(!rec.align.lock().unwrap().last().unwrap().enabled);
        task.abort();
    }

    #[tokio::test]
    async fn reconnect_ends_alignment_mode() {
        let (state, rec, task) = start_mock(MockProfile::Mini, 5).await;
        crate::alignment::set_mode(&state, true).await.unwrap();
        let s = state.settings.read().await.clone();
        state
            .update_settings(Settings {
                mock_profile: MockProfile::Standard,
                ..s
            })
            .await
            .unwrap();
        wait_for(|| state.alignment.lock().unwrap().is_none()).await;
        let events = rec.align.lock().unwrap().clone();
        assert!(events.first().unwrap().enabled);
        assert!(!events.last().unwrap().enabled);
        task.abort();
    }
}
