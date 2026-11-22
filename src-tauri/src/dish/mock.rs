//! Deterministic, realistic mock dish used in Mock Mode and in tests.
//!
//! Values are derived from a hash of the wall-clock second, so repeated calls return a
//! consistent ring buffer (the same second always has the same latency) while still looking
//! noisy. Write commands only change in-memory state and are recorded for assertions.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;

use super::{
    DeviceInfo, DishHistory, DishStatus, RouterClient, StarlinkClient, WifiClientInfo, WriteAction,
};
use crate::error::ClientError;
use crate::models::{
    ActuatorSupport, AlignmentStats, DishEvent, MockProfile, ObstructionMap, ObstructionStats,
    SnowMeltMode, TelemetrySnapshot,
};
use crate::storage::Sample;
use crate::time::now_ms;

/// Ring buffer length of `get_history`.
pub const HISTORY_LEN: usize = 900;
/// Obstruction map side length.
pub const MAP_SIZE: u32 = 123;
const OUTAGE_BLOCK_S: i64 = 1200;
const BOOT_DURATION_S: i64 = 30;
const MOCK_SOFTWARE_VERSION: &str = "2026.10.17.mock";

/// Requests a real dish lists in its schema regardless of model (subset).
const MOCK_REQUESTS: &[&str] = &[
    "reboot",
    "get_status",
    "get_history",
    "get_device_info",
    "get_diagnostics",
    "dish_stow",
    "dish_get_obstruction_map",
    "dish_get_config",
    "dish_set_config",
    "wifi_get_clients",
    "speed_test",
];

#[derive(Debug, Clone, Copy)]
struct Params {
    hardware_version: &'static str,
    actuators: ActuatorSupport,
    has_router: bool,
    power_w: Option<f64>,
    base_latency: f64,
    jitter: f64,
    drop_prob: f64,
    outage_prob: f64,
    outage_max_s: f64,
    outage_cause: &'static str,
    dl_mean_bps: f64,
    ul_mean_bps: f64,
    fraction_obstructed: f64,
    throttled: bool,
    offline: bool,
}

