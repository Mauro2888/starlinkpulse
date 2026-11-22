//! Builds the anonymized 24 h `DiagnosticSummary` sent to the AI advisor.
//!
//! Inputs are aggregates only (no IDs, MACs, names, GPS). Pure function, so it is unit-tested
//! with seeded data.

use std::collections::BTreeMap;

use crate::dish::{WifiClientInfo, weakest_signal_dbm};
use crate::models::{
    DiagnosticSummary, DishCapabilities, DishEvent, HistoryPoint, TelemetrySnapshot,
};
use crate::time::MINUTE_MS;

pub const WINDOW_HOURS: u32 = 24;
/// Hours need at least this many minutes of data to be ranked.
const MIN_MINUTES_PER_HOUR: usize = 10;
const WORST_HOURS: usize = 3;

/// Everything the summary is computed from.
#[derive(Debug, Clone, Default)]
pub struct SummaryInputs<'a> {
    pub now_ms: i64,
    /// Minute aggregates of the window, any order.
    pub minutes: &'a [HistoryPoint],
    /// Outages overlapping the window.
    pub outages: &'a [DishEvent],
    pub throttled_minutes: u32,
    pub capabilities: Option<&'a DishCapabilities>,
    pub snapshot: Option<&'a TelemetrySnapshot>,
    pub wifi_clients: &'a [WifiClientInfo],
    /// Output language for the advisor (ISO 639-1).
    pub language: &'a str,
}

/// Wraps an angle difference into (-180, 180].
pub fn wrap_deg(d: f64) -> f64 {
    let r = d.rem_euclid(360.0);
    if r > 180.0 { r - 360.0 } else { r }
}

fn round(v: f64, decimals: i32) -> f64 {
    let f = 10f64.powi(decimals);
    (v * f).round() / f
}

/// Sample-weighted average of `f` over minutes where it is present.
fn weighted(minutes: &[&HistoryPoint], f: impl Fn(&HistoryPoint) -> Option<f64>) -> Option<f64> {
    let (sum, n) = minutes
        .iter()
        .filter_map(|m| f(m).map(|v| (v * m.samples as f64, m.samples as f64)))
        .fold((0.0, 0.0), |(s, n), (v, w)| (s + v, n + w));
    (n > 0.0).then(|| sum / n)
}

/// Sample-weighted nearest-rank percentile of per-minute values.
fn weighted_percentile(
    minutes: &[&HistoryPoint],
    f: impl Fn(&HistoryPoint) -> Option<f64>,
    q: f64,
) -> Option<f64> {
    let mut vals: Vec<(f64, f64)> = minutes
        .iter()
        .filter_map(|m| f(m).map(|v| (v, m.samples.max(1) as f64)))
        .collect();
    if vals.is_empty() {
        return None;
    }
    vals.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = vals.iter().map(|v| v.1).sum();
    let target = q * total;
    let mut acc = 0.0;
    for (v, w) in &vals {
        acc += w;
        if acc >= target {
            return Some(*v);
        }
    }
    vals.last().map(|v| v.0)
}

/// Minutes in the window that contain at least one sample.
pub fn history_minutes(minutes: &[HistoryPoint], now_ms: i64) -> u32 {
    let start = now_ms - WINDOW_HOURS as i64 * 60 * MINUTE_MS;
    minutes
        .iter()
        .filter(|m| m.minute_ms >= start && m.samples > 0)
        .count() as u32
}

