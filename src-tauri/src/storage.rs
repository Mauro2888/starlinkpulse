//! Local persistence (ADR-004): SQLite in `app_data_dir`.
//!
//! `get_history` ring buffers are ingested every few minutes. New samples are selected with
//! the `current` counter (dedupe, wrap-around, partial buffer, reboot reset), kept raw for a
//! short window and aggregated per minute. Outages/events are upserted. Retention: raw
//! samples 2 h, minute aggregates and events 48 h, daily aggregates 90 days.

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::dish::DishHistory;
use crate::models::{AiReport, DishEvent, HistoryPoint};
use crate::time::{DAY_MS, MINUTE_MS, day_floor, minute_floor};

pub const RAW_RETENTION_MS: i64 = 2 * 3_600_000;
pub const MINUTE_RETENTION_MS: i64 = 48 * 3_600_000;
pub const DAILY_RETENTION_MS: i64 = 90 * DAY_MS;
/// Maximum `rangeMinutes` accepted by history/event queries.
pub const MAX_RANGE_MINUTES: u32 = 48 * 60;

/// One per-second sample with an absolute timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Sample {
    pub ts_s: i64,
    pub latency_ms: Option<f64>,
    pub drop_rate: Option<f64>,
    pub downlink_bps: Option<f64>,
    pub uplink_bps: Option<f64>,
    pub power_w: Option<f64>,
}

/// Daily aggregate (kept 90 days; used by uptime / data usage features).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAggregate {
    pub day_ms: i64,
    pub samples: u32,
    pub latency_avg_ms: Option<f64>,
    pub drop_rate_avg: Option<f64>,
    pub downlink_bytes: f64,
    pub uplink_bytes: f64,
    pub energy_wh: Option<f64>,
    pub outage_count: u32,
    pub outage_s: f64,
}

/// Result of one ingest.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IngestReport {
    pub new_samples: usize,
    pub counter_reset: bool,
    pub minutes_updated: usize,
    pub events: usize,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Range of sample counters `[start, end)` that are new since `last_current`.
///
/// - first ingest: everything available (`min(current, buf_len)` samples);
/// - `current < last_current`: counter reset (reboot) -> everything available;
/// - otherwise only `current - last_current`, capped at the buffer length (older samples
///   were overwritten if the app was not running).
pub fn plan_new_samples(
    current: u64,
    buf_len: usize,
    last_current: Option<u64>,
) -> (u64, u64, bool) {
    let buf = buf_len as u64;
    let available = current.min(buf);
    let (count, reset) = match last_current {
        None => (available, false),
        Some(last) if current < last => (available, true),
        Some(last) => ((current - last).min(available), false),
    };
    (current - count, current, reset)
}

fn at(v: &[Option<f64>], idx: usize) -> Option<f64> {
    v.get(idx).copied().flatten()
}

/// Extracts the new samples from a ring buffer. The newest sample (`current - 1`) is
/// timestamped `fetch_s`.
pub fn extract_samples(
    h: &DishHistory,
    fetch_s: i64,
    last_current: Option<u64>,
) -> (Vec<Sample>, bool) {
    let buf_len = h.buffer_len();
    if buf_len == 0 || h.current == 0 {
        return (Vec::new(), last_current.is_some_and(|l| h.current < l));
    }
    let (start, end, reset) = plan_new_samples(h.current, buf_len, last_current);
    let samples = (start..end)
        .map(|c| {
            let idx = (c % buf_len as u64) as usize;
            Sample {
                ts_s: fetch_s - (end - 1 - c) as i64,
                latency_ms: at(&h.latency_ms, idx),
                drop_rate: at(&h.drop_rate, idx),
                downlink_bps: at(&h.downlink_bps, idx),
                uplink_bps: at(&h.uplink_bps, idx),
                power_w: at(&h.power_w, idx),
            }
        })
        .collect();
    (samples, reset)
}

