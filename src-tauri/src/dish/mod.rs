//! Access to the Starlink dish and router.
//!
//! Every dish access goes through [`StarlinkClient`] so that [`mock::MockClient`] can replace
//! the real [`grpc::GrpcClient`]. Router access (optional) goes through [`RouterClient`].

pub mod grpc;
pub mod json;
pub mod mock;
pub mod reflection;

use async_trait::async_trait;
use serde::Serialize;

use crate::error::ClientError;
use crate::models::{ActuatorSupport, DishEvent, ObstructionMap, SnowMeltMode, TelemetrySnapshot};

/// Parsed `get_status` response (no identifiers).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DishStatus {
    pub snapshot: TelemetrySnapshot,
    pub hardware_version: Option<String>,
    pub software_version: Option<String>,
    pub bootcount: Option<u64>,
    pub actuators: ActuatorSupport,
    /// `alignmentStats` present with at least one boresight value.
    pub has_alignment_stats: bool,
    /// The status `config` exposes snow-melt settings.
    pub snow_melt_configurable: bool,
}

/// Parsed `get_device_info` response (no identifiers).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DeviceInfo {
    pub hardware_version: Option<String>,
    pub software_version: Option<String>,
}

/// Parsed `get_history` response.
///
/// The per-second arrays are ring buffers: the sample with counter `c` is stored at index
/// `c % len`, and `current` is the counter of the next sample to be written.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DishHistory {
    pub current: u64,
    pub latency_ms: Vec<Option<f64>>,
    pub drop_rate: Vec<Option<f64>>,
    pub downlink_bps: Vec<Option<f64>>,
    pub uplink_bps: Vec<Option<f64>>,
    /// `powerIn`, falling back to `powerConsumptionW`; empty when neither is reported.
    pub power_w: Vec<Option<f64>>,
    /// Raw outages (`severity` is `None`).
    pub outages: Vec<DishEvent>,
    /// Outage entries from `eventLog.events` (`EVENT_REASON_OUTAGE_*`), with severity.
    pub events: Vec<DishEvent>,
    /// Other `eventLog.events` entries (not outages).
    pub other_events: Vec<DishEvent>,
}

impl DishHistory {
    /// Ring buffer length (900 on current firmware).
    pub fn buffer_len(&self) -> usize {
        self.latency_ms
            .len()
            .max(self.drop_rate.len())
            .max(self.downlink_bps.len())
            .max(self.uplink_bps.len())
    }

    /// Most recent power sample (counter `current - 1`), if power is reported.
    pub fn latest_power(&self) -> Option<f64> {
        if self.current == 0 || self.power_w.is_empty() || !self.has_power() {
            return None;
        }
        let idx = ((self.current - 1) % self.power_w.len() as u64) as usize;
        self.power_w.get(idx).copied().flatten()
    }

    /// True when at least one power sample is non-zero.
    pub fn has_power(&self) -> bool {
        self.power_w.iter().flatten().any(|w| *w > 0.0)
    }
}

/// Wi-Fi client from the Starlink router, with all PII removed.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiClientInfo {
    /// e.g. "RF_5GHZ", "RF_2GHZ", "ETH".
    pub iface: Option<String>,
    /// e.g. "CLIENT", "REPEATER", "CONTROLLER".
    pub role: Option<String>,
    /// dBm; absent for wired and mesh entries.
    pub signal_strength_dbm: Option<f64>,
    pub snr: Option<f64>,
    pub channel_width_mhz: Option<f64>,
    pub est_rx_rate_mbps: Option<f64>,
    pub est_tx_rate_mbps: Option<f64>,
    pub rx_rate_mbps: Option<f64>,
    pub tx_rate_mbps: Option<f64>,
    pub associated_time_s: Option<u64>,
    pub hops_from_controller: Option<u32>,
}

/// Weakest Wi-Fi signal among wireless clients (mesh/wired entries have no signal).
pub fn weakest_signal_dbm(clients: &[WifiClientInfo]) -> Option<f64> {
    clients
        .iter()
        .filter(|c| c.role.as_deref().is_none_or(|r| r == "CLIENT"))
        .filter_map(|c| c.signal_strength_dbm)
        .min_by(|a, b| a.total_cmp(b))
}

/// State-changing request. Never sent to a real dish during development.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteAction {
    Reboot,
    Stow,
    Unstow,
    SetSnowMelt(SnowMeltMode),
}

/// Abstraction over the dish (real gRPC or mock).
#[async_trait]
pub trait StarlinkClient: Send + Sync {
    /// True for the built-in mock.
    fn is_mock(&self) -> bool;
    /// Names of the requests listed in the schema (`Request` oneof). `None` = unknown.
    fn request_names(&self) -> Option<Vec<String>>;

    async fn get_status(&self) -> Result<DishStatus, ClientError>;
    async fn get_history(&self) -> Result<DishHistory, ClientError>;
    async fn get_device_info(&self) -> Result<DeviceInfo, ClientError>;
    async fn get_obstruction_map(&self) -> Result<ObstructionMap, ClientError>;
    /// Snow-melt mode from `dish_get_config` (read-only). `Ok(None)` = unknown value.
    async fn get_snow_melt_mode(&self) -> Result<Option<SnowMeltMode>, ClientError>;

    /// Sends a write request. Callers must go through `commands::perform_write`, which
    /// enforces read-only mode and capabilities.
    async fn write(&self, action: WriteAction) -> Result<(), ClientError>;
}

/// Abstraction over the optional Starlink router.
#[async_trait]
pub trait RouterClient: Send + Sync {
    async fn wifi_clients(&self) -> Result<Vec<WifiClientInfo>, ClientError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weakest_signal_ignores_mesh_and_wired() {
        let clients = vec![
            WifiClientInfo {
                role: Some("CLIENT".into()),
                signal_strength_dbm: Some(-60.0),
                ..Default::default()
            },
            WifiClientInfo {
                role: Some("CLIENT".into()),
                signal_strength_dbm: Some(-82.0),
                ..Default::default()
            },
            WifiClientInfo {
                role: Some("REPEATER".into()),
                signal_strength_dbm: Some(-90.0),
                ..Default::default()
            },
            WifiClientInfo {
                role: Some("CONTROLLER".into()),
                ..Default::default()
            },
        ];
        assert_eq!(weakest_signal_dbm(&clients), Some(-82.0));
        assert_eq!(weakest_signal_dbm(&[]), None);
    }

    #[test]
    fn latest_power_uses_ring_index() {
        let mut h = DishHistory {
            current: 902,
            power_w: vec![Some(10.0); 900],
            ..Default::default()
        };
        h.power_w[1] = Some(42.0); // counter 901
        assert_eq!(h.latest_power(), Some(42.0));
        h.power_w = vec![Some(0.0); 900];
        assert_eq!(h.latest_power(), None, "all-zero power means not reported");
        h.power_w.clear();
        assert_eq!(h.latest_power(), None);
    }
}
