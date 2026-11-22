//! Name-based parsers for dish/router responses in proto3 JSON form.
//!
//! [`super::grpc::GrpcClient`] decodes binary responses into `prost_reflect::DynamicMessage`
//! and serializes them to proto3 JSON (lowerCamelCase names, 64-bit integers as strings,
//! enums as names, NaN as `"NaN"`). The same JSON shape is produced by `grpcurl`, so these
//! parsers also run on the anonymized recon fixtures.
//!
//! Rules: every field is optional, NaN/Inf become `None`, numbers may be strings, and PII
//! is removed by [`strip_pii`] before anything else touches the data.

use serde_json::Value;

use super::{DeviceInfo, DishHistory, DishStatus, WifiClientInfo};
use crate::error::ClientError;
use crate::models::{
    ActuatorSupport, AlignmentStats, DishEvent, ObstructionMap, ObstructionStats, SnowMeltMode,
    TelemetrySnapshot,
};
use crate::time::{ns_to_unix_ms_auto, unix_ns_to_ms};

/// JSON keys that may carry personal or device-identifying data. Removed recursively at the
/// decoding boundary, before logging, storage or AI use.
pub const PII_KEYS: &[&str] = &[
    "id",
    "deviceId",
    "clientId",
    "captiveClientId",
    "targetId",
    "name",
    "givenName",
    "hostname",
    "macAddress",
    "upstreamMacAddress",
    "ipAddress",
    "ipv6Addresses",
    "domain",
    "buildId",
    "connectedRouters",
    "downstreamRouters",
    "location",
    "lla",
    "ecef",
    "latitude",
    "longitude",
    "altitude",
];

/// Recursively removes [`PII_KEYS`] from a JSON value.
pub fn strip_pii(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|k, _| !PII_KEYS.contains(&k.as_str()));
            for v in map.values_mut() {
                strip_pii(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_pii),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Low-level accessors
// ---------------------------------------------------------------------------

/// Follows a path of object keys.
pub fn path<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(v, |cur, k| cur.get(*k))
}

/// Finite number from a JSON number or numeric string; NaN/Inf/garbage -> `None`.
pub fn num(v: Option<&Value>) -> Option<f64> {
    let f = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    f.is_finite().then_some(f)
}

/// Unsigned integer from a JSON number or string (uint64 is serialized as a string).
pub fn uint(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f as u64)
        }),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// Signed integer from a JSON number or string.
pub fn int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

pub fn boolean(v: Option<&Value>) -> Option<bool> {
    v?.as_bool()
}

/// Non-empty string.
pub fn string(v: Option<&Value>) -> Option<String> {
    v?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Enum name; the proto3 zero value (`UNKNOWN` / `*_UNKNOWN`) means "not set" -> `None`.
pub fn enum_name(v: Option<&Value>) -> Option<String> {
    string(v).filter(|s| s != "UNKNOWN" && !s.ends_with("_UNKNOWN"))
}

fn num_array(v: Option<&Value>) -> Vec<Option<f64>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|x| num(Some(x))).collect())
        .unwrap_or_default()
}

/// Returns the response body for the oneof field `key` (e.g. `dishGetStatus`).
pub fn response_body<'a>(top: &'a Value, key: &str) -> Result<&'a Value, ClientError> {
    top.get(key)
        .filter(|v| v.is_object())
        .ok_or_else(|| ClientError::Decode(format!("response has no `{key}`")))
}

// ---------------------------------------------------------------------------
// get_status / get_device_info
// ---------------------------------------------------------------------------

fn actuators_from(v: Option<&Value>) -> ActuatorSupport {
    match v.and_then(Value::as_str) {
        Some("HAS_ACTUATORS_YES") => ActuatorSupport::Yes,
        Some("HAS_ACTUATORS_NO") => ActuatorSupport::No,
        _ => ActuatorSupport::Unknown,
    }
}