/// Nearest-rank 95th percentile of an ascending slice.
pub fn p95(sorted: &[f64]) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (0.95 * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

fn avg(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

fn max(v: &[f64]) -> Option<f64> {
    v.iter().copied().reduce(f64::max)
}

/// Aggregates one bucket of samples. Latency is ignored for fully dropped seconds.
fn aggregate_bucket(minute_ms: i64, samples: &[Sample]) -> HistoryPoint {
    let mut lat: Vec<f64> = samples
        .iter()
        .filter(|s| s.drop_rate.unwrap_or(0.0) < 1.0)
        .filter_map(|s| s.latency_ms)
        .filter(|l| *l > 0.0)
        .collect();
    lat.sort_by(f64::total_cmp);
    let pick = |f: fn(&Sample) -> Option<f64>| samples.iter().filter_map(f).collect::<Vec<_>>();
    let drop = pick(|s| s.drop_rate);
    let dl = pick(|s| s.downlink_bps);
    let ul = pick(|s| s.uplink_bps);
    let pw = pick(|s| s.power_w);
    HistoryPoint {
        minute_ms,
        samples: samples.len() as u32,
        latency_avg_ms: avg(&lat),
        latency_p95_ms: p95(&lat),
        latency_max_ms: max(&lat),
        drop_rate_avg: avg(&drop),
        downlink_avg_bps: avg(&dl),
        downlink_max_bps: max(&dl),
        uplink_avg_bps: avg(&ul),
        uplink_max_bps: max(&ul),
        power_avg_w: avg(&pw),
        power_max_w: max(&pw),
    }
}

/// Groups samples by minute and aggregates each minute (ascending).
pub fn aggregate_minutes(samples: &[Sample]) -> Vec<HistoryPoint> {
    let mut sorted: Vec<Sample> = samples.to_vec();
    sorted.sort_by_key(|s| s.ts_s);
    sorted
        .chunk_by(|a, b| minute_floor(a.ts_s * 1000) == minute_floor(b.ts_s * 1000))
        .map(|chunk| aggregate_bucket(minute_floor(chunk[0].ts_s * 1000), chunk))
        .collect()
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/// Ordered schema migrations; index + 1 = schema version.
const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE samples (
    ts_s INTEGER PRIMARY KEY,
    latency_ms REAL, drop_rate REAL, downlink_bps REAL, uplink_bps REAL, power_w REAL
);
CREATE TABLE minutes (
    minute_ms INTEGER PRIMARY KEY,
    samples INTEGER NOT NULL,
    latency_avg_ms REAL, latency_p95_ms REAL, latency_max_ms REAL,
    drop_rate_avg REAL,
    downlink_avg_bps REAL, downlink_max_bps REAL,
    uplink_avg_bps REAL, uplink_max_bps REAL,
    power_avg_w REAL, power_max_w REAL
);
CREATE TABLE events (
    start_ms INTEGER NOT NULL,
    cause TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    severity TEXT,
    is_outage INTEGER NOT NULL DEFAULT 1
);
-- One outage per start instant (outages[] and eventLog describe the same outage, sometimes
-- with different causes); other events are unique per (start, cause).
CREATE UNIQUE INDEX events_outage_start ON events (start_ms) WHERE is_outage = 1;
CREATE UNIQUE INDEX events_other_start_cause ON events (start_ms, cause) WHERE is_outage = 0;
CREATE INDEX events_start ON events (start_ms);
CREATE TABLE daily (
    day_ms INTEGER PRIMARY KEY,
    samples INTEGER NOT NULL,
    latency_avg_ms REAL, drop_rate_avg REAL,
    downlink_bytes REAL NOT NULL, uplink_bytes REAL NOT NULL,
    energy_wh REAL,
    outage_count INTEGER NOT NULL, outage_s REAL NOT NULL
);
"#,
    r#"
-- Minutes in which a live snapshot reported POLICY_LIMIT (plan deprioritization).
CREATE TABLE throttle_minutes (minute_ms INTEGER PRIMARY KEY);
-- Last AI advisor report (single row).
CREATE TABLE ai_report (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
"#,
];

const LAST_CURRENT_KEY: &str = "history_last_current";
const BOOT_KEY: &str = "history_last_boot";

/// Dish boot markers read from `get_status` at ingest time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BootInfo {
    pub uptime_s: Option<u64>,
    pub bootcount: Option<u64>,
}

/// Tolerance between expected and reported uptime before assuming a reboot.
pub const REBOOT_SLACK_S: i64 = 120;

/// True when the dish rebooted between two ingests: bootcount changed, or the uptime is
/// lower than the previous uptime plus the elapsed wall time.
pub fn detect_reboot(
    prev: &BootInfo,
    prev_fetch_ms: i64,
    now: &BootInfo,
    now_fetch_ms: i64,
) -> bool {
    if let (Some(a), Some(b)) = (prev.bootcount, now.bootcount)
        && a != b
    {
        return true;
    }
    if let (Some(a), Some(b)) = (prev.uptime_s, now.uptime_s) {
        let elapsed = ((now_fetch_ms - prev_fetch_ms) / 1000).max(0);
        return (b as i64) + REBOOT_SLACK_S < a as i64 + elapsed;
    }
    false
}

/// SQLite store. Not `Sync`; wrap in a mutex.
#[derive(Debug)]
pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, rusqlite::Error> {
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn schema_version(&self) -> Result<u32, rusqlite::Error> {
        self.conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
    }

    fn migrate(&mut self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);",
        )?;
        let current: Option<u32> = self
            .conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .optional()?;
        let current = match current {
            Some(v) => v,
            None => {
                self.conn
                    .execute("INSERT INTO schema_version (version) VALUES (0)", [])?;
                0
            }
        };
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute("UPDATE schema_version SET version = ?1", [i as u32 + 1])?;
            tx.commit()?;
            tracing::info!(version = i + 1, "database migrated");
        }
        Ok(())
    }

    fn last_current(&self) -> Result<Option<u64>, rusqlite::Error> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [LAST_CURRENT_KEY],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.and_then(|s| s.parse().ok()))
    }

    fn last_boot(&self) -> Result<Option<(BootInfo, i64)>, rusqlite::Error> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [BOOT_KEY], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(
            v.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|j| {
                    let fetch = j.get("fetchMs")?.as_i64()?;
                    Some((
                        BootInfo {
                            uptime_s: j.get("uptimeS").and_then(serde_json::Value::as_u64),
                            bootcount: j.get("bootcount").and_then(serde_json::Value::as_u64),
                        },
                        fetch,
                    ))
                }),
        )
    }

    /// True when no minute aggregates exist yet.
    pub fn is_empty(&self) -> Result<bool, rusqlite::Error> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM minutes", [], |r| r.get(0))?;
        Ok(n == 0)
    }

    /// Ingests one `get_history` response fetched at `fetch_ms`.
    pub fn ingest_history(
        &mut self,
        h: &DishHistory,
        fetch_ms: i64,
    ) -> Result<IngestReport, rusqlite::Error> {
        self.ingest_history_with_boot(h, fetch_ms, None)
    }

    /// Like [`Self::ingest_history`], also detecting reboots from uptime/bootcount (the
    /// `current` counter alone misses a reboot when it has grown past its old value).
    pub fn ingest_history_with_boot(
        &mut self,
        h: &DishHistory,
        fetch_ms: i64,
        boot: Option<BootInfo>,
    ) -> Result<IngestReport, rusqlite::Error> {
        let last = self.last_current()?;
        let prev_boot = self.last_boot()?;
        let rebooted = match (&prev_boot, &boot) {
            (Some((prev, prev_ms)), Some(now)) => detect_reboot(prev, *prev_ms, now, fetch_ms),
            _ => false,
        };
        let (samples, counter_reset) = extract_samples(
            h,
            fetch_ms.div_euclid(1000),
            if rebooted { None } else { last },
        );
        let reset = counter_reset || rebooted;
        if reset {
            tracing::info!("history counter reset detected (dish reboot)");
        }
        let tx = self.conn.transaction()?;
        let mut minutes = BTreeSet::new();
        {
            let mut ins = tx.prepare_cached(
                "INSERT OR REPLACE INTO samples
                 (ts_s, latency_ms, drop_rate, downlink_bps, uplink_bps, power_w)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for s in &samples {
                ins.execute(params![
                    s.ts_s,
                    s.latency_ms,
                    s.drop_rate,
                    s.downlink_bps,
                    s.uplink_bps,
                    s.power_w
                ])?;
                minutes.insert(minute_floor(s.ts_s * 1000));
            }
        }
        // Recompute every touched minute from raw samples so partial minutes merge exactly.
        let mut points = Vec::with_capacity(minutes.len());
        for &m in &minutes {
            let bucket = load_samples(&tx, m / 1000, m / 1000 + 60)?;
            points.push(aggregate_bucket(m, &bucket));
        }
        upsert_minutes(&tx, &points)?;

        let mut all_events: Vec<(DishEvent, bool)> = Vec::new();
        all_events.extend(h.outages.iter().cloned().map(|e| (e, true)));
        all_events.extend(h.events.iter().cloned().map(|e| (e, true)));
        all_events.extend(h.other_events.iter().cloned().map(|e| (e, false)));
        upsert_events(&tx, &all_events)?;

        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![LAST_CURRENT_KEY, h.current.to_string()],
        )?;
        if let Some(b) = boot {
            let json = serde_json::json!({
                "uptimeS": b.uptime_s, "bootcount": b.bootcount, "fetchMs": fetch_ms
            });
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                params![BOOT_KEY, json.to_string()],
            )?;
        }

        let mut days: BTreeSet<i64> = minutes.iter().map(|m| day_floor(*m)).collect();
        days.extend(all_events.iter().map(|(e, _)| day_floor(e.start_ms)));
        recompute_days(&tx, &days, fetch_ms)?;
        prune(&tx, fetch_ms)?;
        tx.commit()?;
        Ok(IngestReport {
            new_samples: samples.len(),
            counter_reset: reset,
            minutes_updated: points.len(),
            events: all_events.len(),
        })
    }

    /// Inserts pre-aggregated minutes and events (used to backfill mock data).
    pub fn insert_backfill(
        &mut self,
        points: &[HistoryPoint],
        events: &[DishEvent],
        now_ms: i64,
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.transaction()?;
        upsert_minutes(&tx, points)?;
        let evs: Vec<(DishEvent, bool)> = events.iter().cloned().map(|e| (e, true)).collect();
        upsert_events(&tx, &evs)?;
        let days: BTreeSet<i64> = points.iter().map(|p| day_floor(p.minute_ms)).collect();
        recompute_days(&tx, &days, now_ms)?;
        prune(&tx, now_ms)?;
        tx.commit()
    }

    /// Minute aggregates of the last `range_minutes`, ascending.
    pub fn history(
        &self,
        range_minutes: u32,
        now_ms: i64,
    ) -> Result<Vec<HistoryPoint>, rusqlite::Error> {
        let since = now_ms - range_minutes as i64 * MINUTE_MS;
        let mut stmt = self.conn.prepare_cached(
            "SELECT minute_ms, samples, latency_avg_ms, latency_p95_ms, latency_max_ms,
                    drop_rate_avg, downlink_avg_bps, downlink_max_bps, uplink_avg_bps,
                    uplink_max_bps, power_avg_w, power_max_w
             FROM minutes WHERE minute_ms >= ?1 ORDER BY minute_ms ASC",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(HistoryPoint {
                minute_ms: r.get(0)?,
                samples: r.get(1)?,
                latency_avg_ms: r.get(2)?,
                latency_p95_ms: r.get(3)?,
                latency_max_ms: r.get(4)?,
                drop_rate_avg: r.get(5)?,
                downlink_avg_bps: r.get(6)?,
                downlink_max_bps: r.get(7)?,
                uplink_avg_bps: r.get(8)?,
                uplink_max_bps: r.get(9)?,
                power_avg_w: r.get(10)?,
                power_max_w: r.get(11)?,
            })
        })?;
        rows.collect()
    }

    /// Events overlapping the last `range_minutes`, ascending by start.
    pub fn events(
        &self,
        range_minutes: u32,
        now_ms: i64,
    ) -> Result<Vec<DishEvent>, rusqlite::Error> {
        let since = now_ms - range_minutes as i64 * MINUTE_MS;
        let mut stmt = self.conn.prepare_cached(
            "SELECT start_ms, duration_ms, cause, severity FROM events
             WHERE start_ms + duration_ms >= ?1 ORDER BY start_ms ASC, cause ASC",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(DishEvent {
                start_ms: r.get(0)?,
                duration_ms: r.get(1)?,
                cause: r.get(2)?,
                severity: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Outages (not other events) overlapping the last `range_minutes`, ascending.
    pub fn outages(
        &self,
        range_minutes: u32,
        now_ms: i64,
    ) -> Result<Vec<DishEvent>, rusqlite::Error> {
        let since = now_ms - range_minutes as i64 * MINUTE_MS;
        let mut stmt = self.conn.prepare_cached(
            "SELECT start_ms, duration_ms, cause, severity FROM events
             WHERE is_outage = 1 AND start_ms + duration_ms >= ?1 ORDER BY start_ms ASC",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(DishEvent {
                start_ms: r.get(0)?,
                duration_ms: r.get(1)?,
                cause: r.get(2)?,
                severity: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Flags the minute containing `ts_ms` as throttled (`POLICY_LIMIT`).
    pub fn mark_throttled(&self, ts_ms: i64) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO throttle_minutes (minute_ms) VALUES (?1)",
            [minute_floor(ts_ms)],
        )?;
        Ok(())
    }

    /// Number of throttled minutes in the last `range_minutes`.
    pub fn throttled_minutes(
        &self,
        range_minutes: u32,
        now_ms: i64,
    ) -> Result<u32, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM throttle_minutes WHERE minute_ms >= ?1",
            [now_ms - range_minutes as i64 * MINUTE_MS],
            |r| r.get(0),
        )
    }

    pub fn save_ai_report(&self, report: &AiReport) -> Result<(), rusqlite::Error> {
        let json = serde_json::to_string(report)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        self.conn.execute(
            "INSERT OR REPLACE INTO ai_report (id, json) VALUES (1, ?1)",
            [json],
        )?;
        Ok(())
    }

    /// Last stored AI report; an unreadable row (older format) yields `None`.
    pub fn last_ai_report(&self) -> Result<Option<AiReport>, rusqlite::Error> {
        let json: Option<String> = self
            .conn
            .query_row("SELECT json FROM ai_report WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
    }

    /// Daily aggregates of the last `days` days, ascending.
    pub fn daily(&self, days: u32, now_ms: i64) -> Result<Vec<DailyAggregate>, rusqlite::Error> {
        let since = day_floor(now_ms) - (days as i64 - 1).max(0) * DAY_MS;
        let mut stmt = self.conn.prepare_cached(
            "SELECT day_ms, samples, latency_avg_ms, drop_rate_avg, downlink_bytes,
                    uplink_bytes, energy_wh, outage_count, outage_s
             FROM daily WHERE day_ms >= ?1 ORDER BY day_ms ASC",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(DailyAggregate {
                day_ms: r.get(0)?,
                samples: r.get(1)?,
                latency_avg_ms: r.get(2)?,
                drop_rate_avg: r.get(3)?,
                downlink_bytes: r.get(4)?,
                uplink_bytes: r.get(5)?,
                energy_wh: r.get(6)?,
                outage_count: r.get(7)?,
                outage_s: r.get(8)?,
            })
        })?;
        rows.collect()
    }
}