/// Builds the summary for the last [`WINDOW_HOURS`].
/// Builds the summary; `tz` is the local time zone used for `worstHours` (DST-correct).
pub fn build_summary<Tz: chrono::TimeZone>(inp: &SummaryInputs<'_>, tz: &Tz) -> DiagnosticSummary {
    let start = inp.now_ms - WINDOW_HOURS as i64 * 60 * MINUTE_MS;
    let minutes: Vec<&HistoryPoint> = inp
        .minutes
        .iter()
        .filter(|m| m.minute_ms >= start && m.minute_ms <= inp.now_ms && m.samples > 0)
        .collect();

    let latency_avg = weighted(&minutes, |m| m.latency_avg_ms);
    // 24 h p95 estimated from per-minute averages (raw seconds are kept only 2 h).
    let latency_p95 = weighted_percentile(&minutes, |m| m.latency_avg_ms, 0.95);
    let drop_avg = weighted(&minutes, |m| m.drop_rate_avg);

    // Outages clipped to the window.
    let mut by_cause: BTreeMap<String, f64> = BTreeMap::new();
    let mut outage_count = 0u32;
    let mut outage_total_s = 0.0;
    for o in inp.outages {
        let end = o.start_ms + o.duration_ms.max(0);
        let clipped = (end.min(inp.now_ms) - o.start_ms.max(start)).max(0) as f64 / 1000.0;
        if end < start || o.start_ms > inp.now_ms {
            continue;
        }
        outage_count += 1;
        outage_total_s += clipped;
        *by_cause.entry(o.cause.clone()).or_default() += clipped;
    }
    let mut outages_by_cause: Vec<(String, f64)> = by_cause
        .into_iter()
        .map(|(c, s)| (c, round(s, 1)))
        .collect();
    outages_by_cause.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // Worst local hours: score = p95 latency relative to the window average + drop rate.
    let mut hours: BTreeMap<u8, Vec<&HistoryPoint>> = BTreeMap::new();
    for m in &minutes {
        hours
            .entry(crate::usage::local_hour(m.minute_ms, tz))
            .or_default()
            .push(m);
    }
    let base_latency = latency_avg.unwrap_or(0.0).max(1.0);
    let mut scored: Vec<(u8, f64)> = hours
        .iter()
        .filter(|(_, ms)| ms.len() >= MIN_MINUTES_PER_HOUR)
        .map(|(h, ms)| {
            let p95 = weighted(ms, |m| m.latency_p95_ms.or(m.latency_avg_ms)).unwrap_or(0.0);
            let drop = weighted(ms, |m| m.drop_rate_avg).unwrap_or(0.0);
            (*h, p95 / base_latency + drop * 20.0)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let worst_hours = scored.iter().take(WORST_HOURS).map(|(h, _)| *h).collect();

    let caps = inp.capabilities;
    let snap = inp.snapshot;
    let align = snap.map(|s| &s.alignment);
    // Correction to apply: desired − actual.
    let correction = |actual: Option<f64>, desired: Option<f64>| match (actual, desired) {
        (Some(a), Some(d)) => Some(d - a),
        _ => None,
    };

    DiagnosticSummary {
        language: inp.language.to_string(),
        window_hours: WINDOW_HOURS,
        history_minutes: history_minutes(inp.minutes, inp.now_ms),
        hardware_version: caps.and_then(|c| c.hardware_version.clone()),
        software_version: caps.and_then(|c| c.software_version.clone()),
        latency_avg_ms: latency_avg.map(|v| round(v, 1)),
        latency_p95_ms: latency_p95.map(|v| round(v, 1)),
        drop_rate_avg: drop_avg.map(|v| round(v, 5)),
        fraction_obstructed: snap
            .and_then(|s| s.obstruction.fraction_obstructed)
            .map(|v| round(v, 4)),
        outage_count,
        outage_total_s: round(outage_total_s, 1),
        outages_by_cause,
        worst_hours,
        throttled_minutes: inp.throttled_minutes,
        azimuth_correction_deg: correction(
            align.and_then(|a| a.azimuth_deg),
            align.and_then(|a| a.desired_azimuth_deg),
        )
        .map(|d| round(wrap_deg(d), 1)),
        elevation_correction_deg: correction(
            align.and_then(|a| a.elevation_deg),
            align.and_then(|a| a.desired_elevation_deg),
        )
        .map(|d| round(d, 1)),
        is_simulated: caps.is_some_and(|c| c.is_mock),
        weakest_wifi_signal_dbm: weakest_signal_dbm(inp.wifi_clients),
        // Filled by the caller from the rule engine when building the AI payload.
        rule_findings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AlignmentStats, ObstructionStats};
    use crate::storage::{Db, Sample, aggregate_minutes};

    const HOUR: i64 = 3_600_000;
    // 2026-11-22T00:00:00Z
    const DAY0: i64 = 1_795_305_600_000;

    /// Seeds a DB with 24 h of minutes: 30 ms everywhere, 80 ms and 5 % drop at 20:00 UTC,
    /// 50 ms at 03:00 UTC. Returns the DB and "now".
    fn seeded() -> (Db, i64) {
        let now = DAY0 + 24 * HOUR;
        let start_s = (now - 24 * HOUR) / 1000;
        let samples: Vec<Sample> = (0..24 * 3600)
            .map(|i| {
                let ts = start_s + i;
                let hour = (ts % 86_400) / 3600;
                let (lat, drop) = match hour {
                    20 => (80.0, 0.05),
                    3 => (50.0, 0.0),
                    _ => (30.0, 0.0),
                };
                Sample {
                    ts_s: ts,
                    latency_ms: Some(lat),
                    drop_rate: Some(drop),
                    downlink_bps: Some(1e6),
                    uplink_bps: Some(1e5),
                    power_w: Some(25.0),
                }
            })
            .collect();
        let mut db = Db::open_in_memory().unwrap();
        let outages = vec![
            DishEvent {
                start_ms: now - 2 * HOUR,
                duration_ms: 10_000,
                cause: "OBSTRUCTED".into(),
                severity: Some("WARNING".into()),
            },
            DishEvent {
                start_ms: now - 3 * HOUR,
                duration_ms: 4_000,
                cause: "OBSTRUCTED".into(),
                severity: None,
            },
            DishEvent {
                start_ms: now - HOUR,
                duration_ms: 30_000,
                cause: "BOOTING".into(),
                severity: Some("ADVISORY".into()),
            },
            // Started before the window: only 5 s fall inside it.
            DishEvent {
                start_ms: now - 24 * HOUR - 5_000,
                duration_ms: 10_000,
                cause: "NO_DOWNLINK".into(),
                severity: None,
            },
        ];
        db.insert_backfill(&aggregate_minutes(&samples), &outages, now)
            .unwrap();
        for m in 0..42 {
            db.mark_throttled(now - HOUR + m * MINUTE_MS).unwrap();
        }
        (db, now)
    }

    #[test]
    fn summary_from_seeded_db() {
        let (db, now) = seeded();
        let minutes = db.history(24 * 60, now).unwrap();
        let outages = db.outages(24 * 60, now).unwrap();
        let throttled = db.throttled_minutes(24 * 60, now).unwrap();
        let caps = DishCapabilities {
            hardware_version: Some("mini1_prod2".into()),
            software_version: Some("fw".into()),
            ..Default::default()
        };
        let snap = TelemetrySnapshot {
            obstruction: ObstructionStats {
                fraction_obstructed: Some(0.0123456),
                ..Default::default()
            },
            alignment: AlignmentStats {
                azimuth_deg: Some(355.0),
                desired_azimuth_deg: Some(5.0),
                elevation_deg: Some(64.0),
                desired_elevation_deg: Some(66.5),
                ..Default::default()
            },
            ..Default::default()
        };
        let wifi = vec![WifiClientInfo {
            role: Some("CLIENT".into()),
            signal_strength_dbm: Some(-77.0),
            ..Default::default()
        }];
        let s = build_summary(
            &SummaryInputs {
                now_ms: now,
                minutes: &minutes,
                outages: &outages,
                throttled_minutes: throttled,
                capabilities: Some(&caps),
                snapshot: Some(&snap),
                wifi_clients: &wifi,
                language: "en",
            },
            &chrono::FixedOffset::east_opt(3600).unwrap(),
        ); // UTC+1: 20:00 UTC is 21 local
        assert_eq!(s.language, "en");
        assert_eq!(s.history_minutes, 24 * 60);
        assert_eq!(s.window_hours, 24);
        assert_eq!(history_minutes(&minutes, now), 24 * 60);
        // (22 h x 30 + 80 + 50) / 24
        assert!(
            (s.latency_avg_ms.unwrap() - 32.9).abs() < 0.05,
            "{:?}",
            s.latency_avg_ms
        );
        assert_eq!(s.latency_p95_ms, Some(50.0));
        assert!((s.drop_rate_avg.unwrap() - 0.05 / 24.0).abs() < 1e-4);
        assert_eq!(s.worst_hours, vec![21, 4, 0]);
        assert_eq!(s.outage_count, 4);
        assert!((s.outage_total_s - 49.0).abs() < 1e-9);
        assert_eq!(
            s.outages_by_cause,
            vec![
                ("BOOTING".to_string(), 30.0),
                ("OBSTRUCTED".to_string(), 14.0),
                ("NO_DOWNLINK".to_string(), 5.0)
            ]
        );
        assert_eq!(s.throttled_minutes, 42);
        assert_eq!(s.fraction_obstructed, Some(0.0123));
        // Actual 355°, desired 5°: rotate 10° clockwise (wrapped across north).
        assert_eq!(s.azimuth_correction_deg, Some(10.0));
        // Actual 64°, desired 66.5°: tilt 2.5° up.
        assert_eq!(s.elevation_correction_deg, Some(2.5));
        assert!(!s.is_simulated);
        assert_eq!(s.weakest_wifi_signal_dbm, Some(-77.0));
        assert_eq!(s.hardware_version.as_deref(), Some("mini1_prod2"));
    }

    #[test]
    fn empty_inputs_give_empty_summary() {
        let s = build_summary(
            &SummaryInputs {
                now_ms: DAY0,
                ..Default::default()
            },
            &chrono::Utc,
        );
        assert_eq!(s.latency_avg_ms, None);
        assert_eq!(s.latency_p95_ms, None);
        assert_eq!(s.outage_count, 0);
        assert!(s.worst_hours.is_empty());
        assert_eq!(s.azimuth_correction_deg, None);
        assert_eq!(s.weakest_wifi_signal_dbm, None);
    }

    #[test]
    fn hours_with_little_data_are_not_ranked() {
        let pts: Vec<HistoryPoint> = (0..5)
            .map(|i| HistoryPoint {
                minute_ms: DAY0 + i * MINUTE_MS,
                samples: 60,
                latency_avg_ms: Some(200.0),
                ..Default::default()
            })
            .collect();
        let s = build_summary(
            &SummaryInputs {
                now_ms: DAY0 + HOUR,
                minutes: &pts,
                ..Default::default()
            },
            &chrono::Utc,
        );
        assert!(s.worst_hours.is_empty());
        assert_eq!(s.latency_avg_ms, Some(200.0));
    }

    #[test]
    fn worst_hours_follow_dst() {
        use crate::usage::test_tz::EuLike;
        // 30 minutes of bad latency at 2026-03-29 20:00 UTC = 22:00 CEST (after the spring
        // change); a fixed +1 offset would wrongly say 21.
        let start = chrono::NaiveDate::from_ymd_opt(2026, 3, 29)
            .unwrap()
            .and_hms_opt(20, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let pts: Vec<HistoryPoint> = (0..30)
            .map(|i| HistoryPoint {
                minute_ms: start + i * MINUTE_MS,
                samples: 60,
                latency_avg_ms: Some(80.0),
                latency_p95_ms: Some(90.0),
                ..Default::default()
            })
            .chain((0..30).map(|i| HistoryPoint {
                minute_ms: start - 5 * HOUR + i * MINUTE_MS,
                samples: 60,
                latency_avg_ms: Some(30.0),
                latency_p95_ms: Some(35.0),
                ..Default::default()
            }))
            .collect();
        let s = build_summary(
            &SummaryInputs {
                now_ms: start + HOUR,
                minutes: &pts,
                ..Default::default()
            },
            &EuLike,
        );
        assert_eq!(s.worst_hours, vec![22, 17]);
    }

    #[test]
    fn wrap() {
        assert_eq!(wrap_deg(350.0), -10.0);
        assert_eq!(wrap_deg(-190.0), 170.0);
        assert_eq!(wrap_deg(180.0), 180.0);
        assert_eq!(wrap_deg(-180.0), 180.0);
        assert_eq!(wrap_deg(12.0), 12.0);
    }
}
