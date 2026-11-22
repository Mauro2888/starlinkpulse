//! Capability detection (ADR-003).
//!
//! The schema lists every request regardless of model (e.g. `dish_stow` on a Mini), so it is
//! only a necessary condition. Capabilities combine status hints (`hasActuators`,
//! `alignmentStats`, config), history (power), runtime probes (obstruction map) and router
//! reachability. Probes failing with `Unimplemented`/`PermissionDenied` mean "unsupported".

use crate::dish::DishStatus;
use crate::error::ClientError;
use crate::models::{ActuatorSupport, DishCapabilities};

/// Outcome of a runtime probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Probe {
    Supported,
    Unsupported,
    /// Not probed or failed for another reason (timeout, decode error).
    #[default]
    Unknown,
}

impl Probe {
    pub fn from_result<T>(r: &Result<T, ClientError>) -> Self {
        match r {
            Ok(_) => Probe::Supported,
            Err(e) if e.is_unsupported() => Probe::Unsupported,
            Err(_) => Probe::Unknown,
        }
    }
}

/// Inputs gathered at connect time.
#[derive(Debug, Clone, Default)]
pub struct CapabilityInputs {
    pub status: Option<DishStatus>,
    /// Request names from the schema; `None` when unknown (then the schema is not a constraint).
    pub request_names: Option<Vec<String>>,
    /// `Some(true)` when history contains non-zero power samples.
    pub history_has_power: Option<bool>,
    pub obstruction_map: Probe,
    pub router_available: bool,
    pub is_mock: bool,
}

/// Builds [`DishCapabilities`] from the gathered inputs.
pub fn detect(inputs: &CapabilityInputs) -> DishCapabilities {
    let in_schema = |name: &str| {
        inputs
            .request_names
            .as_ref()
            .is_none_or(|names| names.iter().any(|n| n == name))
    };
    let status = inputs.status.as_ref();
    let actuators = status.map(|s| s.actuators).unwrap_or_default();
    let reachable = status.is_some();

    DishCapabilities {
        hardware_version: status.and_then(|s| s.hardware_version.clone()),
        software_version: status.and_then(|s| s.software_version.clone()),
        actuators,
        can_stow: reachable && actuators == ActuatorSupport::Yes && in_schema("dish_stow"),
        can_reboot: reachable && in_schema("reboot"),
        can_set_snow_melt: reachable
            && in_schema("dish_set_config")
            && status.is_some_and(|s| s.snow_melt_configurable),
        has_obstruction_map: inputs.obstruction_map == Probe::Supported,
        has_power_telemetry: inputs.history_has_power.unwrap_or(false),
        has_alignment_stats: status.is_some_and(|s| s.has_alignment_stats),
        has_router: inputs.router_available,
        is_mock: inputs.is_mock,
        // Filled by the service from `dish_get_config` (read-only).
        snow_melt_mode: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dish::json::{parse_status, response_body};

    fn names(list: &[&str]) -> Option<Vec<String>> {
        Some(list.iter().map(|s| s.to_string()).collect())
    }

    fn fixture_status() -> DishStatus {
        let path = format!(
            "{}/tests/fixtures/get_status.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let top: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        parse_status(response_body(&top, "dishGetStatus").unwrap(), 0)
    }

    #[test]
    fn mini_lists_stow_but_cannot_stow() {
        // Recon: the Mini schema lists `dish_stow`, but hasActuators = NO.
        let caps = detect(&CapabilityInputs {
            status: Some(fixture_status()),
            request_names: names(&["reboot", "dish_stow", "dish_set_config", "get_status"]),
            history_has_power: Some(true),
            obstruction_map: Probe::Supported,
            router_available: true,
            is_mock: false,
        });
        assert_eq!(caps.actuators, ActuatorSupport::No);
        assert!(!caps.can_stow);
        assert!(caps.can_reboot);
        assert!(caps.can_set_snow_melt);
        assert!(caps.has_alignment_stats);
        assert!(caps.has_power_telemetry);
        assert!(caps.has_obstruction_map);
        assert!(caps.has_router);
        assert_eq!(caps.hardware_version.as_deref(), Some("mini1_pez_proto1"));
    }

    #[test]
    fn actuated_dish_can_stow_only_if_schema_has_it() {
        let mut status = fixture_status();
        status.actuators = ActuatorSupport::Yes;
        let mut inputs = CapabilityInputs {
            status: Some(status),
            request_names: names(&["dish_stow"]),
            ..Default::default()
        };
        assert!(detect(&inputs).can_stow);
        inputs.request_names = names(&["get_status"]);
        let caps = detect(&inputs);
        assert!(!caps.can_stow);
        assert!(!caps.can_reboot);
        assert!(!caps.can_set_snow_melt);
    }

    #[test]
    fn unsupported_probe_and_missing_data() {
        let probe = Probe::from_result::<()>(&Err(ClientError::Unsupported));
        assert_eq!(probe, Probe::Unsupported);
        assert_eq!(
            Probe::from_result::<()>(&Err(ClientError::Timeout)),
            Probe::Unknown
        );
        let caps = detect(&CapabilityInputs {
            status: Some(DishStatus::default()),
            obstruction_map: probe,
            ..Default::default()
        });
        assert!(!caps.has_obstruction_map);
        assert!(!caps.has_power_telemetry);
        assert!(!caps.has_alignment_stats);
        assert_eq!(caps.actuators, ActuatorSupport::Unknown);
        assert!(!caps.can_stow, "unknown actuators never allow stow");
    }

    #[test]
    fn unreachable_dish_has_no_write_capabilities() {
        let caps = detect(&CapabilityInputs::default());
        assert!(!caps.can_reboot && !caps.can_stow && !caps.can_set_snow_melt);
    }
}
