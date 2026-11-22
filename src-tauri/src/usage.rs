//! Data usage estimate (throughput integrated per second) bucketed by LOCAL day, plus
//! billing-cycle helpers. All functions are generic over the time zone so DST behaviour is
//! unit-tested with a synthetic zone; production uses `chrono::Local`.

use std::collections::BTreeMap;

use chrono::{Datelike, Duration, NaiveDate, NaiveTime, TimeZone};

use crate::storage::Sample;

/// Unix ms of local midnight starting `date`. DST-safe: if midnight does not exist (gap),
/// the first existing local instant of that day is used.
pub fn local_midnight_ms<Tz: TimeZone>(date: NaiveDate, tz: &Tz) -> i64 {
    for minutes in (0..=180).step_by(15) {
        let t = date.and_time(NaiveTime::MIN) + Duration::minutes(minutes);
        if let Some(dt) = tz.from_local_datetime(&t).earliest() {
            return dt.timestamp_millis();
        }
    }
    // Unreachable for real zones; fall back to UTC midnight.
    date.and_time(NaiveTime::MIN).and_utc().timestamp_millis()
}

/// Local calendar date containing `ts_ms`.
pub fn local_date<Tz: TimeZone>(ts_ms: i64, tz: &Tz) -> NaiveDate {
    tz.timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt| dt.date_naive())
        .unwrap_or_else(|| {
            chrono::DateTime::from_timestamp_millis(ts_ms)
                .unwrap_or_default()
                .date_naive()
        })
}

/// Local midnight (Unix ms) of the day containing `ts_ms`.
pub fn local_day_start_ms<Tz: TimeZone>(ts_ms: i64, tz: &Tz) -> i64 {
    local_midnight_ms(local_date(ts_ms, tz), tz)
}

/// Local hour (0-23) at `ts_ms`.
pub fn local_hour<Tz: TimeZone>(ts_ms: i64, tz: &Tz) -> u8 {
    use chrono::Timelike;
    tz.timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt| dt.hour() as u8)
        .unwrap_or(0)
}

/// Storage key of a local calendar date: `YYYYMMDD` (e.g. 20261122).
pub fn date_key(d: NaiveDate) -> i64 {
    d.year() as i64 * 10_000 + d.month() as i64 * 100 + d.day() as i64
}

/// Inverse of [`date_key`].
pub fn date_from_key(key: i64) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(
        (key / 10_000) as i32,
        ((key / 100) % 100) as u32,
        (key % 100) as u32,
    )
}

/// Integrates per-second throughput into bytes per local calendar date:
/// `date_key (YYYYMMDD) -> (download_bytes, upload_bytes)`. Each sample covers one second.
pub fn usage_by_local_day<Tz: TimeZone>(samples: &[Sample], tz: &Tz) -> BTreeMap<i64, (f64, f64)> {
    let mut out: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
    // Cache the current day range to avoid a tz lookup per sample.
    let mut range: Option<(i64, i64, i64)> = None; // (start_ms, end_ms, key)
    for s in samples {
        let ts = s.ts_s * 1000;
        let key = match range {
            Some((a, b, k)) if ts >= a && ts < b => k,
            _ => {
                let date = local_date(ts, tz);
                let start = local_midnight_ms(date, tz);
                let end = date
                    .succ_opt()
                    .map(|d| local_midnight_ms(d, tz))
                    .unwrap_or(start + 86_400_000);
                let k = date_key(date);
                range = Some((start, end, k));
                k
            }
        };
        let e = out.entry(key).or_default();
        e.0 += s
            .downlink_bps
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0)
            / 8.0;
        e.1 += s
            .uplink_bps
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0)
            / 8.0;
    }
    out
}

/// Local midnight of the most recent billing-cycle start (`cycle_day` 1-28) at or before
/// `now_ms`.
pub fn cycle_start_ms<Tz: TimeZone>(now_ms: i64, cycle_day: u32, tz: &Tz) -> i64 {
    let day = cycle_day.clamp(1, 28);
    let today = local_date(now_ms, tz);
    let this_month = NaiveDate::from_ymd_opt(today.year(), today.month(), day).unwrap_or(today);
    let start = if today >= this_month {
        this_month
    } else {
        let (y, m) = if today.month() == 1 {
            (today.year() - 1, 12)
        } else {
            (today.year(), today.month() - 1)
        };
        NaiveDate::from_ymd_opt(y, m, day).unwrap_or(this_month)
    };
    local_midnight_ms(start, tz)
}

/// Local midnights of the last `days` local days, oldest first (today last).
pub fn last_local_days<Tz: TimeZone>(now_ms: i64, days: u32, tz: &Tz) -> Vec<i64> {
    let today = local_date(now_ms, tz);
    (0..days as i64)
        .rev()
        .filter_map(|back| today.checked_sub_signed(Duration::days(back)))
        .map(|d| local_midnight_ms(d, tz))
        .collect()
}

#[cfg(test)]
pub(crate) mod test_tz {
    //! Synthetic zone: UTC+1, switching to UTC+2 on 2026-03-29 01:00 UTC (EU rules for one
    //! spring transition) and back on 2026-10-25 01:00 UTC.