fn params(profile: MockProfile) -> Params {
    let base = Params {
        hardware_version: "mini1_prod2",
        actuators: ActuatorSupport::No,
        has_router: true,
        power_w: Some(28.0),
        base_latency: 28.0,
        jitter: 5.0,
        drop_prob: 0.004,
        outage_prob: 0.15,
        outage_max_s: 6.0,
        outage_cause: "NO_DOWNLINK",
        dl_mean_bps: 6_000_000.0,
        ul_mean_bps: 600_000.0,
        fraction_obstructed: 0.004,
        throttled: false,
        offline: false,
    };
    match profile {
        MockProfile::Mini => base,
        MockProfile::Standard => Params {
            hardware_version: "rev4_prod1",
            power_w: Some(55.0),
            base_latency: 26.0,
            dl_mean_bps: 12_000_000.0,
            ul_mean_bps: 1_200_000.0,
            ..base
        },
        MockProfile::StandardActuated => Params {
            hardware_version: "rev3_proto2",
            actuators: ActuatorSupport::Yes,
            // Third-party router and no power telemetry: exercises the "hidden" UI paths.
            has_router: false,
            power_w: None,
            base_latency: 32.0,
            jitter: 7.0,
            dl_mean_bps: 10_000_000.0,
            ul_mean_bps: 1_000_000.0,
            ..base
        },
        MockProfile::Obstructed => Params {
            hardware_version: "rev4_prod1",
            power_w: Some(52.0),
            base_latency: 36.0,
            jitter: 12.0,
            drop_prob: 0.03,
            outage_prob: 0.8,
            outage_max_s: 25.0,
            outage_cause: "OBSTRUCTED",
            fraction_obstructed: 0.12,
            ..base
        },
        MockProfile::Throttled => Params {
            base_latency: 45.0,
            jitter: 15.0,
            drop_prob: 0.01,
            dl_mean_bps: 700_000.0,
            ul_mean_bps: 250_000.0,
            throttled: true,
            ..base
        },
        MockProfile::Offline => Params {
            offline: true,
            ..base
        },
    }
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// Deterministic uniform value in `[0, 1)`.
fn unit(x: i64, salt: u64) -> f64 {
    let h = splitmix64((x as u64) ^ splitmix64(salt));
    (h >> 11) as f64 / (1u64 << 53) as f64
}

/// Approximately normal, mean 0, stddev ~1.
fn gauss(x: i64, salt: u64) -> f64 {
    (unit(x, salt) + unit(x, salt + 101) + unit(x, salt + 202) - 1.5) * 2.0
}

/// Mutable mock state.
#[derive(Debug)]
struct State {
    /// Wall-clock second at which the mock dish "booted" (counter 0).
    boot_s: i64,
    stowed: bool,
    snow_melt: SnowMeltMode,
}

/// Mock dish and router.
#[derive(Debug)]
pub struct MockClient {
    profile: MockProfile,
    p: Params,
    state: Mutex<State>,
    writes: Mutex<Vec<WriteAction>>,
    /// Simulates recent firmware that rejects local writes with `PermissionDenied`.
    deny_writes: AtomicBool,
    /// Error every write fails with (tests), after `deny_writes`.
    write_error: Mutex<Option<ClientError>>,
}

impl MockClient {
    pub fn new(profile: MockProfile) -> Self {
        // Pretend the dish has been up for ~4 hours.
        let boot_s = now_ms() / 1000 - 4 * 3600 - 17;
        Self {
            profile,
            p: params(profile),
            state: Mutex::new(State {
                boot_s,
                stowed: false,
                snow_melt: SnowMeltMode::Auto,
            }),
            writes: Mutex::new(Vec::new()),
            deny_writes: AtomicBool::new(false),
            write_error: Mutex::new(None),
        }
    }

    /// When enabled, every write fails with `PermissionDenied` (state unchanged).
    pub fn set_deny_writes(&self, deny: bool) {
        self.deny_writes.store(deny, Ordering::Relaxed);
    }

    /// Makes every write fail with `err` (`None` = normal behaviour).
    pub fn set_write_error(&self, err: Option<ClientError>) {
        if let Ok(mut w) = self.write_error.lock() {
            *w = err;
        }
    }

    pub fn profile(&self) -> MockProfile {
        self.profile
    }

    pub fn has_router(&self) -> bool {
        self.p.has_router && !self.p.offline
    }

    /// Write actions accepted so far (for tests).
    pub fn writes(&self) -> Vec<WriteAction> {
        self.writes.lock().map(|w| w.clone()).unwrap_or_default()
    }

    pub fn snow_melt(&self) -> SnowMeltMode {
        self.state.lock().map(|s| s.snow_melt).unwrap_or_default()
    }

    pub fn is_stowed(&self) -> bool {
        self.state.lock().map(|s| s.stowed).unwrap_or(false)
    }

    fn boot_s(&self) -> i64 {
        self.state.lock().map(|s| s.boot_s).unwrap_or(0)
    }

    fn check_online(&self) -> Result<(), ClientError> {
        if self.p.offline {
            Err(ClientError::Unreachable("mock dish offline".into()))
        } else {
            Ok(())
        }
    }

    /// Outage cause at wall second `t`, if any.
    fn outage_at(&self, t: i64, boot_s: i64) -> Option<&'static str> {
        if (boot_s..boot_s + BOOT_DURATION_S).contains(&t) {
            return Some("BOOTING");
        }
        let (start, dur) = self.block_outage(t.div_euclid(OUTAGE_BLOCK_S))?;
        (start..start + dur)
            .contains(&t)
            .then_some(self.p.outage_cause)
    }

    /// Outage `(start_s, duration_s)` inside a 20-minute block, if the block has one.
    fn block_outage(&self, block: i64) -> Option<(i64, i64)> {
        if unit(block, 1) >= self.p.outage_prob {
            return None;
        }
        let start = block * OUTAGE_BLOCK_S + (unit(block, 2) * (OUTAGE_BLOCK_S - 60) as f64) as i64;
        let dur = 1 + (unit(block, 3) * self.p.outage_max_s) as i64;
        Some((start, dur))
    }

    /// Synthetic per-second sample at wall second `t`.
    fn sample_at(&self, t: i64, boot_s: i64) -> Sample {
        let p = &self.p;
        let power = p.power_w.map(|w| (w + 2.5 * gauss(t, 50)).max(0.0));
        if self.outage_at(t, boot_s).is_some() {
            return Sample {
                ts_s: t,
                latency_ms: None,
                drop_rate: Some(1.0),
                downlink_bps: Some(0.0),
                uplink_bps: Some(0.0),
                power_w: power,
            };
        }
        // Evening congestion: up to +25 % latency around 21:00 UTC.
        let hour = (t.rem_euclid(86_400)) as f64 / 3600.0;
        let diurnal = 1.0
            + 0.25
                * ((hour - 15.0) / 24.0 * std::f64::consts::TAU)
                    .sin()
                    .max(0.0);
        let mut latency = p.base_latency * diurnal + p.jitter * gauss(t, 10);
        if unit(t, 11) < 0.01 {
            latency += 40.0 + 60.0 * unit(t, 12); // occasional spike
        }
        let drop = if unit(t, 20) < p.drop_prob {
            0.05 + 0.6 * unit(t, 21)
        } else {
            0.0
        };
        let burst = if unit(t.div_euclid(30), 30) < 0.08 {
            6.0
        } else {
            1.0
        };
        let mut dl = p.dl_mean_bps * (0.2 + 1.6 * unit(t, 31)) * burst;
        let mut ul = p.ul_mean_bps * (0.2 + 1.6 * unit(t, 32)) * burst.sqrt();
        if p.throttled {
            dl = dl.min(1_000_000.0);
            ul = ul.min(400_000.0);
        }
        Sample {
            ts_s: t,
            latency_ms: Some(latency.clamp(15.0, 600.0)),
            drop_rate: Some(drop),
            downlink_bps: Some(dl),
            uplink_bps: Some(ul),
            power_w: power,
        }
    }

    /// Outages between `from_s` and `to_s` (wall seconds), ascending.
    fn outages_between(&self, from_s: i64, to_s: i64, boot_s: i64) -> Vec<DishEvent> {
        let mut out = Vec::new();
        if (from_s..to_s).contains(&boot_s) {
            out.push(DishEvent {
                start_ms: boot_s * 1000,
                duration_ms: BOOT_DURATION_S * 1000,
                cause: "BOOTING".into(),
                severity: None,
            });
        }
        for block in from_s.div_euclid(OUTAGE_BLOCK_S)..=to_s.div_euclid(OUTAGE_BLOCK_S) {
            if let Some((start, dur)) = self.block_outage(block) {
                let overlaps_boot = start < boot_s + BOOT_DURATION_S && start + dur > boot_s;
                if start >= from_s && start + dur <= to_s && !overlaps_boot {
                    out.push(DishEvent {
                        start_ms: start * 1000 + (unit(block, 4) * 1000.0) as i64,
                        duration_ms: dur * 1000,
                        cause: self.p.outage_cause.into(),
                        severity: None,
                    });
                }
            }
        }
        out.sort_by_key(|e| e.start_ms);
        out
    }

    /// Synthetic samples and outages for the last `hours`, used to backfill the mock database
    /// so history charts have data immediately in Mock Mode.
    pub fn backfill(&self, hours: u32) -> (Vec<Sample>, Vec<DishEvent>) {
        if self.p.offline {
            return (Vec::new(), Vec::new());
        }
        let now_s = now_ms() / 1000;
        let from = now_s - hours as i64 * 3600;
        // Backfill pretends the dish was up the whole time except the current boot.
        let boot_s = self.boot_s();
        let samples = (from..now_s).map(|t| self.sample_at(t, boot_s)).collect();
        (samples, self.outages_between(from, now_s, boot_s))
    }

    fn obstruction_value(&self, row: u32, col: u32) -> Option<f32> {
        let c = (MAP_SIZE as f64 - 1.0) / 2.0;
        let (dx, dy) = (col as f64 - c, c - row as f64);
        let r = (dx * dx + dy * dy).sqrt() / c;
        if r > 1.0 {
            return None;
        }
        let idx = (row * MAP_SIZE + col) as i64;
        // Cells not yet observed by the dish.
        if unit(idx, 70) < 0.35 {
            return None;
        }
        let azimuth = dx.atan2(dy).to_degrees().rem_euclid(360.0);
        let blocked = match self.profile {
            // A tree line to the south-west and low horizon obstructions.
            MockProfile::Obstructed => (200.0..260.0).contains(&azimuth) && r > 0.45 || r > 0.93,
            _ => (230.0..238.0).contains(&azimuth) && r > 0.85,
        };
        let v = if blocked {
            0.25 * unit(idx, 71)
        } else {
            0.85 + 0.15 * unit(idx, 72)
        };
        Some(v as f32)
    }
}