fn load_samples(conn: &Connection, from_s: i64, to_s: i64) -> Result<Vec<Sample>, rusqlite::Error> {
    let mut stmt = conn.prepare_cached(
        "SELECT ts_s, latency_ms, drop_rate, downlink_bps, uplink_bps, power_w
         FROM samples WHERE ts_s >= ?1 AND ts_s < ?2 ORDER BY ts_s",
    )?;
    let rows = stmt.query_map([from_s, to_s], |r| {
        Ok(Sample {
            ts_s: r.get(0)?,
            latency_ms: r.get(1)?,
            drop_rate: r.get(2)?,
            downlink_bps: r.get(3)?,
            uplink_bps: r.get(4)?,
            power_w: r.get(5)?,
        })
    })?;
    rows.collect()
}

fn upsert_minutes(conn: &Connection, points: &[HistoryPoint]) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare_cached(
        "INSERT OR REPLACE INTO minutes
         (minute_ms, samples, latency_avg_ms, latency_p95_ms, latency_max_ms, drop_rate_avg,
          downlink_avg_bps, downlink_max_bps, uplink_avg_bps, uplink_max_bps,
          power_avg_w, power_max_w)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )?;
    for p in points {
        stmt.execute(params![
            p.minute_ms,
            p.samples,
            p.latency_avg_ms,
            p.latency_p95_ms,
            p.latency_max_ms,
            p.drop_rate_avg,
            p.downlink_avg_bps,
            p.downlink_max_bps,
            p.uplink_avg_bps,
            p.uplink_max_bps,
            p.power_avg_w,
            p.power_max_w
        ])?;
    }
    Ok(())
}

