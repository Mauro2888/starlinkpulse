//! CSV export of per-minute history.

use chrono::{DateTime, Utc};

use crate::models::HistoryPoint;

pub const CSV_HEADER: &str = "minute_utc,minute_ms,samples,latency_avg_ms,latency_p95_ms,latency_max_ms,drop_rate_avg,downlink_avg_bps,downlink_max_bps,uplink_avg_bps,uplink_max_bps,power_avg_w,power_max_w";

fn opt(v: Option<f64>) -> String {
    v.filter(|x| x.is_finite())
        .map(|x| format!("{}", (x * 1000.0).round() / 1000.0))
        .unwrap_or_default()
}

/// Renders history points as CSV (UTC ISO-8601 timestamps, empty cells for missing values).
pub fn history_csv(points: &[HistoryPoint]) -> String {
    let mut out = String::with_capacity(64 + points.len() * 96);
    out.push_str(CSV_HEADER);
    out.push('\n');
    for p in points {
        let ts = DateTime::<Utc>::from_timestamp_millis(p.minute_ms)
            .map(|t| t.format("%Y-%m-%dT%H:%M:%SZ").to_string())
            .unwrap_or_default();
        let cells = [
            ts,
            p.minute_ms.to_string(),
            p.samples.to_string(),
            opt(p.latency_avg_ms),
            opt(p.latency_p95_ms),
            opt(p.latency_max_ms),
            opt(p.drop_rate_avg),
            opt(p.downlink_avg_bps),
            opt(p.downlink_max_bps),
            opt(p.uplink_avg_bps),
            opt(p.uplink_max_bps),
            opt(p.power_avg_w),
            opt(p.power_max_w),
        ];
        out.push_str(&cells.join(","));
        out.push('\n');
    }
    out
}

/// Suggested file name, e.g. `starlinkpulse-history-20261122-1730.csv`.
pub fn default_file_name(now_ms: i64) -> String {
    let t = DateTime::<Utc>::from_timestamp_millis(now_ms).unwrap_or_default();
    format!("starlinkpulse-history-{}.csv", t.format("%Y%m%d-%H%M"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_rows_and_missing_values() {
        let pts = vec![
            HistoryPoint {
                minute_ms: 1_795_305_600_000,
                samples: 60,
                latency_avg_ms: Some(27.123456),
                drop_rate_avg: Some(0.0),
                power_avg_w: None,
                ..Default::default()
            },
            HistoryPoint {
                minute_ms: 1_795_305_660_000,
                samples: 12,
                latency_avg_ms: Some(f64::NAN),
                ..Default::default()
            },
        ];
        let csv = history_csv(&pts);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], CSV_HEADER);
        assert_eq!(
            lines[1],
            "2026-11-22T00:00:00Z,1795305600000,60,27.123,,,0,,,,,,"
        );
        assert!(lines[2].starts_with("2026-11-22T00:01:00Z,1795305660000,12,,"));
        let cols = CSV_HEADER.split(',').count();
        assert!(lines.iter().all(|l| l.split(',').count() == cols));
        assert_eq!(
            default_file_name(1_795_305_600_000),
            "starlinkpulse-history-20261122-0000.csv"
        );
    }
}