#[async_trait]
impl StarlinkClient for MockClient {
    fn is_mock(&self) -> bool {
        true
    }

    fn request_names(&self) -> Option<Vec<String>> {
        Some(MOCK_REQUESTS.iter().map(|s| s.to_string()).collect())
    }

    async fn get_status(&self) -> Result<DishStatus, ClientError> {
        self.check_online()?;
        let p = &self.p;
        let now = now_ms();
        let now_s = now / 1000;
        let (boot_s, stowed) = self
            .state
            .lock()
            .map(|s| (s.boot_s, s.stowed))
            .map_err(|_| ClientError::Rpc("mock state poisoned".into()))?;
        let s = self.sample_at(now_s - 1, boot_s);
        let outage = self.outage_at(now_s - 1, boot_s);
        let connected = !stowed && outage.is_none();
        let actuated = p.actuators == ActuatorSupport::Yes;
        let alignment = AlignmentStats {
            azimuth_deg: Some(if actuated { 0.4 } else { 9.1 } + 0.05 * gauss(now_s, 80)),
            elevation_deg: Some(if actuated { 65.9 } else { 66.1 } + 0.05 * gauss(now_s, 81)),
            desired_azimuth_deg: Some(if actuated { 0.0 } else { 20.0 }),
            desired_elevation_deg: Some(66.0),
            tilt_angle_deg: Some(if stowed { 90.0 } else { 25.0 }),
            uncertainty_deg: Some(0.5),
        };
        let mut alerts = Vec::new();
        if p.throttled && unit(now_s / 600, 90) < 0.3 {
            alerts.push("thermalThrottle".to_string());
        }
        let restricted = if p.throttled {
            "POLICY_LIMIT"
        } else {
            "NO_LIMIT"
        };
        let snapshot = TelemetrySnapshot {
            timestamp_ms: now,
            uptime_s: Some((now_s - boot_s).max(0) as u64),
            downlink_bps: Some(if connected {
                s.downlink_bps.unwrap_or(0.0)
            } else {
                0.0
            }),
            uplink_bps: Some(if connected {
                s.uplink_bps.unwrap_or(0.0)
            } else {
                0.0
            }),
            power_w: None,
            pop_ping_latency_ms: if connected { s.latency_ms } else { None },
            pop_ping_drop_rate: Some(if connected {
                s.drop_rate.unwrap_or(0.0)
            } else {
                1.0
            }),
            snr_above_noise_floor: Some(connected),
            signal_quality: Some(if connected {
                0.7 + 0.25 * unit(now_s / 10, 60)
            } else {
                0.0
            }),
            obstruction: ObstructionStats {
                fraction_obstructed: Some(p.fraction_obstructed),
                time_obstructed: Some(p.fraction_obstructed / 8.0),
                valid_s: Some(((now_s - boot_s).clamp(0, 43_200)) as f64),
                currently_obstructed: Some(outage == Some("OBSTRUCTED")),
                avg_prolonged_obstruction_interval_s: (self.profile == MockProfile::Obstructed)
                    .then_some(540.0),
            },
            alignment,
            gps_valid: Some(true),
            gps_sats: Some(12 + (unit(now_s / 60, 61) * 5.0) as u32),
            dl_bandwidth_restricted_reason: Some(restricted.into()),
            ul_bandwidth_restricted_reason: Some("NO_LIMIT".into()),
            software_update_state: Some("IDLE".into()),
            disablement_code: Some("OKAY".into()),
            is_heating: Some(self.snow_melt() == SnowMeltMode::AlwaysOn),
            alerts,
        };
        Ok(DishStatus {
            snapshot,
            hardware_version: Some(p.hardware_version.into()),
            software_version: Some(MOCK_SOFTWARE_VERSION.into()),
            bootcount: Some(12),
            actuators: p.actuators,
            has_alignment_stats: true,
            snow_melt_configurable: true,
        })
    }