    use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, TimeZone};

    #[derive(Debug, Clone, Copy)]
    pub struct EuLike;

    fn spring() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 3, 29)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap()
    }
    fn autumn() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 25)
            .unwrap()
            .and_hms_opt(1, 0, 0)
            .unwrap()
    }
    fn off(h: i32) -> FixedOffset {
        FixedOffset::east_opt(h * 3600).unwrap()
    }
    fn offset_at_utc(utc: &NaiveDateTime) -> FixedOffset {
        if *utc >= spring() && *utc < autumn() {
            off(2)
        } else {
            off(1)
        }
    }

    impl TimeZone for EuLike {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            EuLike
        }
        fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<FixedOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<FixedOffset> {
            let valid: Vec<FixedOffset> = [off(1), off(2)]
                .into_iter()
                .filter(|o| {
                    let utc = *local - chrono::Duration::seconds(o.local_minus_utc() as i64);
                    offset_at_utc(&utc) == *o
                })
                .collect();
            match valid.as_slice() {
                [] => LocalResult::None,
                [a] => LocalResult::Single(*a),
                [a, b] => LocalResult::Ambiguous(*b, *a),
                _ => LocalResult::None,
            }
        }
        fn offset_from_utc_date(&self, utc: &NaiveDate) -> FixedOffset {
            offset_at_utc(&utc.and_hms_opt(0, 0, 0).unwrap())
        }
        fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
            offset_at_utc(utc)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_tz::EuLike;
    use super::*;

    fn ms(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, min, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis()
    }

    #[test]
    fn dst_spring_day_has_23_hours() {
        let tz = EuLike;
        let d = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
        let start = local_midnight_ms(d, &tz);
        let end = local_midnight_ms(d.succ_opt().unwrap(), &tz);
        assert_eq!(start, ms(2026, 3, 28, 23, 0)); // 00:00 CET
        assert_eq!(end, ms(2026, 3, 29, 22, 0)); // 00:00 CEST
        assert_eq!(end - start, 23 * 3_600_000);
        // Autumn day: 25 h.
        let a = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap();
        assert_eq!(
            local_midnight_ms(a.succ_opt().unwrap(), &tz) - local_midnight_ms(a, &tz),
            25 * 3_600_000
        );
    }

    #[test]
    fn usage_buckets_follow_local_days_across_dst() {
        let tz = EuLike;
        // One sample per second from 2026-03-28 22:30 UTC to 2026-03-29 22:30 UTC.
        let from = ms(2026, 3, 28, 22, 30) / 1000;
        let samples: Vec<Sample> = (0..86_400)
            .map(|i| Sample {
                ts_s: from + i,
                downlink_bps: Some(8_000.0), // 1000 B/s
                uplink_bps: Some(800.0),     // 100 B/s
                ..Default::default()
            })
            .collect();
        let m = usage_by_local_day(&samples, &tz);
        let keys: Vec<i64> = m.keys().copied().collect();
        let (d28, d29, d30) = (20260328, 20260329, 20260330);
        assert_eq!(keys, vec![d28, d29, d30]);
        assert_eq!(date_from_key(d29), NaiveDate::from_ymd_opt(2026, 3, 29));
        assert_eq!(
            date_key(NaiveDate::from_ymd_opt(2027, 1, 5).unwrap()),
            20270105
        );
        assert_eq!(date_from_key(20261340), None);
        // 22:30-23:00 UTC = 30 min on the 28th; the 29th is a 23 h local day.
        assert_eq!(m[&d28].0, 1800.0 * 1000.0);
        assert_eq!(m[&d29].0, 23.0 * 3600.0 * 1000.0);
        assert_eq!(m[&d30].0, 1800.0 * 1000.0);
        assert_eq!(m[&d29].1, 23.0 * 3600.0 * 100.0);
        let total: f64 = m.values().map(|v| v.0).sum();
        assert_eq!(total, 86_400.0 * 1000.0);
    }

    #[test]
    fn negative_or_nan_throughput_is_ignored() {
        let s = [Sample {
            ts_s: 0,
            downlink_bps: Some(-5.0),
            uplink_bps: Some(f64::NAN),
            ..Default::default()
        }];
        let m = usage_by_local_day(&s, &chrono::Utc);
        assert_eq!(m.values().next(), Some(&(0.0, 0.0)));
    }

    #[test]
    fn billing_cycle_start() {
        let tz = EuLike;
        let day = |y, m, d| local_midnight_ms(NaiveDate::from_ymd_opt(y, m, d).unwrap(), &tz);
        // 2026-11-22 12:00 UTC, cycle day 15 -> Nov 15.
        assert_eq!(
            cycle_start_ms(ms(2026, 11, 22, 12, 0), 15, &tz),
            day(2026, 11, 15)
        );
        // Cycle day 28 -> Oct 28 (crosses the autumn DST change).
        assert_eq!(
            cycle_start_ms(ms(2026, 11, 22, 12, 0), 28, &tz),
            day(2026, 10, 28)
        );
        // January with cycle day 20 on Jan 5 -> Dec 20 of the previous year.
        assert_eq!(
            cycle_start_ms(ms(2027, 1, 5, 12, 0), 20, &tz),
            day(2026, 12, 20)
        );
        // On the cycle day itself the cycle starts today.
        assert_eq!(
            cycle_start_ms(ms(2026, 11, 1, 0, 30), 1, &tz),
            day(2026, 11, 1)
        );
        // Local midnight boundary: 2026-10-31 23:30 UTC is already Nov 1 local (UTC+1).
        assert_eq!(
            cycle_start_ms(ms(2026, 10, 31, 23, 30), 1, &tz),
            day(2026, 11, 1)
        );
    }

    #[test]
    fn last_days_are_consecutive_local_midnights() {
        let tz = EuLike;
        let days = last_local_days(ms(2026, 3, 30, 12, 0), 3, &tz);
        assert_eq!(days.len(), 3);
        // Mar 28, 29 (23 h DST day), 30.
        assert_eq!(days[1] - days[0], 24 * 3_600_000);
        assert_eq!(days[2] - days[1], 23 * 3_600_000, "DST day");
        assert_eq!(local_hour(ms(2026, 3, 30, 12, 0), &tz), 14);
    }
}
