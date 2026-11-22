//! Shared data structures exchanged between the Rust backend and the React frontend.
//!
//! Every telemetry field is optional: dish models and firmware versions differ, and
//! proto3 omits zero/false/empty values. Absent data must never cause an error.
//! These types intentionally contain no device IDs, MAC addresses or GPS coordinates.
//!
//! Keep in sync with `src/types/models.ts`.

use serde::{Deserialize, Serialize};

/// Whether the dish has motors (actuators) for self-orientation and stow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ActuatorSupport {
    Yes,
    No,
    #[default]
    Unknown,
}

/// Features available on the connected dish, detected at runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DishCapabilities {
    pub hardware_version: Option<String>,
    pub software_version: Option<String>,
    pub actuators: ActuatorSupport,
    pub can_stow: bool,
    pub can_reboot: bool,
    pub can_set_snow_melt: bool,
    pub has_obstruction_map: bool,
    pub has_power_telemetry: bool,
    pub has_alignment_stats: bool,
    pub has_router: bool,
    /// True when data comes from the built-in mock client instead of a real dish.
    pub is_mock: bool,
}

/// Obstruction summary from `get_status.obstructionStats`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObstructionStats {
    /// Fraction of sky obstructed, 0.0..=1.0.
    pub fraction_obstructed: Option<f64>,
    /// Fraction of time obstructed, 0.0..=1.0.
    pub time_obstructed: Option<f64>,
    /// Seconds of valid data behind the statistics (low = unreliable).
    pub valid_s: Option<f64>,
    pub currently_obstructed: Option<bool>,
    /// Average prolonged obstruction interval; NaN from the dish is mapped to `None`.
    pub avg_prolonged_obstruction_interval_s: Option<f64>,
}

/// Dish orientation vs. the orientation recommended by the dish.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentStats {
    pub azimuth_deg: Option<f64>,
    pub elevation_deg: Option<f64>,
    pub desired_azimuth_deg: Option<f64>,
    pub desired_elevation_deg: Option<f64>,
    pub tilt_angle_deg: Option<f64>,
    pub uncertainty_deg: Option<f64>,
}

/// Live snapshot from `get_status`, polled every few seconds and not persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    /// Unix epoch milliseconds when the snapshot was taken.
    pub timestamp_ms: i64,
    pub uptime_s: Option<u64>,
    pub downlink_bps: Option<f64>,
    pub uplink_bps: Option<f64>,
    pub pop_ping_latency_ms: Option<f64>,
    /// 0.0..=1.0 (absent from the dish when 0).
    pub pop_ping_drop_rate: Option<f64>,
    pub snr_above_noise_floor: Option<bool>,
    /// 0.0..=1.0
    pub signal_quality: Option<f64>,
    pub obstruction: ObstructionStats,
    pub alignment: AlignmentStats,
    pub gps_valid: Option<bool>,
    pub gps_sats: Option<u32>,
    /// e.g. "POLICY_LIMIT", "NO_LIMIT".
    pub dl_bandwidth_restricted_reason: Option<String>,
    pub ul_bandwidth_restricted_reason: Option<String>,
    pub software_update_state: Option<String>,
    pub disablement_code: Option<String>,
    /// Names of active alerts (e.g. "thermalThrottle"); empty when none.
    pub alerts: Vec<String>,
    pub is_heating: Option<bool>,
}

/// One per-minute aggregate derived from `get_history` and stored in SQLite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    /// Unix epoch milliseconds at the start of the minute.
    pub minute_ms: i64,
    pub samples: u32,
    pub latency_avg_ms: Option<f64>,
    pub latency_p95_ms: Option<f64>,
    pub latency_max_ms: Option<f64>,
    pub drop_rate_avg: Option<f64>,
    pub downlink_avg_bps: Option<f64>,
    pub downlink_max_bps: Option<f64>,
    pub uplink_avg_bps: Option<f64>,
    pub uplink_max_bps: Option<f64>,
    pub power_avg_w: Option<f64>,
    pub power_max_w: Option<f64>,
}