/// Raw outages and event-log outages describing the same outage may differ by ~1 s.
pub const OUTAGE_MERGE_TOLERANCE_MS: i64 = 2_000;

/// Merges the cause of two records of the same outage. The event log (has a severity) gives
/// the user-facing classification (e.g. OBSTRUCTED instead of SKY_SEARCH), but a generic
/// `UNKNOWN` never replaces a specific cause.
pub fn merge_outage_cause(existing: &str, incoming: &str, incoming_has_severity: bool) -> String {
    let incoming_specific = incoming != "UNKNOWN";
    if incoming_specific && (existing == "UNKNOWN" || incoming_has_severity) {
        incoming.to_string()
    } else {
        existing.to_string()
    }
}

fn upsert_events(conn: &Connection, events: &[(DishEvent, bool)]) -> Result<(), rusqlite::Error> {
    let mut find = conn.prepare_cached(
        "SELECT rowid, cause, duration_ms, severity FROM events
         WHERE is_outage = 1 AND start_ms BETWEEN ?1 - ?2 AND ?1 + ?2
         ORDER BY ABS(start_ms - ?1) LIMIT 1",
    )?;
    let mut update = conn.prepare_cached(
        "UPDATE events SET cause = ?2, duration_ms = ?3, severity = ?4 WHERE rowid = ?1",
    )?;
    let mut insert_outage = conn.prepare_cached(
        "INSERT OR IGNORE INTO events (start_ms, cause, duration_ms, severity, is_outage)
         VALUES (?1, ?2, ?3, ?4, 1)",
    )?;
    let mut other = conn.prepare_cached(
        "INSERT INTO events (start_ms, cause, duration_ms, severity, is_outage)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT (start_ms, cause) WHERE is_outage = 0 DO UPDATE SET
            duration_ms = MAX(events.duration_ms, excluded.duration_ms),
            severity = COALESCE(excluded.severity, events.severity)",
    )?;
    for (e, is_outage) in events {
        if !*is_outage {
            other.execute(params![e.start_ms, e.cause, e.duration_ms, e.severity])?;
            continue;
        }
        let existing = find
            .query_row(params![e.start_ms, OUTAGE_MERGE_TOLERANCE_MS], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .optional()?;
        match existing {
            Some((rowid, cause, duration, severity)) => {
                let cause = merge_outage_cause(&cause, &e.cause, e.severity.is_some());
                update.execute(params![
                    rowid,
                    cause,
                    duration.max(e.duration_ms),
                    e.severity.clone().or(severity)
                ])?;
            }
            None => {
                insert_outage.execute(params![e.start_ms, e.cause, e.duration_ms, e.severity])?;
            }
        }
    }
    Ok(())
}

/// Raw sums for one day: samples, weighted latency, latency samples, weighted drop rate,
/// downlink bytes, uplink bytes, energy (Wh).
type DayRow = (
    i64,
    Option<f64>,
    Option<i64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
);

/// Recomputes daily aggregates. Days older than the minute retention are skipped because
/// their minute data may already be partially pruned.
fn recompute_days(
    conn: &Connection,
    days: &BTreeSet<i64>,
    now_ms: i64,
) -> Result<(), rusqlite::Error> {
    for &day in days {
        if day < now_ms - MINUTE_RETENTION_MS {
            continue;
        }
        let end = day + DAY_MS;
        let (samples, lat_w, lat_n, drop_w, dl_bytes, ul_bytes, energy): DayRow = conn.query_row(
            "SELECT COALESCE(SUM(samples), 0),
                    SUM(latency_avg_ms * samples), SUM(CASE WHEN latency_avg_ms IS NOT NULL THEN samples END),
                    SUM(drop_rate_avg * samples),
                    SUM(downlink_avg_bps * samples) / 8.0,
                    SUM(uplink_avg_bps * samples) / 8.0,
                    SUM(power_avg_w * samples) / 3600.0
             FROM minutes WHERE minute_ms >= ?1 AND minute_ms < ?2",
            [day, end],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )?;
        let (outage_count, outage_ms): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(duration_ms), 0) FROM events
             WHERE is_outage = 1 AND start_ms >= ?1 AND start_ms < ?2",
            [day, end],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let latency_avg = match (lat_w, lat_n) {
            (Some(w), Some(n)) if n > 0 => Some(w / n as f64),
            _ => None,
        };
        let drop_avg = drop_w.filter(|_| samples > 0).map(|w| w / samples as f64);
        conn.execute(
            "INSERT OR REPLACE INTO daily
             (day_ms, samples, latency_avg_ms, drop_rate_avg, downlink_bytes, uplink_bytes,
              energy_wh, outage_count, outage_s)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                day,
                samples,
                latency_avg,
                drop_avg,
                dl_bytes.unwrap_or(0.0),
                ul_bytes.unwrap_or(0.0),
                energy,
                outage_count,
                outage_ms as f64 / 1000.0
            ],
        )?;
    }
    Ok(())
}

