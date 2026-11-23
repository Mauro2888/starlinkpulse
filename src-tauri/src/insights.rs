//! Phase 6 views over the hourly table: best/worst times of day and daily energy.

use std::collections::BTreeMap;

use chrono::{NaiveDate, TimeZone};

use crate::models::{DailyEnergy, HourCell, TimeOfDayStats};
use crate::storage::{HourRow, merge_hour_rows};
use crate::usage::{date_key, local_midnight_ms};

/// Weekday × hour cells (local time), all locations together. At most 168 cells.
pub fn time_of_day(rows: &[HourRow], days: u32) -> TimeOfDayStats {
    let mut by: BTreeMap<(u8, u8), Vec<HourRow>> = BTreeMap::new();
    for r in rows {
        by.entry((r.weekday, r.hour)).or_default().push(r.clone());
    }
    let cells = by
        .into_iter()
        .filter_map(|((weekday, hour), rows)| {
            let m = merge_hour_rows(&rows)?;
            Some(HourCell {
                weekday,
                hour,
                minutes: m.minutes,
                latency_avg_ms: m.latency_avg_ms,
                latency_p95_ms: m.latency_p95_ms,
                drop_rate_avg: m.drop_rate_avg,
                downlink_avg_bps: m.downlink_avg_bps,
            })
        })
        .collect();
    TimeOfDayStats { days, cells }
}

/// Energy per local day for `dates` (oldest first, zero-filled).
pub fn daily_energy<Tz: TimeZone>(
    rows: &[HourRow],
    dates: &[NaiveDate],
    tz: &Tz,
) -> Vec<DailyEnergy> {
    let mut by: BTreeMap<i64, Vec<&HourRow>> = BTreeMap::new();
    for r in rows {
        by.entry(r.date_key).or_default().push(r);
    }
    dates
        .iter()
        .map(|d| {
            let rows = by.get(&date_key(*d)).map(Vec::as_slice).unwrap_or(&[]);
            let covered: f64 = rows.iter().map(|r| r.samples as f64).sum();
            let powered: Vec<(f64, f64)> = rows
                .iter()
                .filter_map(|r| r.power_avg_w.map(|w| (w, r.samples as f64)))
                .collect();
            let wh: f64 = powered.iter().map(|(w, s)| w * s).sum::<f64>() / 3600.0;
            let powered_s: f64 = powered.iter().map(|(_, s)| s).sum();
            DailyEnergy {
                day_ms: local_midnight_ms(*d, tz),
                wh: (wh * 10.0).round() / 10.0,
                avg_w: (powered_s > 0.0).then(|| (wh * 3600.0 / powered_s * 10.0).round() / 10.0),
                peak_w: rows.iter().filter_map(|r| r.power_max_w).reduce(f64::max),
                covered_s: covered,
            }
        })
        .collect()
}

/// The last `days` local dates, oldest first.
pub fn last_dates<Tz: TimeZone>(now_ms: i64, days: u32, tz: &Tz) -> Vec<NaiveDate> {
    let today = crate::usage::local_date(now_ms, tz);
    (0..days as i64)
        .rev()
        .filter_map(|b| today.checked_sub_signed(chrono::Duration::days(b)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        date: i64,
        hour: u8,
        weekday: u8,
        samples: u32,
        lat: f64,
        power: Option<f64>,
    ) -> HourRow {
        HourRow {
            date_key: date,
            hour,
            weekday,
            minutes: samples / 60,
            samples,
            latency_avg_ms: Some(lat),
            latency_p95_ms: Some(lat + 10.0),
            drop_rate_avg: Some(0.0),
            power_avg_w: power,
            power_max_w: power.map(|p| p + 5.0),
            ..Default::default()
        }
    }

    #[test]
    fn cells_merge_same_weekday_hour() {
        let rows = vec![
            row(20261116, 21, 0, 3600, 60.0, None), // Monday 21:00
            row(20261123, 21, 0, 1800, 30.0, None), // next Monday 21:00
            row(20261116, 9, 0, 3600, 25.0, None),
        ];
        let t = time_of_day(&rows, 14);
        assert_eq!(t.days, 14);
        assert_eq!(t.cells.len(), 2);
        let evening = t.cells.iter().find(|c| c.hour == 21).unwrap();
        assert_eq!(evening.weekday, 0);
        assert_eq!(evening.minutes, 90);
        assert!(
            (evening.latency_avg_ms.unwrap() - 50.0).abs() < 1e-9,
            "sample-weighted"
        );
    }

    #[test]
    fn energy_per_local_day_zero_filled() {
        let d1 = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
        let d2 = d1.succ_opt().unwrap();
        let rows = vec![
            row(20261120, 10, 4, 3600, 30.0, Some(30.0)),
            row(20261120, 11, 4, 1800, 30.0, Some(40.0)),
            row(20261120, 12, 4, 600, 30.0, None),
        ];
        let e = daily_energy(&rows, &[d1, d2], &chrono::Utc);
        assert_eq!(e.len(), 2);
        // 30 W × 1 h + 40 W × 0.5 h = 50 Wh over 1.5 h powered -> 33.3 W average.
        assert_eq!(e[0].wh, 50.0);
        assert_eq!(e[0].avg_w, Some(33.3));
        assert_eq!(e[0].peak_w, Some(45.0));
        assert_eq!(e[0].covered_s, 6000.0);
        assert_eq!((e[1].wh, e[1].avg_w, e[1].covered_s), (0.0, None, 0.0));
        assert!(e[0].day_ms < e[1].day_ms);
        assert_eq!(
            last_dates(e[1].day_ms + 1000, 2, &chrono::Utc),
            vec![d1, d2]
        );
    }
}