/// Parses the body of `dishGetStatus`.
pub fn parse_status(s: &Value, now_ms: i64) -> DishStatus {
    let obs = s.get("obstructionStats");
    let align = s.get("alignmentStats");
    let alerts_obj = s.get("alerts").and_then(Value::as_object);
    // With default-valued fields serialized, "no ping" arrives as 0: a real latency is > 0.
    let latency = num(s.get("popPingLatencyMs")).filter(|l| *l > 0.0);

    let mut alerts: Vec<String> = alerts_obj
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.as_bool() == Some(true))
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    alerts.sort();

    let obstruction = ObstructionStats {
        fraction_obstructed: obs.and_then(|o| num(o.get("fractionObstructed"))),
        time_obstructed: obs.and_then(|o| num(o.get("timeObstructed"))),
        valid_s: obs.and_then(|o| num(o.get("validS"))),
        // proto3 omits `false`: absent inside a present object means false.
        currently_obstructed: obs.map(|o| boolean(o.get("currentlyObstructed")).unwrap_or(false)),
        avg_prolonged_obstruction_interval_s: obs
            .and_then(|o| num(o.get("avgProlongedObstructionIntervalS"))),
    };

    let pick = |inner: &str, outer: &str| {
        align
            .and_then(|a| num(a.get(inner)))
            .or_else(|| num(s.get(outer)))
    };
    let alignment = AlignmentStats {
        azimuth_deg: pick("boresightAzimuthDeg", "boresightAzimuthDeg"),
        elevation_deg: pick("boresightElevationDeg", "boresightElevationDeg"),
        desired_azimuth_deg: align.and_then(|a| num(a.get("desiredBoresightAzimuthDeg"))),
        desired_elevation_deg: align.and_then(|a| num(a.get("desiredBoresightElevationDeg"))),
        tilt_angle_deg: align.and_then(|a| num(a.get("tiltAngleDeg"))),
        uncertainty_deg: align.and_then(|a| num(a.get("attitudeUncertaintyDeg"))),
    };
    let has_alignment_stats = alignment.azimuth_deg.is_some()
        || alignment.desired_azimuth_deg.is_some()
        || alignment.tilt_angle_deg.is_some();

    let gps = s.get("gpsStats");
    let snapshot = TelemetrySnapshot {
        timestamp_ms: now_ms,
        uptime_s: uint(path(s, &["deviceState", "uptimeS"])),
        downlink_bps: num(s.get("downlinkThroughputBps")),
        uplink_bps: num(s.get("uplinkThroughputBps")),
        // Filled by the service from the latest history sample (not in get_status).
        power_w: None,
        pop_ping_latency_ms: latency,
        // Omitted by the dish when 0; only infer 0 when the ping itself is reported.
        pop_ping_drop_rate: num(s.get("popPingDropRate")).or_else(|| latency.map(|_| 0.0)),
        snr_above_noise_floor: boolean(s.get("isSnrAboveNoiseFloor")),
        signal_quality: num(s.get("signalQuality")),
        obstruction,
        alignment,
        gps_valid: gps.map(|g| boolean(g.get("gpsValid")).unwrap_or(false)),
        gps_sats: gps.and_then(|g| uint(g.get("gpsSats"))).map(|n| n as u32),
        dl_bandwidth_restricted_reason: enum_name(s.get("dlBandwidthRestrictedReason")),
        ul_bandwidth_restricted_reason: enum_name(s.get("ulBandwidthRestrictedReason")),
        software_update_state: enum_name(s.get("softwareUpdateState")),
        disablement_code: enum_name(s.get("disablementCode")),
        is_heating: Some(alerts.iter().any(|a| a == "isHeating")),
        alerts,
    };

    let actuators = match actuators_from(s.get("hasActuators")) {
        ActuatorSupport::Unknown => actuators_from(align.and_then(|a| a.get("hasActuators"))),
        known => known,
    };

    let config = s.get("config").and_then(Value::as_object);
    let snow_melt_configurable = config
        .is_some_and(|c| c.contains_key("snowMeltMode") || c.contains_key("applySnowMeltMode"));

    DishStatus {
        snapshot,
        hardware_version: string(path(s, &["deviceInfo", "hardwareVersion"])),
        software_version: string(path(s, &["deviceInfo", "softwareVersion"])),
        bootcount: uint(path(s, &["deviceInfo", "bootcount"])),
        actuators,
        has_alignment_stats,
        snow_melt_configurable,
    }
}

/// Parses the body of `getDeviceInfo`.
pub fn parse_device_info(body: &Value) -> DeviceInfo {
    let info = body.get("deviceInfo").unwrap_or(body);
    DeviceInfo {
        hardware_version: string(info.get("hardwareVersion")),
        software_version: string(info.get("softwareVersion")),
    }
}

// ---------------------------------------------------------------------------
// dish_get_config
// ---------------------------------------------------------------------------