    async fn get_history(&self) -> Result<DishHistory, ClientError> {
        self.check_online()?;
        let now_s = now_ms() / 1000;
        let boot_s = self.boot_s();
        let current = (now_s - boot_s).max(0) as u64;
        let mut h = DishHistory {
            current,
            latency_ms: vec![Some(0.0); HISTORY_LEN],
            drop_rate: vec![Some(0.0); HISTORY_LEN],
            downlink_bps: vec![Some(0.0); HISTORY_LEN],
            uplink_bps: vec![Some(0.0); HISTORY_LEN],
            power_w: if self.p.power_w.is_some() {
                vec![Some(0.0); HISTORY_LEN]
            } else {
                Vec::new()
            },
            ..Default::default()
        };
        for c in current.saturating_sub(HISTORY_LEN as u64)..current {
            let idx = (c % HISTORY_LEN as u64) as usize;
            let s = self.sample_at(boot_s + c as i64, boot_s);
            h.latency_ms[idx] = s.latency_ms;
            h.drop_rate[idx] = s.drop_rate;
            h.downlink_bps[idx] = s.downlink_bps;
            h.uplink_bps[idx] = s.uplink_bps;
            if let Some(slot) = h.power_w.get_mut(idx) {
                *slot = s.power_w;
            }
        }
        // Like the real dish, outages are reported since boot (bounded to 12 h).
        h.outages = self.outages_between((now_s - 12 * 3600).max(boot_s), now_s, boot_s);
        h.events = h
            .outages
            .iter()
            .map(|o| DishEvent {
                severity: Some(
                    if o.cause == "BOOTING" {
                        "ADVISORY"
                    } else {
                        "WARNING"
                    }
                    .into(),
                ),
                ..o.clone()
            })
            .collect();
        Ok(h)
    }

