//! Uptime statistics (24 h / 7 d / 30 d) from outages and data coverage.

use crate::models::{DishEvent, UptimeWindow};

/// Below this coverage fraction the uptime is not meaningful (`uptimePct = null`).
pub const MIN_COVERAGE: f64 = 0.10;

/// Builds one window. `uptime_pct` is 0-100: `100 * (1 - outage_s / covered_s)`.
pub fn window(
    label: &str,
    window_s: f64,
    covered_s: f64,
    outage_count: u32,
    outage_s: f64,
) -> UptimeWindow {
    let covered = covered_s.clamp(0.0, window_s);
    let outage = outage_s.clamp(0.0, covered.max(0.0));
    let uptime_pct = (window_s > 0.0 && covered >= MIN_COVERAGE * window_s)
        .then(|| (100.0 * (1.0 - outage / covered)).clamp(0.0, 100.0));
    UptimeWindow {
        label: label.to_string(),
        window_s,
        covered_s: covered,
        uptime_pct,
        outage_count,
        outage_s: outage,
    }
}

/// Outage count and seconds inside `[start_ms, end_ms]` (outages clipped to the window).
pub fn clipped_outages(outages: &[DishEvent], start_ms: i64, end_ms: i64) -> (u32, f64) {
    outages
        .iter()
        .filter_map(|o| {
            let end = o.start_ms + o.duration_ms.max(0);
            let clipped = end.min(end_ms) - o.start_ms.max(start_ms);
            (end >= start_ms && o.start_ms <= end_ms).then_some(clipped.max(0) as f64 / 1000.0)
        })
        .fold((0, 0.0), |(n, s), d| (n + 1, s + d))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, Sample, aggregate_minutes};
    use crate::time::{DAY_MS, day_floor};

    #[test]
    fn pct_and_coverage_threshold() {
        let w = window("24h", 86_400.0, 43_200.0, 2, 432.0);
        assert_eq!(w.uptime_pct, Some(99.0));
        assert_eq!(w.outage_count, 2);
        // < 10 % coverage -> null.
        assert_eq!(window("24h", 86_400.0, 8_000.0, 0, 0.0).uptime_pct, None);
        assert_eq!(
            window("24h", 86_400.0, 8_640.0, 0, 0.0).uptime_pct,
            Some(100.0)
        );
        // Outages longer than coverage never go below 0 %.
        assert_eq!(
            window("24h", 86_400.0, 10_000.0, 1, 50_000.0).uptime_pct,
            Some(0.0)
        );
    }

    #[test]
    fn clipping() {
        let o = |s: i64, d: i64| DishEvent {
            start_ms: s,
            duration_ms: d,
            cause: "X".into(),
            severity: None,
        };
        let (n, s) = clipped_outages(
            &[o(-5_000, 10_000), o(50_000, 1_000), o(200_000, 1_000)],
            0,
            100_000,
        );
        assert_eq!(n, 2);
        assert_eq!(s, 6.0);
    }

    #[test]
    fn seven_days_survive_minute_pruning() {
        let mut db = Db::open_in_memory().unwrap();
        let day0 = day_floor(1_800_000_000_000);
        // 10 days, 4 h of data per day (17 % coverage), one 60 s outage per day.
        for d in 0..10 {
            let start_s = (day0 + d * DAY_MS) / 1000 + 3600;
            let samples: Vec<Sample> = (0..14_400)
                .map(|i| Sample {
                    ts_s: start_s + i,
                    latency_ms: Some(30.0),
                    ..Default::default()
                })
                .collect();
            let outage = DishEvent {
                start_ms: (start_s + 100) * 1000,
                duration_ms: 60_000,
                cause: "OBSTRUCTED".into(),
                severity: None,
            };
            let now = (start_s + 14_400) * 1000;
            db.insert_backfill(&aggregate_minutes(&samples), &[outage], now)
                .unwrap();
        }
        let now = day0 + 9 * DAY_MS + 6 * 3_600_000;
        let (covered, count, out) = db.daily_uptime(7, now).unwrap();
        assert_eq!(covered, 7.0 * 14_400.0);
        assert_eq!(count, 7);
        assert_eq!(out, 7.0 * 60.0);
        // Minute data older than 48 h is gone, daily rows remain.
        assert!(db.covered_seconds(7 * 24 * 60, now).unwrap() <= 3.0 * 14_400.0);
        let w = window("7d", 7.0 * 86_400.0, covered, count, out);
        assert!((w.uptime_pct.unwrap() - (100.0 * (1.0 - 60.0 / 14_400.0))).abs() < 1e-9);
    }
}
