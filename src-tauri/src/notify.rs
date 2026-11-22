//! Desktop notification decisions (Phase 4.5). Pure state machine: the service feeds it
//! status observations and usage totals; it returns what to show. Delivery happens in the
//! event sink (tauri-plugin-notification).
//!
//! Rules: the first observation after (re)connect only records a baseline (no startup
//! notifications, e.g. the permanent POLICY_LIMIT on some plans); per-type cooldown; quiet
//! hours in local time (may wrap past midnight); everything is suppressed in mock mode.

use std::collections::HashMap;

use crate::models::{NotificationSettings, TelemetrySnapshot};

/// Minimum time between two notifications of the same kind.
pub const COOLDOWN_MS: i64 = 15 * 60_000;
/// An outage is notified only once it lasts longer than this.
pub const OUTAGE_MIN_MS: i64 = 30_000;
/// Obstruction alarm on/off thresholds (hysteresis).
pub const OBSTRUCTION_ON: f64 = 0.03;
pub const OBSTRUCTION_OFF: f64 = 0.025;
/// Uptime drop that counts as a reboot between two observations.
const REBOOT_SLACK_S: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NotificationKind {
    Outage,
    Obstruction,
    Thermal,
    Throttle,
    Reboot,
    FirmwareUpdate,
    DataCap,
    Test,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    /// Recovery messages pair with an already-sent alert and skip the cooldown.
    pub bypass_cooldown: bool,
}

impl Notification {
    fn new(kind: NotificationKind, title: &str, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.to_string(),
            body: body.into(),
            bypass_cooldown: false,
        }
    }
}

/// What the dish reported in one poll.
#[derive(Debug, Clone, Default)]
pub struct Observation<'a> {
    pub now_ms: i64,
    pub snapshot: Option<&'a TelemetrySnapshot>,
    /// `outage.cause` from get_status, if the dish reports an outage in progress.
    pub outage_cause: Option<&'a str>,
}

/// Plain-language explanation of an outage cause.
pub fn plain_cause(cause: Option<&str>) -> &'static str {
    match cause.unwrap_or("") {
        "OBSTRUCTED" => "something is blocking the dish's view of the sky",
        "NO_DOWNLINK" | "NO_PINGS" | "NO_SCHEDULE" | "NETWORK_ISSUE" => {
            "no signal from the Starlink network"
        }
        "BOOTING" => "the dish is restarting",
        "SKY_SEARCH" | "SEARCHING" => "the dish is searching for satellites",
        "THERMAL_SHUTDOWN" => "the dish is too hot and shut down",
        "STOWED" => "the dish is stowed",
        "MOTORS_STUCK" => "the dish motors are stuck",
        _ => "unknown cause",
    }
}

fn fmt_duration(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min {} s", s / 60, s % 60),
        _ => format!("{} h {} min", s / 3600, (s % 3600) / 60),
    }
}

/// True when `hour` falls inside quiet hours `[start, end)` (wraps past midnight).
pub fn in_quiet_hours(hour: u8, start: Option<u8>, end: Option<u8>) -> bool {
    match (start, end) {
        (Some(s), Some(e)) if s != e => {
            if s < e {
                hour >= s && hour < e
            } else {
                hour >= s || hour < e
            }
        }
        _ => false,
    }
}

#[derive(Debug, Default)]
pub struct NotificationEngine {
    initialized: bool,
    outage_start_ms: Option<i64>,
    outage_cause: Option<String>,
    outage_notified: bool,
    obstructed: bool,
    thermal: bool,
    throttled: bool,
    last_uptime: Option<(u64, i64)>,
    update_pending: bool,
    /// Highest data-cap level already notified in the current cycle: (cycle_start, 80|100).
    data_cap: Option<(i64, u8)>,
    last_sent: HashMap<NotificationKind, i64>,
}

