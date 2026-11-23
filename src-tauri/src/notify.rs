//! Desktop notification decisions (Phase 4.5). Pure state machine: the service feeds it
//! status observations and usage totals; it returns what to show. Delivery happens in the
//! event sink (tauri-plugin-notification).
//!
//! Rules: the first observation after (re)connect only records a baseline (no startup
//! notifications, e.g. the permanent POLICY_LIMIT on some plans); per-type cooldown; quiet
//! hours in local time (may wrap past midnight); everything is suppressed in mock mode.

use std::collections::HashMap;

use crate::i18n::{Lang, NotifyTexts, fill};

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
    /// The real dish stopped answering the app (power loss, cable, network path).
    Unreachable,
    Test,
}

/// Marks alerts whose delivery enables a later recovery message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertTag {
    OutageStart,
    UnreachableStart,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    /// Recovery messages pair with an already-sent alert and skip the cooldown.
    pub bypass_cooldown: bool,
    /// Set on alerts that have a matching recovery message.
    pub tag: Option<AlertTag>,
}

impl Notification {
    fn new(kind: NotificationKind, title: &str, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.to_string(),
            body: body.into(),
            bypass_cooldown: false,
            tag: None,
        }
    }

    fn recovery(kind: NotificationKind, title: &str, body: impl Into<String>) -> Self {
        Self {
            bypass_cooldown: true,
            ..Self::new(kind, title, body)
        }
    }
}

/// The real dish must be unreachable this long before the user is told.
pub const UNREACHABLE_MIN_MS: i64 = 2 * 60_000;

/// What the dish reported in one poll.
#[derive(Debug, Clone, Default)]
pub struct Observation<'a> {
    pub now_ms: i64,
    pub snapshot: Option<&'a TelemetrySnapshot>,
    /// `outage.cause` from get_status, if the dish reports an outage in progress.
    pub outage_cause: Option<&'a str>,
    /// `deviceInfo.bootcount` (a change means the dish rebooted).
    pub bootcount: Option<u64>,
}

/// Plain-language explanation of an outage cause.
pub fn plain_cause(t: &NotifyTexts, cause: Option<&str>) -> &'static str {
    match cause.unwrap_or("") {
        "OBSTRUCTED" => t.cause_obstructed,
        "NO_DOWNLINK" | "NO_PINGS" | "NO_SCHEDULE" | "NETWORK_ISSUE" => t.cause_no_signal,
        "BOOTING" => t.cause_booting,
        "SKY_SEARCH" | "SEARCHING" => t.cause_searching,
        "THERMAL_SHUTDOWN" => t.cause_thermal,
        "STOWED" => t.cause_stowed,
        "MOTORS_STUCK" => t.cause_motors,
        _ => t.cause_unknown,
    }
}

fn dur(ms: i64) -> String {
    fmt_duration(ms)
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
    /// Outage alert produced (attempted) / actually delivered.
    outage_alerted: bool,
    outage_delivered: bool,
    obstructed: bool,
    thermal: bool,
    throttled: bool,
    last_uptime: Option<(u64, i64)>,
    last_bootcount: Option<u64>,
    update_pending: bool,
    unreachable_since: Option<i64>,
    unreachable_alerted: bool,
    unreachable_delivered: bool,
    /// Highest data-cap level already notified in the current cycle: (cycle_start, 80|100).
    data_cap: Option<(i64, u8)>,
    last_sent: HashMap<NotificationKind, i64>,
    /// Text language; `None` = the current app language.
    lang: Option<Lang>,
}