/// Snow-melt mode from the body of `dishGetConfig`. proto3 omits the default, so an absent
/// value means `AUTO`. Unknown values yield `None`.
pub fn parse_snow_melt_mode(body: &Value) -> Option<SnowMeltMode> {
    let cfg = body.get("dishConfig").unwrap_or(body);
    match cfg.get("snowMeltMode").and_then(Value::as_str) {
        None => Some(SnowMeltMode::Auto),
        Some(s) if s == "AUTO" || s.ends_with("_AUTO") => Some(SnowMeltMode::Auto),
        Some(s) if s == "ALWAYS_ON" || s.ends_with("_ALWAYS_ON") => Some(SnowMeltMode::AlwaysOn),
        Some(s) if s == "ALWAYS_OFF" || s.ends_with("_ALWAYS_OFF") => Some(SnowMeltMode::AlwaysOff),
        Some(_) => None,
    }
}

// ---------------------------------------------------------------------------
// get_history
// ---------------------------------------------------------------------------

fn strip_prefix_owned(s: &str, prefixes: &[&str]) -> String {
    prefixes
        .iter()
        .find_map(|p| s.strip_prefix(p))
        .unwrap_or(s)
        .to_string()
}

/// Parses the body of `dishGetHistory`.
pub fn parse_history(h: &Value, now_ms: i64) -> DishHistory {
    let power_in = num_array(h.get("powerIn"));
    let power_cons = num_array(h.get("powerConsumptionW"));
    let non_zero = |v: &Vec<Option<f64>>| v.iter().flatten().any(|w| *w > 0.0);
    let power_w = if non_zero(&power_in) {
        power_in
    } else if non_zero(&power_cons) {
        power_cons
    } else {
        Vec::new()
    };

    let event_log = h.get("eventLog");
    // The dish's own clock is the best reference for interpreting timestamps.
    let reference_ms = event_log
        .and_then(|e| int(e.get("currentTimestampNs")))
        .map(unix_ns_to_ms)
        .unwrap_or(now_ms);

    let outages = h
        .get("outages")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|o| {
                    let start_ns = int(o.get("startTimestampNs"))?;
                    Some(DishEvent {
                        start_ms: ns_to_unix_ms_auto(start_ns, reference_ms),
                        duration_ms: int(o.get("durationNs")).unwrap_or(0) / 1_000_000,
                        cause: string(o.get("cause")).unwrap_or_else(|| "UNKNOWN".into()),
                        severity: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let mut events = Vec::new();
    let mut other_events = Vec::new();
    for e in event_log
        .and_then(|e| e.get("events"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(start_ns) = int(e.get("startTimestampNs")) else {
            continue;
        };
        let reason = string(e.get("reason")).unwrap_or_else(|| "UNKNOWN".into());
        let is_outage = reason.starts_with("EVENT_REASON_OUTAGE_");
        let event = DishEvent {
            start_ms: ns_to_unix_ms_auto(start_ns, reference_ms),
            duration_ms: int(e.get("durationNs")).unwrap_or(0) / 1_000_000,
            cause: strip_prefix_owned(&reason, &["EVENT_REASON_OUTAGE_", "EVENT_REASON_"]),
            severity: string(e.get("severity"))
                .map(|s| strip_prefix_owned(&s, &["EVENT_SEVERITY_"])),
        };
        if is_outage {
            events.push(event);
        } else {
            other_events.push(event);
        }
    }

    DishHistory {
        current: uint(h.get("current")).unwrap_or(0),
        latency_ms: num_array(h.get("popPingLatencyMs")),
        drop_rate: num_array(h.get("popPingDropRate")),
        downlink_bps: num_array(h.get("downlinkThroughputBps")),
        uplink_bps: num_array(h.get("uplinkThroughputBps")),
        power_w,
        outages,
        events,
        other_events,
    }
}

// ---------------------------------------------------------------------------
// dish_get_obstruction_map
// ---------------------------------------------------------------------------

/// Parses the body of `dishGetObstructionMap`. `-1` (no data) and non-finite values -> `None`.
pub fn parse_obstruction_map(m: &Value) -> Result<ObstructionMap, ClientError> {
    let snr: Vec<Option<f32>> = m
        .get("snr")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| {
                    num(Some(x))
                        .filter(|v| *v >= 0.0)
                        .map(|v| v.min(1.0) as f32)
                })
                .collect()
        })
        .unwrap_or_default();
    if snr.is_empty() {
        return Err(ClientError::Unsupported);
    }
    let mut rows = uint(m.get("numRows")).unwrap_or(0) as u32;
    let mut cols = uint(m.get("numCols")).unwrap_or(0) as u32;
    if (rows as usize) * (cols as usize) != snr.len() {
        let side = (snr.len() as f64).sqrt() as u32;
        if (side as usize) * (side as usize) == snr.len() {
            rows = side;
            cols = side;
        } else {
            return Err(ClientError::Decode("obstruction map size mismatch".into()));
        }
    }
    Ok(ObstructionMap {
        rows,
        cols,
        min_elevation_deg: num(m.get("minElevationDeg")),
        max_theta_deg: num(m.get("maxThetaDeg")),
        reference_frame: string(m.get("mapReferenceFrame")),
        snr,
    })
}

// ---------------------------------------------------------------------------
// Router: wifi_get_clients
// ---------------------------------------------------------------------------

/// Parses the body of `wifiGetClients`, copying only whitelisted non-PII fields.
pub fn parse_wifi_clients(body: &Value) -> Vec<WifiClientInfo> {
    body.get("clients")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| WifiClientInfo {
                    iface: string(c.get("iface")),
                    role: string(c.get("role")),
                    // 0 means "not reported" (wired / mesh entries).
                    signal_strength_dbm: num(c.get("signalStrength")).filter(|v| *v != 0.0),
                    snr: num(c.get("snr")),
                    channel_width_mhz: num(c.get("channelWidth")),
                    est_rx_rate_mbps: num(c.get("estRxRateMbpsFromController")),
                    est_tx_rate_mbps: num(c.get("estTxRateMbpsFromController")),
                    rx_rate_mbps: num(path(c, &["rxStats", "rateMbps"])),
                    tx_rate_mbps: num(path(c, &["txStats", "rateMbps"])),
                    associated_time_s: uint(c.get("associatedTimeS")),
                    hops_from_controller: uint(c.get("hopsFromController")).map(|n| n as u32),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(path).expect("fixture");
        let mut v: Value = serde_json::from_str(&text).expect("fixture json");
        strip_pii(&mut v);
        v
    }

    #[test]
    fn status_fixture_parses() {
        let top = fixture("get_status.json");
        let body = response_body(&top, "dishGetStatus").unwrap();
        let st = parse_status(body, 1000);
        let s = &st.snapshot;
        assert_eq!(s.timestamp_ms, 1000);
        assert_eq!(s.uptime_s, Some(1132));
        assert!((s.pop_ping_latency_ms.unwrap() - 26.28).abs() < 0.01);
        // popPingDropRate omitted -> 0 because latency is present.
        assert_eq!(s.pop_ping_drop_rate, Some(0.0));
        // "NaN" -> None.
        assert_eq!(s.obstruction.avg_prolonged_obstruction_interval_s, None);
        assert_eq!(s.obstruction.currently_obstructed, Some(false));
        assert_eq!(s.obstruction.valid_s, Some(1064.0));
        assert_eq!(
            s.dl_bandwidth_restricted_reason.as_deref(),
            Some("POLICY_LIMIT")
        );
        assert_eq!(s.gps_valid, Some(true));
        assert_eq!(s.gps_sats, Some(13));
        assert!(s.alerts.is_empty());
        assert_eq!(s.is_heating, Some(false));
        assert!(s.alignment.desired_azimuth_deg.is_some());
        assert_eq!(st.actuators, ActuatorSupport::No);
        assert!(st.has_alignment_stats);
        assert!(st.snow_melt_configurable);
        assert_eq!(st.hardware_version.as_deref(), Some("mini1_pez_proto1"));
    }

    #[test]
    fn status_with_missing_fields_and_nan() {
        let body = json!({
            "popPingLatencyMs": "NaN",
            "downlinkThroughputBps": "Infinity",
            "uplinkThroughputBps": "12.5",
            "deviceState": { "uptimeS": "18446744073709551615" },
            "alerts": { "thermalThrottle": true, "isHeating": true, "motorsStuck": false },
            "hasActuators": "HAS_ACTUATORS_YES"
        });
        let st = parse_status(&body, 0);
        let s = &st.snapshot;
        assert_eq!(s.pop_ping_latency_ms, None);
        assert_eq!(
            s.pop_ping_drop_rate, None,
            "no latency -> drop rate unknown"
        );
        assert_eq!(s.downlink_bps, None);
        assert_eq!(s.uplink_bps, Some(12.5));
        assert_eq!(s.uptime_s, Some(u64::MAX));
        assert_eq!(s.obstruction, ObstructionStats::default());
        assert_eq!(s.gps_valid, None);
        assert_eq!(
            s.alerts,
            vec!["isHeating".to_string(), "thermalThrottle".to_string()]
        );
        assert_eq!(s.is_heating, Some(true));
        assert_eq!(st.actuators, ActuatorSupport::Yes);
        assert!(!st.has_alignment_stats);
        assert!(!st.snow_melt_configurable);
        assert_eq!(st.hardware_version, None);
    }

    #[test]
    fn zero_defaults_from_schema_mean_absent() {
        // As produced by message_to_json with default-valued fields included.
        let body = json!({
            "popPingLatencyMs": 0.0,
            "popPingDropRate": 1.0,
            "downlinkThroughputBps": 0.0,
            "dlBandwidthRestrictedReason": "UNKNOWN",
            "softwareUpdateState": "SOFTWARE_UPDATE_STATE_UNKNOWN",
            "disablementCode": "OKAY"
        });
        let s = parse_status(&body, 0).snapshot;
        assert_eq!(s.pop_ping_latency_ms, None);
        assert_eq!(s.pop_ping_drop_rate, Some(1.0));
        assert_eq!(
            s.downlink_bps,
            Some(0.0),
            "zero throughput is a valid value"
        );
        assert_eq!(s.dl_bandwidth_restricted_reason, None);
        assert_eq!(s.software_update_state, None);
        assert_eq!(s.disablement_code.as_deref(), Some("OKAY"));
    }

    #[test]
    fn empty_status_does_not_panic() {
        let st = parse_status(&json!({}), 5);
        assert_eq!(st.snapshot.timestamp_ms, 5);
        assert_eq!(st.actuators, ActuatorSupport::Unknown);
    }

    #[test]
    fn missing_response_body_is_error() {
        assert!(response_body(&json!({"apiVersion": "44"}), "dishGetStatus").is_err());
    }

    #[test]
    fn history_fixture_parses() {
        let top = fixture("get_history.json");
        let body = response_body(&top, "dishGetHistory").unwrap();
        let h = parse_history(body, 0);
        assert_eq!(h.current, 1115);
        assert_eq!(h.buffer_len(), 900);
        assert_eq!(h.power_w.len(), 900);
        assert!(h.has_power());
        // Newest sample is at (current - 1) % 900.
        assert_eq!(h.latest_power(), h.power_w[(1115 - 1) % 900]);
        assert!(h.latest_power().is_some());
        assert_eq!(h.outages.len(), 4);
        assert_eq!(h.outages[0].cause, "BOOTING");
        assert_eq!(h.outages[0].start_ms, 1_795_361_153_894);
        assert_eq!(h.outages[0].severity, None);
        assert_eq!(h.events.len(), 4);
        assert_eq!(h.events[0].cause, "BOOTING");
        assert_eq!(h.events[0].severity.as_deref(), Some("ADVISORY"));
        // Outages (GPS epoch) and event log (Unix epoch) describe the same instants.
        for (o, e) in h.outages.iter().zip(&h.events) {
            assert_eq!(o.start_ms, e.start_ms);
        }
        // Same instant, different classification: raw SKY_SEARCH vs event-log OBSTRUCTED.
        assert_eq!(h.outages[3].cause, "SKY_SEARCH");
        assert_eq!(h.events[3].cause, "OBSTRUCTED");
        assert_eq!(h.events[3].duration_ms, 5020);
        assert!(h.other_events.is_empty());
    }

    #[test]
    fn history_power_fallback() {
        let body = json!({
            "current": "3",
            "popPingLatencyMs": [20.0, "NaN", 30.0],
            "powerIn": [0, 0, 0],
            "powerConsumptionW": [40.0, 41.0, 42.0]
        });
        let h = parse_history(&body, 0);
        assert_eq!(h.latency_ms, vec![Some(20.0), None, Some(30.0)]);
        assert_eq!(h.power_w, vec![Some(40.0), Some(41.0), Some(42.0)]);
        let none = parse_history(&json!({"current": 0}), 0);
        assert!(none.power_w.is_empty());
        assert!(!none.has_power());
    }

    #[test]
    fn obstruction_map_fixture_parses() {
        let top = fixture("obstruction_map.json");
        let body = response_body(&top, "dishGetObstructionMap").unwrap();
        let m = parse_obstruction_map(body).unwrap();
        assert_eq!((m.rows, m.cols), (123, 123));
        assert_eq!(m.snr.len(), 123 * 123);
        assert!(m.snr.iter().any(Option::is_none));
        assert!(m.snr.iter().flatten().all(|v| (0.0..=1.0).contains(v)));
        assert_eq!(m.reference_frame.as_deref(), Some("FRAME_EARTH"));
        assert!(parse_obstruction_map(&json!({})).is_err());
    }

    #[test]
    fn device_info_fixture_parses() {
        let top = fixture("get_device_info.json");
        let info = parse_device_info(response_body(&top, "getDeviceInfo").unwrap());
        assert_eq!(info.hardware_version.as_deref(), Some("mini1_pez_proto1"));
        assert!(info.software_version.is_some());
    }

    #[test]
    fn wifi_fixture_parses_without_pii() {
        let top = fixture("wifi_get_clients.json");
        let clients = parse_wifi_clients(response_body(&top, "wifiGetClients").unwrap());
        assert_eq!(clients.len(), 12);
        assert!(clients.iter().any(|c| c.signal_strength_dbm.is_none()));
        assert_eq!(super::super::weakest_signal_dbm(&clients), Some(-91.0));
    }

    #[test]
    fn strip_pii_removes_identifiers_recursively() {
        let mut v = json!({
            "wifiGetClients": { "clients": [{
                "name": "Someones-Phone",
                "macAddress": "aa:bb:cc:dd:ee:ff",
                "ipAddress": "192.168.1.50",
                "ipv6Addresses": ["fe80::1"],
                "deviceId": "Router-0000",
                "clientId": 12345,
                "upstreamMacAddress": "11:22:33:44:55:66",
                "domain": "lan",
                "signalStrength": -70,
                "iface": "RF_5GHZ"
            }]},
            "dishGetStatus": {
                "deviceInfo": { "id": "ut-0000", "hardwareVersion": "x" },
                "connectedRouters": ["Router-1"],
                "downstreamRouters": { "Router-1": { "role": "CONTROLLER" } }
            }
        });
        strip_pii(&mut v);
        let text = v.to_string();
        for needle in [
            "Someones-Phone",
            "aa:bb:cc",
            "192.168.1.50",
            "fe80",
            "Router-",
            "12345",
            "11:22:33",
            "ut-0000",
            "\"lan\"",
        ] {
            assert!(!text.contains(needle), "{needle} leaked: {text}");
        }
        assert!(text.contains("signalStrength"));
        assert!(text.contains("hardwareVersion"));

        // The typed boundary also never copies PII even without strip_pii.
        let raw =
            json!({ "clients": [{ "name": "Phone", "macAddress": "aa", "signalStrength": -50 }] });
        let parsed = parse_wifi_clients(&raw);
        let out = serde_json::to_string(&parsed).unwrap();
        assert!(!out.contains("Phone") && !out.contains("\"aa\""));
        assert_eq!(parsed[0].signal_strength_dbm, Some(-50.0));
    }

    #[test]
    fn snow_melt_mode_from_config() {
        let top = fixture("dish_get_config.json");
        let body = response_body(&top, "dishGetConfig").unwrap();
        // Absent in the recon capture -> AUTO.
        assert_eq!(parse_snow_melt_mode(body), Some(SnowMeltMode::Auto));
        let on = json!({"dishConfig": {"snowMeltMode": "ALWAYS_ON"}});
        assert_eq!(parse_snow_melt_mode(&on), Some(SnowMeltMode::AlwaysOn));
        let odd = json!({"dishConfig": {"snowMeltMode": "SOMETHING_NEW"}});
        assert_eq!(parse_snow_melt_mode(&odd), None);
    }

    #[test]
    fn number_helpers() {
        assert_eq!(num(Some(&json!("NaN"))), None);
        assert_eq!(num(Some(&json!("-Infinity"))), None);
        assert_eq!(num(Some(&json!("1.5"))), Some(1.5));
        assert_eq!(num(Some(&json!(true))), None);
        assert_eq!(uint(Some(&json!("42"))), Some(42));
        assert_eq!(uint(Some(&json!(-1))), None);
        assert_eq!(int(Some(&json!("-7"))), Some(-7));
        assert_eq!(string(Some(&json!(""))), None);
    }
}