fn prune(conn: &Connection, now_ms: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM samples WHERE ts_s < ?1",
        [(now_ms - RAW_RETENTION_MS) / 1000],
    )?;
    conn.execute(
        "DELETE FROM minutes WHERE minute_ms < ?1",
        [now_ms - MINUTE_RETENTION_MS],
    )?;
    conn.execute(
        "DELETE FROM events WHERE start_ms + duration_ms < ?1",
        [now_ms - MINUTE_RETENTION_MS],
    )?;
    conn.execute(
        "DELETE FROM daily WHERE day_ms < ?1",
        [now_ms - DAILY_RETENTION_MS],
    )?;
    conn.execute(
        "DELETE FROM throttle_minutes WHERE minute_ms < ?1",
        [now_ms - MINUTE_RETENTION_MS],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(current: u64, len: usize, latency_of_counter: impl Fn(u64) -> f64) -> DishHistory {
        let mut lat = vec![Some(0.0); len];
        let first = current.saturating_sub(len as u64);
        for c in first..current {
            lat[(c % len as u64) as usize] = Some(latency_of_counter(c));
        }
        DishHistory {
            current,
            latency_ms: lat,
            drop_rate: vec![Some(0.0); len],
            downlink_bps: vec![Some(8_000.0); len],
            uplink_bps: vec![Some(800.0); len],
            power_w: vec![Some(30.0); len],
            ..Default::default()
        }
    }

    #[test]
    fn plan_first_ingest_partial_buffer() {
        assert_eq!(plan_new_samples(120, 900, None), (0, 120, false));
        assert_eq!(plan_new_samples(5000, 900, None), (4100, 5000, false));
        assert_eq!(plan_new_samples(0, 900, None), (0, 0, false));
    }

    #[test]
    fn plan_incremental_and_gap() {
        assert_eq!(plan_new_samples(5300, 900, Some(5000)), (5000, 5300, false));
        // Nothing new.
        assert_eq!(plan_new_samples(5000, 900, Some(5000)), (5000, 5000, false));
        // App was closed longer than the buffer: only the buffer is available.
        assert_eq!(plan_new_samples(9000, 900, Some(5000)), (8100, 9000, false));
    }

    #[test]
    fn plan_counter_reset() {
        assert_eq!(plan_new_samples(40, 900, Some(5000)), (0, 40, true));
        assert_eq!(plan_new_samples(1200, 900, Some(5000)), (300, 1200, true));
    }

    #[test]
    fn extract_handles_wrap_around() {
        // current = 905: counters 5..905; counter 900..904 wrapped to indices 0..4.
        let h = history(905, 900, |c| c as f64);
        let (s, reset) = extract_samples(&h, 10_000, Some(895));
        assert!(!reset);
        let lat: Vec<f64> = s.iter().map(|x| x.latency_ms.unwrap()).collect();
        assert_eq!(
            lat,
            vec![
                895.0, 896.0, 897.0, 898.0, 899.0, 900.0, 901.0, 902.0, 903.0, 904.0
            ]
        );
        assert_eq!(s.first().unwrap().ts_s, 10_000 - 9);
        assert_eq!(s.last().unwrap().ts_s, 10_000);
    }

    #[test]
    fn p95_and_aggregation() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(p95(&v), Some(95.0));
        assert_eq!(p95(&[7.0]), Some(7.0));
        assert_eq!(p95(&[]), None);

        // 60 s in minute 0 (latency 1..=60, one fully dropped second), 30 s in minute 1.
        let mut samples: Vec<Sample> = (0..90)
            .map(|i| Sample {
                ts_s: i,
                latency_ms: Some((i % 60 + 1) as f64),
                drop_rate: Some(0.0),
                downlink_bps: Some(1000.0),
                uplink_bps: Some(100.0 * (i % 2) as f64),
                power_w: None,
            })
            .collect();
        samples[59].drop_rate = Some(1.0); // latency 60 must be ignored
        let pts = aggregate_minutes(&samples);
        assert_eq!(pts.len(), 2);
        let m0 = &pts[0];
        assert_eq!(m0.minute_ms, 0);
        assert_eq!(m0.samples, 60);
        assert_eq!(m0.latency_max_ms, Some(59.0));
        assert_eq!(m0.latency_avg_ms, Some(30.0));
        assert_eq!(m0.latency_p95_ms, Some(57.0)); // ceil(0.95*59)=57th value
        assert!((m0.drop_rate_avg.unwrap() - 1.0 / 60.0).abs() < 1e-12);
        assert_eq!(m0.uplink_max_bps, Some(100.0));
        assert_eq!(m0.power_avg_w, None);
        assert_eq!(pts[1].minute_ms, 60_000);
        assert_eq!(pts[1].samples, 30);
    }

    #[test]
    fn migrations_are_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "starlinkpulse-db-test-{}-{}",
            std::process::id(),
            crate::time::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.db");
        let db = Db::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as u32);
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len() as u32);
        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ingest_dedupes_and_merges_partial_minutes() {
        let mut db = Db::open_in_memory().unwrap();
        let base_s: i64 = 1_800_000_000; // multiple of 60: aligned to a minute
        // First fetch: 30 samples, newest at base+29.
        let h1 = history(30, 900, |_| 20.0);
        let r1 = db.ingest_history(&h1, (base_s + 29) * 1000).unwrap();
        assert_eq!(r1.new_samples, 30);
        // Same response again: nothing new.
        let r_dup = db.ingest_history(&h1, (base_s + 29) * 1000).unwrap();
        assert_eq!(r_dup.new_samples, 0);
        // Second fetch 60 s later: 60 new samples.
        let h2 = history(90, 900, |c| if c < 30 { 20.0 } else { 40.0 });
        let r2 = db.ingest_history(&h2, (base_s + 89) * 1000).unwrap();
        assert_eq!(r2.new_samples, 60);

        let now = (base_s + 90) * 1000;
        let pts = db.history(60, now).unwrap();
        assert_eq!(pts.len(), 2);
        // Minute 0 merged across both ingests: 30 x 20 ms + 30 x 40 ms.
        assert_eq!(pts[0].samples, 60);
        assert_eq!(pts[0].latency_avg_ms, Some(30.0));
        assert_eq!(pts[0].latency_p95_ms, Some(40.0));
        assert_eq!(pts[1].samples, 30);
        // Ascending order.
        assert!(pts[0].minute_ms < pts[1].minute_ms);

        let daily = db.daily(1, now).unwrap();
        assert_eq!(daily.len(), 1);
        assert_eq!(daily[0].samples, 90);
        assert!((daily[0].downlink_bytes - 90.0 * 8_000.0 / 8.0).abs() < 1e-6);
        assert!((daily[0].energy_wh.unwrap() - 90.0 * 30.0 / 3600.0).abs() < 1e-9);
    }

    #[test]
    fn ingest_after_reboot_resets_counter() {
        let mut db = Db::open_in_memory().unwrap();
        let t0: i64 = 1_800_000_000;
        db.ingest_history(&history(5000, 900, |_| 25.0), t0 * 1000)
            .unwrap();
        // Reboot: counter restarts; 40 s of new data.
        let r = db
            .ingest_history(&history(40, 900, |_| 50.0), (t0 + 300) * 1000)
            .unwrap();
        assert!(r.counter_reset);
        assert_eq!(r.new_samples, 40);
        // Next regular ingest after reset is incremental again.
        let r = db
            .ingest_history(&history(100, 900, |_| 50.0), (t0 + 360) * 1000)
            .unwrap();
        assert!(!r.counter_reset);
        assert_eq!(r.new_samples, 60);
    }

    #[test]
    fn reboot_detection_from_uptime_and_bootcount() {
        let b = |u: u64, c: u64| BootInfo {
            uptime_s: Some(u),
            bootcount: Some(c),
        };
        // Normal: uptime grew with wall time.
        assert!(!detect_reboot(&b(1000, 5), 0, &b(1300, 5), 300_000));
        // Bootcount changed.
        assert!(detect_reboot(&b(1000, 5), 0, &b(5000, 6), 300_000));
        // Uptime much lower than expected (app was closed; counter could have grown past).
        assert!(detect_reboot(&b(1000, 5), 0, &b(2000, 5), 86_400_000));
        // Unknown markers: no detection.
        assert!(!detect_reboot(&BootInfo::default(), 0, &b(10, 1), 1000));
    }

    #[test]
    fn ingest_detects_reboot_when_counter_grew_past_old_value() {
        let mut db = Db::open_in_memory().unwrap();
        let t0: i64 = 1_800_000_000;
        let boot = |u: u64| {
            Some(BootInfo {
                uptime_s: Some(u),
                bootcount: Some(3),
            })
        };
        db.ingest_history_with_boot(&history(1000, 900, |_| 25.0), t0 * 1000, boot(1000))
            .unwrap();
        // One day later the dish has rebooted and is up 6000 s: counter 6000 > 1000.
        let r = db
            .ingest_history_with_boot(
                &history(6000, 900, |_| 25.0),
                (t0 + 86_400) * 1000,
                boot(6000),
            )
            .unwrap();
        assert!(r.counter_reset);
        assert_eq!(r.new_samples, 900);
    }

    #[test]
    fn events_merge_and_prune() {
        let mut db = Db::open_in_memory().unwrap();
        let now: i64 = 1_800_000_000_000;
        let mut h = history(10, 900, |_| 20.0);
        h.outages = vec![DishEvent {
            start_ms: now - 60_000,
            duration_ms: 5_000,
            cause: "SKY_SEARCH".into(),
            severity: None,
        }];
        h.events = vec![DishEvent {
            start_ms: now - 60_000,
            duration_ms: 5_020,
            cause: "OBSTRUCTED".into(),
            severity: Some("WARNING".into()),
        }];
        h.other_events = vec![DishEvent {
            start_ms: now - 30_000,
            duration_ms: 0,
            cause: "SOFTWARE_UPDATE".into(),
            severity: Some("ADVISORY".into()),
        }];
        db.ingest_history(&h, now).unwrap();
        let ev = db.events(10, now).unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].cause, "OBSTRUCTED");
        assert_eq!(ev[0].duration_ms, 5_020);
        assert_eq!(ev[0].severity.as_deref(), Some("WARNING"));
        let daily = db.daily(1, now).unwrap();
        assert_eq!(
            daily[0].outage_count, 1,
            "non-outage events are not counted"
        );
        // A later ingest seeing only the raw outage keeps the event-log classification.
        let mut h2 = history(15, 900, |_| 20.0);
        h2.outages = h.outages.clone();
        db.ingest_history(&h2, now + 5_000).unwrap();
        let ev = db.events(10, now + 5_000).unwrap();
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].cause, "OBSTRUCTED");
        assert!((daily[0].outage_s - 5.02).abs() < 1e-9);

        // Three days later everything but the daily aggregate is pruned.
        let later = now + 3 * DAY_MS;
        db.ingest_history(&history(20, 900, |_| 20.0), later)
            .unwrap();
        assert!(db.events(MAX_RANGE_MINUTES, later).unwrap().is_empty());
        let pts = db.history(MAX_RANGE_MINUTES, later).unwrap();
        assert!(!pts.is_empty());
        assert!(
            pts.iter()
                .all(|p| p.minute_ms >= later - MINUTE_RETENTION_MS)
        );
        assert_eq!(db.daily(90, later).unwrap().len(), 2);
    }

    #[test]
    fn outage_merge_with_clock_skew_and_unknown_cause() {
        assert_eq!(
            merge_outage_cause("SKY_SEARCH", "OBSTRUCTED", true),
            "OBSTRUCTED"
        );
        assert_eq!(merge_outage_cause("NO_PINGS", "UNKNOWN", true), "NO_PINGS");
        assert_eq!(merge_outage_cause("UNKNOWN", "NO_PINGS", false), "NO_PINGS");
        assert_eq!(
            merge_outage_cause("OBSTRUCTED", "SKY_SEARCH", false),
            "OBSTRUCTED"
        );

        // Real capture: event log 1.2 s earlier than outages[], reason OUTAGE_UNKNOWN.
        let mut db = Db::open_in_memory().unwrap();
        let now: i64 = 1_795_363_700_000;
        let mut h = history(10, 900, |_| 20.0);
        h.outages = vec![DishEvent {
            start_ms: 1_795_363_648_920,
            duration_ms: 219,
            cause: "NO_PINGS".into(),
            severity: None,
        }];
        h.events = vec![DishEvent {
            start_ms: 1_795_363_647_720,
            duration_ms: 219,
            cause: "UNKNOWN".into(),
            severity: Some("WARNING".into()),
        }];
        db.ingest_history(&h, now).unwrap();
        let ev = db.events(60, now).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].cause, "NO_PINGS");
        assert_eq!(ev[0].severity.as_deref(), Some("WARNING"));
        // Distinct outages more than 2 s apart stay separate.
        h.outages[0].start_ms += 10_000;
        h.events.clear();
        db.ingest_history(&h, now).unwrap();
        assert_eq!(db.events(60, now).unwrap().len(), 2);
    }

    #[test]
    fn ingest_fixture_history() {
        let path = format!(
            "{}/tests/fixtures/get_history.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let top: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let h = crate::dish::json::parse_history(&top["dishGetHistory"], 0);
        let mut db = Db::open_in_memory().unwrap();
        let fetch_ms = 1_795_362_284_619;
        let r = db.ingest_history(&h, fetch_ms).unwrap();
        assert_eq!(r.new_samples, 900);
        let pts = db.history(MAX_RANGE_MINUTES, fetch_ms).unwrap();
        assert!((15..=17).contains(&pts.len()), "{} minutes", pts.len());
        assert!(pts.iter().all(|p| p.latency_avg_ms.is_some()));
        assert!(pts.iter().all(|p| p.power_avg_w.is_some()));
        assert_eq!(db.events(MAX_RANGE_MINUTES, fetch_ms).unwrap().len(), 4);
    }
}