impl NotificationEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forget all state (new connection): the next observation is a baseline again.
    /// New connection: transition baselines restart (no startup notifications), but reboot
    /// markers, cooldowns, the unreachable state and the data-cap level survive, so a reboot or
    /// a lost dish during the reconnect is still reported.
    pub fn reset(&mut self) {
        let kept = Self {
            last_uptime: self.last_uptime,
            last_bootcount: self.last_bootcount,
            last_sent: std::mem::take(&mut self.last_sent),
            data_cap: self.data_cap,
            unreachable_since: self.unreachable_since,
            unreachable_alerted: self.unreachable_alerted,
            unreachable_delivered: self.unreachable_delivered,
            lang: self.lang,
            ..Self::default()
        };
        *self = kept;
    }

    /// Forgets everything tied to a specific dish (called when the dish address changes), so
    /// another dish's uptime is not mistaken for a reboot.
    pub fn forget_dish(&mut self) {
        self.last_uptime = None;
        self.last_bootcount = None;
        self.unreachable_since = None;
        self.unreachable_alerted = false;
        self.unreachable_delivered = false;
        self.initialized = false;
    }

    /// Forces the text language (tests); production follows `i18n::current()`.
    pub fn set_lang(&mut self, lang: Option<Lang>) {
        self.lang = lang;
    }

    fn texts(&self) -> &'static NotifyTexts {
        NotifyTexts::get(self.lang.unwrap_or_else(crate::i18n::current))
    }

    /// Reboot detection from uptime drop or bootcount change; updates the markers.
    fn check_reboot(
        &mut self,
        uptime: Option<u64>,
        bootcount: Option<u64>,
        now: i64,
    ) -> Option<Notification> {
        let mut rebooted = matches!((self.last_bootcount, bootcount), (Some(a), Some(b)) if a != b);
        if let (Some(u), Some((prev, prev_ms))) = (uptime, self.last_uptime) {
            let expected = prev as i64 + (now - prev_ms) / 1000;
            rebooted |= (u as i64) + REBOOT_SLACK_S < expected;
        }
        if let Some(u) = uptime {
            self.last_uptime = Some((u, now));
        }
        if bootcount.is_some() {
            self.last_bootcount = bootcount;
        }
        let t = self.texts();
        rebooted.then(|| {
            Notification::new(
                NotificationKind::Reboot,
                t.reboot_title,
                match uptime {
                    Some(u) => fill(t.reboot_body, &[("duration", &dur(u as i64 * 1000))]),
                    None => t.reboot_body_plain.to_string(),
                },
            )
        })
    }

    /// The real dish did not answer (status poll or connect failed).
    pub fn observe_unreachable(&mut self, now_ms: i64) -> Vec<Notification> {
        // Only a dish seen earlier in this run can be "lost" (no alert when the app simply
        // runs away from any dish).
        if self.last_uptime.is_none() && self.last_bootcount.is_none() {
            return Vec::new();
        }
        let since = *self.unreachable_since.get_or_insert(now_ms);
        if self.unreachable_alerted || now_ms - since < UNREACHABLE_MIN_MS {
            return Vec::new();
        }
        self.unreachable_alerted = true;
        let t = self.texts();
        let mut n = Notification::new(
            NotificationKind::Unreachable,
            t.unreachable_title,
            fill(t.unreachable_body, &[("duration", &dur(now_ms - since))]),
        );
        n.tag = Some(AlertTag::UnreachableStart);
        vec![n]
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
        // The dish answers again (possibly after a reboot, e.g. a nightly firmware update).
        let back = self
            .unreachable_since
            .take()
            .map(|since| (since, self.unreachable_delivered));
        self.unreachable_alerted = false;
        self.unreachable_delivered = false;
        // Reboot markers survive reconnects, so this also works on the first observation.
        let reboot = self.check_reboot(snap.uptime_s, obs.bootcount, now);
        match (reboot, back) {
            // Offline because it restarted: one merged message instead of "reachable again"
            // plus "restarted" (it pairs with a delivered "not reachable", if any).
            (Some(mut n), Some((since, delivered))) => {
                n.body = fill(
                    self.texts().reboot_offline_body,
                    &[("duration", &dur(now - since))],
                );
                n.bypass_cooldown = delivered;
                out.push(n);
            }
            (Some(n), None) => out.push(n),
            (None, Some((since, true))) => out.push(Notification::recovery(
                NotificationKind::Unreachable,
                self.texts().reachable_title,
                fill(
                    self.texts().reachable_body,
                    &[("duration", &dur(now - since))],
                ),
            )),
            (None, _) => {}
        }
        if !self.initialized {
            // Baseline only.
            self.initialized = true;
            if in_outage {
                self.outage_start_ms = Some(now);
                self.outage_cause = obs.outage_cause.map(str::to_owned);
                // An outage already running at startup is not announced.
                self.outage_alerted = true;
            }
            self.obstructed = obstructed;
            self.thermal = thermal;
            self.throttled = throttled;
            self.update_pending = update_pending;
            return out;
        }

        // Outage start / recovery.
        if in_outage {
            let start = *self.outage_start_ms.get_or_insert(now);
            if let Some(c) = obs.outage_cause {
                self.outage_cause = Some(c.to_string());
            }
            if !self.outage_alerted && now - start > OUTAGE_MIN_MS {
                self.outage_alerted = true;
                let t = self.texts();
                let mut n = Notification::new(
                    NotificationKind::Outage,
                    t.outage_title,
                    fill(
                        t.outage_body,
                        &[("cause", plain_cause(t, self.outage_cause.as_deref()))],
                    ),
                );
                n.tag = Some(AlertTag::OutageStart);
                out.push(n);
            }
        } else if let Some(start) = self.outage_start_ms.take() {
            // Recovery only pairs with an alert the user actually saw.
            if self.outage_delivered {
                out.push(Notification::recovery(
                    NotificationKind::Outage,
                    self.texts().restored_title,
                    fill(
                        self.texts().restored_body,
                        &[("duration", &dur(now - start))],
                    ),
                ));
            }
            self.outage_alerted = false;
            self.outage_delivered = false;
            self.outage_cause = None;
        }

        if obstructed && !self.obstructed {
            let t = self.texts();
            let lang = self.lang.unwrap_or_else(crate::i18n::current);
            out.push(Notification::new(
                NotificationKind::Obstruction,
                t.obstruction_title,
                fill(
                    t.obstruction_body,
                    &[(
                        "pct",
                        &format!("{} %", crate::i18n::dec(lang, frac * 100.0, 1)),
                    )],
                ),
            ));
        }
        self.obstructed = obstructed;

        if thermal && !self.thermal {
            out.push(Notification::new(
                NotificationKind::Thermal,
                self.texts().thermal_title,
                self.texts().thermal_body,
            ));
        }
        self.thermal = thermal;

        if throttled != self.throttled {
            let t = self.texts();
            out.push(if throttled {
                Notification::new(
                    NotificationKind::Throttle,
                    t.throttle_on_title,
                    t.throttle_on_body,
                )
            } else {
                Notification::new(
                    NotificationKind::Throttle,
                    t.throttle_off_title,
                    t.throttle_off_body,
                )
            });
        }
        self.throttled = throttled;

        if update_pending && !self.update_pending {
            out.push(Notification::new(
                NotificationKind::FirmwareUpdate,
                self.texts().firmware_title,
                self.texts().firmware_body,
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
        let t = self.texts();
        let lang = self.lang.unwrap_or_else(crate::i18n::current);
        vec![Notification::new(
            NotificationKind::DataCap,
            if level == 100 {
                t.datacap100_title
            } else {
                t.datacap80_title
            },
            fill(
                t.datacap_body,
                &[
                    ("used", &crate::i18n::dec(lang, used_bytes / 1e9, 1)),
                    ("cap", &crate::i18n::dec(lang, cap, 0)),
                ],
            ),
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
                NotificationKind::Unreachable => settings.outage,
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
            match n.tag {
                Some(AlertTag::OutageStart) => self.outage_delivered = true,
                Some(AlertTag::UnreachableStart) => self.unreachable_delivered = true,
                None => {}
            }
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
            bootcount: None,
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
            bootcount: None,
        });
        assert_eq!(n.len(), 1);
        assert!(n[0].body.contains("blocking the dish's view"));
        // The user saw the alert, so a recovery message will follow.
        assert_eq!(deliver_all(&mut e, n, 36_000, 12).len(), 1);
        assert!(
            observe(&mut e, &up(&down, 40), 40_000, Some("OBSTRUCTED")).is_empty(),
            "once"
        );
        let back = e.observe(&Observation {
            now_ms: 3_000 + 125_000,
            snapshot: Some(&up(&s, 125)),
            outage_cause: None,
            bootcount: None,
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

    fn deliver_all(
        e: &mut NotificationEngine,
        c: Vec<Notification>,
        now: i64,
        hour: u8,
    ) -> Vec<Notification> {
        e.filter(c, &NotificationSettings::default(), now, hour, false)
    }

    #[test]
    fn reboot_detected_across_reconnect() {
        let mut e = NotificationEngine::new();
        let s = snap(); // uptime 1000
        observe(&mut e, &s, 0, None);
        // Connection drops, session restarts: engine reset keeps the reboot markers.
        e.reset();
        let mut r = snap();
        r.uptime_s = Some(40);
        assert_eq!(
            observe(&mut e, &r, 120_000, None),
            vec![NotificationKind::Reboot]
        );
        // Bootcount change alone also counts (e.g. uptime unknown).
        let mut e = NotificationEngine::new();
        let mut no_up = snap();
        no_up.uptime_s = None;
        let obs = |e: &mut NotificationEngine, b: u64, t: i64| {
            e.observe(&Observation {
                now_ms: t,
                snapshot: Some(&no_up),
                outage_cause: None,
                bootcount: Some(b),
            })
        };
        assert!(obs(&mut e, 11, 0).is_empty());
        e.reset();
        assert_eq!(obs(&mut e, 12, 60_000)[0].kind, NotificationKind::Reboot);
        assert!(obs(&mut e, 12, 63_000).is_empty());
    }

    #[test]
    fn unreachable_after_two_minutes_and_back_online() {
        let mut e = NotificationEngine::new();
        // Never seen a real dish: no alert at all.
        assert!(e.observe_unreachable(0).is_empty());
        assert!(e.observe_unreachable(10 * 60_000).is_empty());
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None);
        assert!(e.observe_unreachable(10_000).is_empty());
        assert!(
            e.observe_unreachable(10_000 + UNREACHABLE_MIN_MS - 1)
                .is_empty()
        );
        let c = e.observe_unreachable(10_000 + UNREACHABLE_MIN_MS);
        assert_eq!(c[0].kind, NotificationKind::Unreachable);
        assert_eq!(deliver_all(&mut e, c, 200_000, 12).len(), 1);
        assert!(e.observe_unreachable(400_000).is_empty(), "once");
        e.reset(); // reconnect attempt
        let back = observe(&mut e, &up(&snap(), 600), 600_000, None);
        assert_eq!(back, vec![NotificationKind::Unreachable]);
    }

    #[test]
    fn no_recovery_for_suppressed_alerts() {
        let quiet = NotificationSettings {
            quiet_start_hour: Some(22),
            quiet_end_hour: Some(7),
            ..Default::default()
        };
        // Outage alert suppressed by quiet hours -> no "restored" later.
        let mut e = NotificationEngine::new();
        let s = snap();
        observe(&mut e, &s, 0, None);
        let mut down = up(&s, 3);
        down.pop_ping_latency_ms = None;
        down.pop_ping_drop_rate = Some(1.0);
        observe(&mut e, &down, 3_000, Some("NO_PINGS"));
        let alert = e.observe(&Observation {
            now_ms: 40_000,
            snapshot: Some(&up(&down, 37)),
            outage_cause: Some("NO_PINGS"),
            bootcount: None,
        });
        assert_eq!(alert.len(), 1);
        assert!(e.filter(alert, &quiet, 40_000, 23, false).is_empty());
        assert!(
            observe(&mut e, &up(&s, 60), 63_000, None).is_empty(),
            "no recovery"
        );
        // Unreachable alert suppressed -> no "reachable again".
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None);
        e.observe_unreachable(1_000);
        let c = e.observe_unreachable(1_000 + UNREACHABLE_MIN_MS);
        assert!(e.filter(c, &quiet, 200_000, 2, false).is_empty());
        assert!(observe(&mut e, &up(&snap(), 300), 300_000, None).is_empty());
        // Delivered outage alert -> recovery is sent.
        let mut e = NotificationEngine::new();
        observe(&mut e, &s, 0, None);
        observe(&mut e, &down, 3_000, Some("NO_PINGS"));
        let alert = e.observe(&Observation {
            now_ms: 40_000,
            snapshot: Some(&up(&down, 37)),
            outage_cause: Some("NO_PINGS"),
            bootcount: None,
        });
        assert_eq!(deliver_all(&mut e, alert, 40_000, 12).len(), 1);
        assert_eq!(
            observe(&mut e, &up(&s, 60), 63_000, None),
            vec![NotificationKind::Outage]
        );
    }

    #[test]
    fn cooldowns_survive_reset() {
        let mut e = NotificationEngine::new();
        let n = Notification::new(NotificationKind::Reboot, "t", "b");
        assert_eq!(deliver_all(&mut e, vec![n.clone()], 0, 12).len(), 1);
        e.reset();
        assert!(deliver_all(&mut e, vec![n], 60_000, 12).is_empty());
    }

    #[test]
    fn reboot_while_unreachable_is_one_message() {
        // "Not reachable" delivered, then the dish comes back rebooted: one merged message.
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None); // uptime 1000
        e.observe_unreachable(10_000);
        let c = e.observe_unreachable(10_000 + UNREACHABLE_MIN_MS);
        assert_eq!(deliver_all(&mut e, c, 200_000, 12).len(), 1);
        e.reset();
        let mut rebooted = snap();
        rebooted.uptime_s = Some(90);
        let out = e.observe(&Observation {
            now_ms: 10_000 + 10 * 60_000,
            snapshot: Some(&rebooted),
            outage_cause: None,
            bootcount: None,
        });
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].kind, NotificationKind::Reboot);
        assert_eq!(
            out[0].body,
            "The dish restarted and was offline for 10 min 0 s."
        );
        assert!(out[0].bypass_cooldown);
        // Short unreachable period (alert never sent) + reboot: still one restart message.
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None);
        e.observe_unreachable(5_000);
        e.reset();
        let out = e.observe(&Observation {
            now_ms: 65_000,
            snapshot: Some(&rebooted),
            outage_cause: None,
            bootcount: None,
        });
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NotificationKind::Reboot);
        assert!(!out[0].bypass_cooldown);
    }

    #[test]
    fn new_dish_address_forgets_reboot_markers() {
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None); // uptime 1000
        e.reset();
        e.forget_dish();
        let mut other = snap();
        other.uptime_s = Some(30); // a different dish, not a reboot
        assert!(observe(&mut e, &other, 60_000, None).is_empty());
        // And it no longer counts as "seen" for the unreachable alert until observed again.
        let mut e = NotificationEngine::new();
        observe(&mut e, &snap(), 0, None);
        e.forget_dish();
        assert!(e.observe_unreachable(0).is_empty());
        assert!(e.observe_unreachable(10 * 60_000).is_empty());
    }

    #[test]
    fn italian_notification_texts() {
        let mut e = NotificationEngine::new();
        e.set_lang(Some(Lang::It));
        let mut s = snap();
        s.obstruction.fraction_obstructed = Some(0.0);
        observe(&mut e, &s, 0, None);
        s.obstruction.fraction_obstructed = Some(0.0412);
        let n = e.observe(&Observation {
            now_ms: 3_000,
            snapshot: Some(&up(&s, 3)),
            outage_cause: None,
            bootcount: None,
        });
        assert_eq!(n[0].title, "Visuale della parabola ostruita");
        assert!(n[0].body.contains("(4,1 % ostruito)"), "{}", n[0].body);
        let cap = e.observe_usage(1, 85.5e9, Some(100.0));
        assert_eq!(cap[0].title, "80 % del limite dati usato");
        assert_eq!(
            cap[0].body,
            "Stimati 85,5 GB su 100 GB usati in questo ciclo di fatturazione."
        );
        e.reset();
        let mut r = snap();
        r.uptime_s = Some(30);
        let n = e.observe(&Observation {
            now_ms: 600_000,
            snapshot: Some(&r),
            outage_cause: None,
            bootcount: None,
        });
        assert_eq!(
            n[0].body, "La parabola si è riavviata (attiva da 30 s).",
            "language survives reset"
        );
    }
}
