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
    /// Current snow-melt mode read from the dish config, if known.
    pub snow_melt_mode: Option<SnowMeltMode>,
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
    /// Latest power draw in watts (`powerIn`, fallback `powerConsumptionW` from history);
    /// `None` when the dish does not report power.
    pub power_w: Option<f64>,
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
    /// Language the advisor should answer in (e.g. "en").
    pub language: String,
    pub window_hours: u32,
    /// Minutes of history available inside the window.
    pub history_minutes: u32,
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
    /// Findings of the built-in rule engine, given to the AI to explain (empty for rules-only).
    pub rule_findings: Vec<AiFinding>,
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
    /// Hide to tray on window close instead of quitting (default false on Linux, where tray
    /// support depends on the desktop environment).
    pub close_to_tray: bool,
    pub notifications: NotificationSettings,
    /// Monthly data cap in GB for usage alerts; `None` = no cap.
    pub data_cap_gb: Option<f64>,
    /// Day of month (1-28) when the billing cycle resets.
    pub billing_cycle_day: u32,
    /// Optional AI explanation provider. Default off.
    pub ai_provider: AiProvider,
    /// Local model server (Ollama / OpenAI-compatible), e.g. `http://localhost:11434`.
    pub local_ai_url: String,
    pub local_ai_kind: LocalAiKind,
    pub local_ai_model: String,
}

/// Desktop notification preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub outage: bool,
    pub obstruction: bool,
    pub thermal: bool,
    pub throttle: bool,
    pub reboot: bool,
    pub firmware_update: bool,
    pub data_cap: bool,
    /// Local hour 0-23; both `None` = no quiet hours.
    pub quiet_start_hour: Option<u8>,
    pub quiet_end_hour: Option<u8>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            outage: true,
            obstruction: true,
            thermal: true,
            throttle: true,
            reboot: true,
            firmware_update: true,
            data_cap: true,
            quiet_start_hour: None,
            quiet_end_hour: None,
        }
    }
}

/// Uptime over one window ("24h" | "7d" | "30d").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UptimeWindow {
    pub label: String,
    pub window_s: f64,
    /// Seconds covered by data (app running / history available).
    pub covered_s: f64,
    /// `None` when coverage is too low to be meaningful.
    pub uptime_pct: Option<f64>,
    pub outage_count: u32,
    pub outage_s: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UptimeStats {
    pub windows: Vec<UptimeWindow>,
}

/// Estimated bytes for one local day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    /// Local midnight, Unix ms.
    pub day_ms: i64,
    pub download_bytes: f64,
    pub upload_bytes: f64,
}

/// Estimated data usage (integrated throughput, not billing data).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataUsage {
    /// Newest last.
    pub daily: Vec<DailyUsage>,
    pub cycle_start_ms: i64,
    pub cycle_download_bytes: f64,
    pub cycle_upload_bytes: f64,
    pub cap_gb: Option<f64>,
    /// Always true: derived from throughput samples, not billing data.
    pub is_estimate: bool,
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
            claude_model: "claude-opus-5-5".into(),
            close_to_tray: !cfg!(target_os = "linux"),
            notifications: NotificationSettings::default(),
            data_cap_gb: None,
            billing_cycle_day: 1,
            ai_provider: AiProvider::Off,
            local_ai_url: "http://localhost:11434".into(),
            local_ai_kind: LocalAiKind::Ollama,
            local_ai_model: String::new(),
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

/// Category of an AI advisor finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiFindingCategory {
    Wifi,
    Obstruction,
    StarlinkNetwork,
    Hardware,
    Power,
    Configuration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiOverallHealth {
    Good,
    Fair,
    Poor,
}

/// One recommendation from the AI advisor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFinding {
    pub category: AiFindingCategory,
    pub severity: AiSeverity,
    pub title: String,
    pub detail: String,
    pub actions: Vec<String>,
}

/// Who produced a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReportSource {
    Rules,
    /// Default for reports stored before Phase 4.6 (they all came from Claude).
    #[default]
    Claude,
    Local,
}

/// Optional AI explanation provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AiProvider {
    #[default]
    Off,
    Claude,
    Local,
}

/// Local model server API flavour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LocalAiKind {
    #[default]
    Ollama,
    OpenaiCompatible,
}

/// Diagnosis report (rule engine, Claude or local model), persisted as the last report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReport {
    pub generated_at_ms: i64,
    /// Who produced the report: built-in rule engine, Claude API, or a local model.
    #[serde(default)]
    pub source: ReportSource,
    /// Model that produced the report (may differ from the requested one after a fallback).
    pub model: String,
    pub overall_health: AiOverallHealth,
    pub headline: String,
    pub findings: Vec<AiFinding>,
    /// Exact anonymized payload that was sent.
    pub payload: DiagnosticSummary,
}

/// Error returned by every Tauri command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    /// "offline" | "unsupported" | "read_only" | "timeout" | "invalid_input" | "keyring" |
    /// "internal" | "no_api_key" | "ai_auth" | "ai_rate_limit" | "ai_unavailable" |
    /// "ai_refused" | "ai_invalid_response" | "insufficient_data"
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
        assert!(
            v.get("obstruction")
                .unwrap()
                .get("fractionObstructed")
                .is_some()
        );
    }

    #[test]
    fn actuator_support_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ActuatorSupport::No).unwrap(),
            "\"no\""
        );
    }
}