impl NotificationEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget all state (new connection): the next observation is a baseline again.
    pub fn reset(&mut self) {
        let data_cap = self.data_cap;
        *self = Self::default();
        self.data_cap = data_cap;
    }

    /// Restores the persisted data-cap level for a cycle.
    pub fn set_data_cap_level(&mut self, cycle_start_ms: i64, level: u8) {
        self.data_cap = Some((cycle_start_ms, level));
    }

    pub fn data_cap_level(&self) -> Option<(i64, u8)> {
        self.data_cap
    }

    /// Processes one status observation and returns candidate notifications.
    pub fn observe(&mut self, obs: &Observation<'_>) -> Vec<Notification> {
        let Some(snap) = obs.snapshot else {
            return Vec::new();
        };
        let now = obs.now_ms;
        let in_outage = obs.outage_cause.is_some()
            || (snap.pop_ping_latency_ms.is_none()
                && snap.pop_ping_drop_rate.unwrap_or(0.0) >= 1.0);
        let frac = snap.obstruction.fraction_obstructed.unwrap_or(0.0);
        let currently = snap.obstruction.currently_obstructed.unwrap_or(false);
        let obstructed = if self.obstructed {
            currently || frac >= OBSTRUCTION_OFF
        } else {
            currently || frac > OBSTRUCTION_ON
        };
        let thermal = snap
            .alerts
            .iter()
            .any(|a| a == "thermalThrottle" || a == "thermalShutdown");
        let throttled = [
            &snap.dl_bandwidth_restricted_reason,
            &snap.ul_bandwidth_restricted_reason,
        ]
        .iter()
        .any(|r| r.as_deref() == Some("POLICY_LIMIT"));
        let update_pending = snap.software_update_state.as_deref() == Some("REBOOT_REQUIRED")
            || snap.alerts.iter().any(|a| a == "installPending");

        let mut out = Vec::new();
        if !self.initialized {
            // Baseline only.
            self.initialized = true;
            if in_outage {
                self.outage_start_ms = Some(now);
                self.outage_cause = obs.outage_cause.map(str::to_owned);
                // An outage already running at startup is not announced.
                self.outage_notified = false;
            }
            self.obstructed = obstructed;
            self.thermal = thermal;
            self.throttled = throttled;
            self.update_pending = update_pending;
            self.last_uptime = snap.uptime_s.map(|u| (u, now));
            return out;
        }

        // Outage start / recovery.
        if in_outage {
            let start = *self.outage_start_ms.get_or_insert(now);
            if let Some(c) = obs.outage_cause {
                self.outage_cause = Some(c.to_string());
            }
            if !self.outage_notified && now - start > OUTAGE_MIN_MS {
                self.outage_notified = true;
                out.push(Notification::new(
                    NotificationKind::Outage,
                    "Starlink connection lost",
                    format!(
                        "No internet: {}.",
                        plain_cause(self.outage_cause.as_deref())
                    ),
                ));
            }
        } else if let Some(start) = self.outage_start_ms.take() {
            if self.outage_notified {
                let mut n = Notification::new(
                    NotificationKind::Outage,
                    "Starlink connection restored",
                    format!("Back online after {}.", fmt_duration(now - start)),
                );
                n.bypass_cooldown = true;
                out.push(n);
            }
            self.outage_notified = false;
            self.outage_cause = None;
        }

        if obstructed && !self.obstructed {
            out.push(Notification::new(
                NotificationKind::Obstruction,
                "Dish view obstructed",
                format!(
                    "Something blocks the dish's view of the sky ({:.1} % obstructed). Check the obstruction map.",
                    frac * 100.0
                ),
            ));
        }
        self.obstructed = obstructed;

        if thermal && !self.thermal {
            out.push(Notification::new(
                NotificationKind::Thermal,
                "Dish overheating",
                "The dish is limiting performance because it is too hot.",
            ));
        }
        self.thermal = thermal;

        if throttled != self.throttled {
            out.push(if throttled {
                Notification::new(
                    NotificationKind::Throttle,
                    "Starlink speed limited",
                    "Your plan is being deprioritized or limited by Starlink (POLICY_LIMIT).",
                )
            } else {
                Notification::new(
                    NotificationKind::Throttle,
                    "Starlink speed limit lifted",
                    "Your plan is no longer limited by Starlink.",
                )
            });
        }
        self.throttled = throttled;

        if let Some(uptime) = snap.uptime_s {
            if let Some((prev, prev_ms)) = self.last_uptime {
                let expected = prev as i64 + (now - prev_ms) / 1000;
                if (uptime as i64) + REBOOT_SLACK_S < expected {
                    out.push(Notification::new(
                        NotificationKind::Reboot,
                        "Dish restarted",
                        format!(
                            "The dish rebooted (up for {}).",
                            fmt_duration(uptime as i64 * 1000)
                        ),
                    ));
                }
            }
            self.last_uptime = Some((uptime, now));
        }

        if update_pending && !self.update_pending {
            out.push(Notification::new(
                NotificationKind::FirmwareUpdate,
                "Starlink firmware update ready",
                "The dish will restart to install a software update.",
            ));
        }
        self.update_pending = update_pending;
        out
    }

    /// Checks cycle usage against the cap; returns a notification when crossing 80 % / 100 %.
    pub fn observe_usage(
        &mut self,
        cycle_start_ms: i64,
        used_bytes: f64,
        cap_gb: Option<f64>,
    ) -> Vec<Notification> {
        let Some(cap) = cap_gb.filter(|c| *c > 0.0) else {
            return Vec::new();
        };
        let ratio = used_bytes / (cap * 1e9);
        let level = if ratio >= 1.0 {
            100
        } else if ratio >= 0.8 {
            80
        } else {
            0
        };
        let notified = match self.data_cap {
            Some((start, l)) if start == cycle_start_ms => l,
            _ => 0,
        };
        if level <= notified {
            return Vec::new();
        }
        self.data_cap = Some((cycle_start_ms, level));
        let used_gb = used_bytes / 1e9;
        vec![Notification::new(
            NotificationKind::DataCap,
            if level == 100 {
                "Data cap reached"
            } else {
                "80 % of data cap used"
            },
            format!("Estimated {used_gb:.1} GB of {cap:.0} GB used this billing cycle."),
        )]
    }

    /// Applies user settings, mock suppression, quiet hours and cooldown.
    pub fn filter(
        &mut self,
        candidates: Vec<Notification>,
        settings: &NotificationSettings,
        now_ms: i64,
        local_hour: u8,
        is_mock: bool,
    ) -> Vec<Notification> {
        if is_mock || !settings.enabled {
            return Vec::new();
        }
        let quiet = in_quiet_hours(
            local_hour,
            settings.quiet_start_hour,
            settings.quiet_end_hour,
        );
        let mut out = Vec::new();
        for n in candidates {
            let allowed = match n.kind {
                NotificationKind::Outage => settings.outage,
                NotificationKind::Obstruction => settings.obstruction,
                NotificationKind::Thermal => settings.thermal,
                NotificationKind::Throttle => settings.throttle,
                NotificationKind::Reboot => settings.reboot,
                NotificationKind::FirmwareUpdate => settings.firmware_update,
                NotificationKind::DataCap => settings.data_cap,
                NotificationKind::Test => true,
            };
            if !allowed || quiet {
                continue;
            }
            let cooling = self
                .last_sent
                .get(&n.kind)
                .is_some_and(|t| now_ms - t < COOLDOWN_MS);
            if cooling && !n.bypass_cooldown {
                continue;
            }
            self.last_sent.insert(n.kind, now_ms);
            out.push(n);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ObstructionStats;

    fn snap() -> TelemetrySnapshot {
        TelemetrySnapshot {
            pop_ping_latency_ms: Some(30.0),
            pop_ping_drop_rate: Some(0.0),
            uptime_s: Some(1000),
            ..Default::default()
        }
    }

    fn observe(
        e: &mut NotificationEngine,
        s: &TelemetrySnapshot,
        now: i64,
        cause: Option<&str>,
    ) -> Vec<NotificationKind> {
        e.observe(&Observation {
            now_ms: now,
            snapshot: Some(s),
            outage_cause: cause,
        })
        .into_iter()
        .map(|n| n.kind)
        .collect()
    }

    fn up(s: &TelemetrySnapshot, secs: i64) -> TelemetrySnapshot {
        TelemetrySnapshot {
            uptime_s: s.uptime_s.map(|u| u + secs as u64),
            ..s.clone()
        }
    }

    #[test]
    fn startup_is_baseline_only() {
        let mut e = NotificationEngine::new();
        let mut s = snap();
        s.dl_bandwidth_restricted_reason = Some("POLICY_LIMIT".into());
        s.alerts = vec!["thermalThrottle".into()];
        s.obstruction.fraction_obstructed = Some(0.2);
        s.software_update_state = Some("REBOOT_REQUIRED".into());
        assert!(observe(&mut e, &s, 0, None).is_empty());
        // Unchanged states never notify later either (permanent POLICY_LIMIT on the Mini).
        assert!(observe(&mut e, &up(&s, 3), 3_000, None).is_empty());
        assert!(observe(&mut e, &up(&s, 600), 600_000, None).is_empty());
    }

    #[test]
    fn outage_after_30s_and_recovery_with_duration() {
        let mut e = NotificationEngine::new();
        let s = snap();
        observe(&mut e, &s, 0, None);
        let mut down = up(&s, 3);
        down.pop_ping_latency_ms = None;
        down.pop_ping_drop_rate = Some(1.0);
        assert!(observe(&mut e, &down, 3_000, Some("OBSTRUCTED")).is_empty());
        assert!(observe(&mut e, &up(&down, 27), 30_000, Some("OBSTRUCTED")).is_empty());
        let n = e.observe(&Observation {
            now_ms: 36_000,
            snapshot: Some(&up(&down, 33)),
            outage_cause: Some("OBSTRUCTED"),
        });
        assert_eq!(n.len(), 1);
        assert!(n[0].body.contains("blocking the dish's view"));
        assert!(
            observe(&mut e, &up(&down, 40), 40_000, Some("OBSTRUCTED")).is_empty(),
            "once"
        );
        let back = e.observe(&Observation {
            now_ms: 3_000 + 125_000,
            snapshot: Some(&up(&s, 125)),
            outage_cause: None,
        });
        assert_eq!(back.len(), 1);
        assert!(back[0].bypass_cooldown);
        assert!(back[0].body.contains("2 min 5 s"), "{}", back[0].body);
    }

    #[test]
    fn short_outage_is_silent() {
        let mut e = NotificationEngine::new();
        let s = snap();
        observe(&mut e, &s, 0, None);
        assert!(observe(&mut e, &up(&s, 3), 3_000, Some("NO_PINGS")).is_empty());
        assert!(
            observe(&mut e, &up(&s, 10), 10_000, None).is_empty(),
            "no recovery for unsent outage"
        );
    }

    #[test]
    fn obstruction_hysteresis() {
        let mut e = NotificationEngine::new();
        let mut s = snap();
        s.obstruction = ObstructionStats {
            fraction_obstructed: Some(0.02),
            ..Default::default()
        };
        observe(&mut e, &s, 0, None);
        s.obstruction.fraction_obstructed = Some(0.031);
        assert_eq!(
            observe(&mut e, &up(&s, 3), 3_000, None),
            vec![NotificationKind::Obstruction]
        );
        // Hovering between 2.5 % and 3 % does not re-trigger.
        s.obstruction.fraction_obstructed = Some(0.027);
        assert!(observe(&mut e, &up(&s, 6), 6_000, None).is_empty());
        s.obstruction.fraction_obstructed = Some(0.031);
        assert!(observe(&mut e, &up(&s, 9), 9_000, None).is_empty());
        // Falls below 2.5 %, rises again: new alert.
        s.obstruction.fraction_obstructed = Some(0.02);
        assert!(observe(&mut e, &up(&s, 12), 12_000, None).is_empty());
        s.obstruction.fraction_obstructed = Some(0.04);
        assert_eq!(
            observe(&mut e, &up(&s, 15), 15_000, None),
            vec![NotificationKind::Obstruction]
        );
    }

    #[test]
    fn throttle_reboot_thermal_firmware_transitions() {
        let mut e = NotificationEngine::new();
        let s = snap();
        observe(&mut e, &s, 0, None);
        let mut t = up(&s, 3);
        t.dl_bandwidth_restricted_reason = Some("POLICY_LIMIT".into());
        assert_eq!(
            observe(&mut e, &t, 3_000, None),
            vec![NotificationKind::Throttle]
        );
        let lifted = up(&s, 6);
        assert_eq!(
            observe(&mut e, &lifted, 6_000, None),
            vec![NotificationKind::Throttle]
        );
        // Reboot: uptime drops.
        let mut r = snap();
        r.uptime_s = Some(20);
        assert_eq!(
            observe(&mut e, &r, 9_000, None),
            vec![NotificationKind::Reboot]
        );
        let mut h = up(&r, 3);
        h.alerts = vec!["thermalShutdown".into()];
        h.software_update_state = Some("REBOOT_REQUIRED".into());
        assert_eq!(
            observe(&mut e, &h, 12_000, None),
            vec![NotificationKind::Thermal, NotificationKind::FirmwareUpdate]
        );
    }

    #[test]
    fn data_cap_levels_once_per_cycle() {
        let mut e = NotificationEngine::new();
        assert!(e.observe_usage(1, 70e9, Some(100.0)).is_empty());
        assert_eq!(e.observe_usage(1, 81e9, Some(100.0)).len(), 1);
        assert!(e.observe_usage(1, 90e9, Some(100.0)).is_empty());
        let full = e.observe_usage(1, 101e9, Some(100.0));
        assert_eq!(full[0].title, "Data cap reached");
        assert!(e.observe_usage(1, 120e9, Some(100.0)).is_empty());
        // New cycle starts over; no cap = nothing.
        assert_eq!(e.observe_usage(2, 85e9, Some(100.0)).len(), 1);
        assert!(e.observe_usage(3, 500e9, None).is_empty());
        // Persisted level survives a reset.
        e.reset();
        assert!(e.observe_usage(2, 86e9, Some(100.0)).is_empty());
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        assert!(in_quiet_hours(23, Some(22), Some(7)));
        assert!(in_quiet_hours(3, Some(22), Some(7)));
        assert!(!in_quiet_hours(7, Some(22), Some(7)));
        assert!(!in_quiet_hours(12, Some(22), Some(7)));
        assert!(in_quiet_hours(13, Some(12), Some(14)));
        assert!(!in_quiet_hours(14, Some(12), Some(14)));
        assert!(!in_quiet_hours(5, None, None));
        assert!(!in_quiet_hours(5, Some(5), Some(5)));
    }

    #[test]
    fn filter_cooldown_toggles_quiet_and_mock() {
        let n = |k| Notification::new(k, "t", "b");
        let mut e = NotificationEngine::new();
        let mut st = NotificationSettings::default();
        assert_eq!(
            e.filter(vec![n(NotificationKind::Reboot)], &st, 0, 12, false)
                .len(),
            1
        );
        // Cooldown 15 min per kind.
        assert!(
            e.filter(vec![n(NotificationKind::Reboot)], &st, 60_000, 12, false)
                .is_empty()
        );
        assert_eq!(
            e.filter(vec![n(NotificationKind::Thermal)], &st, 60_000, 12, false)
                .len(),
            1
        );
        assert_eq!(
            e.filter(
                vec![n(NotificationKind::Reboot)],
                &st,
                COOLDOWN_MS,
                12,
                false
            )
            .len(),
            1
        );
        // Recovery bypasses cooldown.
        let mut rec = n(NotificationKind::Reboot);
        rec.bypass_cooldown = true;
        assert_eq!(
            e.filter(vec![rec], &st, COOLDOWN_MS + 1, 12, false).len(),
            1
        );
        // Per-type toggle, master switch, quiet hours, mock.
        st.throttle = false;
        assert!(
            e.filter(vec![n(NotificationKind::Throttle)], &st, 0, 12, false)
                .is_empty()
        );
        st.quiet_start_hour = Some(22);
        st.quiet_end_hour = Some(7);
        assert!(
            e.filter(vec![n(NotificationKind::Obstruction)], &st, 0, 23, false)
                .is_empty()
        );
        // Suppressed by quiet hours does not start the cooldown.
        assert_eq!(
            e.filter(vec![n(NotificationKind::Obstruction)], &st, 1, 8, false)
                .len(),
            1
        );
        assert!(
            e.filter(vec![n(NotificationKind::Outage)], &st, 0, 12, true)
                .is_empty()
        );
        st.enabled = false;
        assert!(
            e.filter(vec![n(NotificationKind::Outage)], &st, 0, 12, false)
                .is_empty()
        );
    }
}