/// Outage or event from `get_history.outages` / `eventLog`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DishEvent {
    /// Unix epoch milliseconds.
    pub start_ms: i64,
    pub duration_ms: i64,
    /// e.g. "OBSTRUCTED", "NO_DOWNLINK", "BOOTING", "SKY_SEARCH".
    pub cause: String,
    /// e.g. "WARNING", "ADVISORY"; `None` for raw outages.
    pub severity: Option<String>,
}

/// Compact anomaly summary of the last 24 h, sent to the AI advisor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSummary {
    pub window_hours: u32,
    pub hardware_version: Option<String>,
    pub software_version: Option<String>,
    pub latency_avg_ms: Option<f64>,
    pub latency_p95_ms: Option<f64>,
    pub drop_rate_avg: Option<f64>,
    pub fraction_obstructed: Option<f64>,
    pub outage_count: u32,
    pub outage_total_s: f64,
    /// Outage seconds grouped by cause.
    pub outages_by_cause: Vec<(String, f64)>,
    /// Hours of day (0-23, local time) with the worst latency/drop rate.
    pub worst_hours: Vec<u8>,
    pub throttled_minutes: u32,
    pub alignment_delta_azimuth_deg: Option<f64>,
    pub alignment_delta_elevation_deg: Option<f64>,
    /// Weakest Wi-Fi client signal in dBm, if a Starlink router is present.
    pub weakest_wifi_signal_dbm: Option<f64>,
}

/// Connection state of the dish client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    #[default]
    Connecting,
    Connected,
    Offline,
    Mock,
}

/// Emitted on the `connection-status` event and returned by `get_connection_status`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub dish_address: String,
    pub router_available: bool,
    /// Human-readable last error (no sensitive data).
    pub last_error: Option<String>,
    /// Unix epoch milliseconds of last successful dish response.
    pub last_success_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MockMode {
    /// Use the real dish, fall back to mock when unreachable.
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MockProfile {
    #[default]
    Mini,
    Standard,
    StandardActuated,
    Obstructed,
    Throttled,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SnowMeltMode {
    #[default]
    Auto,
    AlwaysOn,
    AlwaysOff,
}

/// User settings persisted in `app_data_dir/settings.json` (never contains the API key).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub dish_address: String,
    pub router_address: String,
    /// When true, all write commands are rejected. Default ON.
    pub read_only: bool,
    pub mock_mode: MockMode,
    pub mock_profile: MockProfile,
    pub live_poll_interval_s: u32,
    pub claude_model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            dish_address: "192.168.100.1:9200".into(),
            router_address: "192.168.1.1:9000".into(),
            read_only: true,
            mock_mode: MockMode::Auto,
            mock_profile: MockProfile::Mini,
            live_poll_interval_s: 3,
            claude_model: "claude-sonnet-5-5".into(),
        }
    }
}

/// Obstruction map from `dish_get_obstruction_map`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ObstructionMap {
    pub rows: u32,
    pub cols: u32,
    pub min_elevation_deg: Option<f64>,
    pub max_theta_deg: Option<f64>,
    pub reference_frame: Option<String>,
    /// Row-major values 0.0..=1.0; `None` where the dish reports no data (-1).
    pub snr: Vec<Option<f32>>,
}

/// Error returned by every Tauri command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// "offline" | "unsupported" | "read_only" | "timeout" | "invalid_input" | "keyring" | "internal"
    pub kind: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_serializes_camel_case_and_nulls() {
        let s = TelemetrySnapshot::default();
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("popPingLatencyMs").unwrap().is_null());
        assert!(v.get("obstruction").unwrap().get("fractionObstructed").is_some());
    }

    #[test]
    fn actuator_support_serializes_snake_case() {
        assert_eq!(serde_json::to_string(&ActuatorSupport::No).unwrap(), "\"no\"");
    }
}