    async fn get_device_info(&self) -> Result<DeviceInfo, ClientError> {
        self.check_online()?;
        Ok(DeviceInfo {
            hardware_version: Some(self.p.hardware_version.into()),
            software_version: Some(MOCK_SOFTWARE_VERSION.into()),
        })
    }

    async fn get_obstruction_map(&self) -> Result<ObstructionMap, ClientError> {
        self.check_online()?;
        let snr = (0..MAP_SIZE)
            .flat_map(|r| (0..MAP_SIZE).map(move |c| (r, c)))
            .map(|(r, c)| self.obstruction_value(r, c))
            .collect();
        Ok(ObstructionMap {
            rows: MAP_SIZE,
            cols: MAP_SIZE,
            min_elevation_deg: Some(10.0),
            max_theta_deg: Some(80.0),
            reference_frame: Some("FRAME_EARTH".into()),
            snr,
        })
    }

    async fn get_snow_melt_mode(&self) -> Result<Option<SnowMeltMode>, ClientError> {
        self.check_online()?;
        Ok(Some(self.snow_melt()))
    }

    async fn write(&self, action: WriteAction) -> Result<(), ClientError> {
        self.check_online()?;
        if self.deny_writes.load(Ordering::Relaxed) {
            return Err(ClientError::PermissionDenied);
        }
        if let Some(e) = self.write_error.lock().ok().and_then(|w| w.clone()) {
            return Err(e);
        }
        let mut st = self
            .state
            .lock()
            .map_err(|_| ClientError::Rpc("mock state poisoned".into()))?;
        match action {
            WriteAction::Reboot => {
                st.boot_s = now_ms() / 1000;
                st.stowed = false;
            }
            WriteAction::Stow | WriteAction::Unstow => {
                // Like a real non-motorized dish: the request is not implemented.
                if self.p.actuators != ActuatorSupport::Yes {
                    return Err(ClientError::Unsupported);
                }
                st.stowed = action == WriteAction::Stow;
            }
            WriteAction::SetSnowMelt(mode) => st.snow_melt = mode,
        }
        drop(st);
        if let Ok(mut w) = self.writes.lock() {
            w.push(action);
        }
        tracing::info!(?action, "mock write applied");
        Ok(())
    }
}

