//! Timestamp helpers.
//!
//! The dish reports `outages[].startTimestampNs` in **GPS-epoch** nanoseconds, while
//! `eventLog.events[].startTimestampNs` is already **Unix-epoch** nanoseconds (verified on
//! firmware 2026.10: the two differ by exactly 315 964 782 s). Firmware may change this, so
//! [`ns_to_unix_ms_auto`] picks the interpretation closest to a reference time.

use std::time::{SystemTime, UNIX_EPOCH};

/// GPS epoch (1980-01-06T00:00:00Z) as Unix seconds.
pub const GPS_EPOCH_UNIX_S: i64 = 315_964_800;
/// Current GPS-UTC leap-second offset (unchanged since 2017).
pub const GPS_UTC_LEAP_SECONDS: i64 = 18;

pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MS: i64 = 86_400_000;

/// Converts GPS-epoch nanoseconds to Unix milliseconds.
pub fn gps_ns_to_unix_ms(gps_ns: i64) -> i64 {
    gps_ns.div_euclid(1_000_000) + (GPS_EPOCH_UNIX_S - GPS_UTC_LEAP_SECONDS) * 1000
}

/// Converts Unix-epoch nanoseconds to Unix milliseconds.
pub fn unix_ns_to_ms(unix_ns: i64) -> i64 {
    unix_ns.div_euclid(1_000_000)
}

/// Interprets `ns` either as GPS-epoch or Unix-epoch nanoseconds, whichever lands closer
/// to `reference_ms` (normally "now" or the dish's own current timestamp).
pub fn ns_to_unix_ms_auto(ns: i64, reference_ms: i64) -> i64 {
    let as_gps = gps_ns_to_unix_ms(ns);
    let as_unix = unix_ns_to_ms(ns);
    if (as_gps - reference_ms).abs() < (as_unix - reference_ms).abs() {
        as_gps
    } else {
        as_unix
    }
}

/// Current Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Start of the minute containing `ms`.
pub fn minute_floor(ms: i64) -> i64 {
    ms.div_euclid(MINUTE_MS) * MINUTE_MS
}

/// Start of the UTC day containing `ms`.
pub fn day_floor(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gps_epoch_zero_is_1980_minus_leap() {
        // GPS 0 == 1980-01-06T00:00:00 GPS == 1980-01-05T23:59:42 UTC.
        assert_eq!(gps_ns_to_unix_ms(0), (315_964_800 - 18) * 1000);
    }

    #[test]
    fn outage_and_event_log_timestamps_agree() {
        // Same outage from the recon capture: once as GPS ns (outages[]) and once as
        // Unix ns (eventLog.events[]).
        let gps = 1_479_396_371_894_169_847_i64;
        let unix = 1_795_361_153_894_169_847_i64;
        assert_eq!(gps_ns_to_unix_ms(gps), unix_ns_to_ms(unix));
        assert_eq!(gps_ns_to_unix_ms(gps), 1_795_361_153_894);
    }

    #[test]
    fn auto_detection_picks_closest() {
        let reference = 1_795_362_284_619;
        assert_eq!(
            ns_to_unix_ms_auto(1_479_396_371_894_169_847, reference),
            1_795_361_153_894
        );
        assert_eq!(
            ns_to_unix_ms_auto(1_795_361_153_894_169_847, reference),
            1_795_361_153_894
        );
    }

    #[test]
    fn floors() {
        assert_eq!(minute_floor(125_000), 120_000);
        assert_eq!(day_floor(DAY_MS + 5), DAY_MS);
        assert_eq!(minute_floor(-1), -60_000);
    }
}