#[async_trait]
impl RouterClient for MockClient {
    async fn wifi_clients(&self) -> Result<Vec<WifiClientInfo>, ClientError> {
        if !self.has_router() {
            return Err(ClientError::Unreachable("no mock router".into()));
        }
        let now_s = now_ms() / 1000;
        let wifi = |iface: &str, dbm: f64, rate: f64, k: i64| WifiClientInfo {
            iface: Some(iface.into()),
            role: Some("CLIENT".into()),
            signal_strength_dbm: Some((dbm + 2.0 * gauss(now_s / 5 + k, 95)).round()),
            snr: Some((dbm + 95.0).round()),
            channel_width_mhz: Some(if iface == "RF_5GHZ" { 80.0 } else { 20.0 }),
            est_rx_rate_mbps: Some(rate),
            est_tx_rate_mbps: Some(rate * 0.8),
            rx_rate_mbps: Some(rate * 4.0),
            tx_rate_mbps: Some(rate * 3.0),
            associated_time_s: Some(600 + k as u64 * 1800),
            hops_from_controller: Some(1),
        };
        Ok(vec![
            WifiClientInfo {
                iface: Some("ETH".into()),
                role: Some("CONTROLLER".into()),
                ..Default::default()
            },
            wifi("RF_5GHZ", -48.0, 300.0, 1),
            wifi("RF_5GHZ", -63.0, 140.0, 2),
            wifi("RF_2GHZ", -71.0, 40.0, 3),
            wifi("RF_2GHZ", -84.0, 8.0, 4),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn profiles_produce_valid_status() {
        for profile in [
            MockProfile::Mini,
            MockProfile::Standard,
            MockProfile::StandardActuated,
            MockProfile::Obstructed,
            MockProfile::Throttled,
        ] {
            let m = MockClient::new(profile);
            let st = m.get_status().await.unwrap();
            assert!(st.hardware_version.is_some());
            let s = st.snapshot;
            if let Some(l) = s.pop_ping_latency_ms {
                assert!((15.0..=600.0).contains(&l));
            }
            assert!(s.obstruction.fraction_obstructed.unwrap() <= 1.0);
        }
        let st = MockClient::new(MockProfile::Throttled)
            .get_status()
            .await
            .unwrap();
        assert_eq!(
            st.snapshot.dl_bandwidth_restricted_reason.as_deref(),
            Some("POLICY_LIMIT")
        );
        let st = MockClient::new(MockProfile::StandardActuated)
            .get_status()
            .await
            .unwrap();
        assert_eq!(st.actuators, ActuatorSupport::Yes);
    }

    #[tokio::test]
    async fn offline_profile_fails() {
        let m = MockClient::new(MockProfile::Offline);
        assert!(m.get_status().await.unwrap_err().is_connectivity());
        assert!(m.get_history().await.is_err());
        assert!(m.wifi_clients().await.is_err());
    }

    #[tokio::test]
    async fn history_is_a_full_consistent_ring_buffer() {
        let m = MockClient::new(MockProfile::Mini);
        let a = m.get_history().await.unwrap();
        assert_eq!(a.buffer_len(), HISTORY_LEN);
        assert!(a.current > HISTORY_LEN as u64);
        assert!(a.has_power());
        // The last-written slot matches the deterministic sample for that counter.
        let idx = ((a.current - 1) % HISTORY_LEN as u64) as usize;
        let b = m.get_history().await.unwrap();
        if a.current == b.current {
            assert_eq!(a.latency_ms[idx], b.latency_ms[idx]);
        }
        let lat: Vec<f64> = a.latency_ms.iter().flatten().copied().collect();
        let mean = lat.iter().sum::<f64>() / lat.len() as f64;
        assert!((20.0..=60.0).contains(&mean), "mean latency {mean}");
        assert_eq!(a.outages.len(), a.events.len());
        assert!(
            MockClient::new(MockProfile::StandardActuated)
                .get_history()
                .await
                .unwrap()
                .power_w
                .is_empty()
        );
    }

    #[tokio::test]
    async fn obstruction_map_shape() {
        let m = MockClient::new(MockProfile::Obstructed);
        let map = m.get_obstruction_map().await.unwrap();
        assert_eq!(map.snr.len(), (MAP_SIZE * MAP_SIZE) as usize);
        assert!(map.snr[0].is_none(), "corner is outside the sky circle");
        assert!(map.snr.iter().flatten().any(|v| *v < 0.3));
    }

    #[tokio::test]
    async fn writes_are_recorded_and_reboot_resets_counter() {
        let m = MockClient::new(MockProfile::Mini);
        let before = m.get_history().await.unwrap().current;
        m.write(WriteAction::Reboot).await.unwrap();
        let after = m.get_history().await.unwrap().current;
        assert!(after < before);
        assert_eq!(
            m.write(WriteAction::Stow).await,
            Err(ClientError::Unsupported)
        );
        m.write(WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOff))
            .await
            .unwrap();
        assert_eq!(m.snow_melt(), SnowMeltMode::AlwaysOff);
        assert_eq!(
            m.writes(),
            vec![
                WriteAction::Reboot,
                WriteAction::SetSnowMelt(SnowMeltMode::AlwaysOff)
            ]
        );

        let a = MockClient::new(MockProfile::StandardActuated);
        a.write(WriteAction::Stow).await.unwrap();
        assert!(a.is_stowed());
        assert_eq!(
            a.get_status().await.unwrap().snapshot.pop_ping_latency_ms,
            None
        );
        a.write(WriteAction::Unstow).await.unwrap();
        assert!(!a.is_stowed());
    }

    #[test]
    fn backfill_covers_requested_window() {
        let m = MockClient::new(MockProfile::Obstructed);
        let (samples, outages) = m.backfill(2);
        assert_eq!(samples.len(), 7200);
        assert!(!outages.is_empty());
        assert!(outages.windows(2).all(|w| w[0].start_ms <= w[1].start_ms));
    }
}
