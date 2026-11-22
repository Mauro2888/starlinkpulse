//! Deterministic rule engine (ADR-005, Phase 4.6): the default diagnosis, offline and free.
//!
//! Pure function over the 24 h [`DiagnosticSummary`] plus a small [`RuleContext`] (dish
//! motors, live alerts, reboot count). Thresholds are named constants documented in
//! `docs/diagnostics.md`. Output text is English and always quotes the measured numbers.

use crate::models::{
    ActuatorSupport, AiFinding, AiFindingCategory as Cat, AiOverallHealth, AiSeverity as Sev,
    DiagnosticSummary,
};

/// Model name reported for rule-engine reports.
pub const RULES_MODEL: &str = "rules-v1";

/// Sky fraction obstructed: warning above 1 %, critical above 3 %.
pub const OBSTRUCTION_WARN: f64 = 0.01;
pub const OBSTRUCTION_CRIT: f64 = 0.03;
/// Seconds of OBSTRUCTED outages in 24 h: warning from 30 s, critical from 5 min.
pub const OBSTRUCTED_OUTAGE_WARN_S: f64 = 30.0;
pub const OBSTRUCTED_OUTAGE_CRIT_S: f64 = 300.0;
/// Alignment tolerances (same as the UI helper).
pub const ALIGN_AZ_TOL_DEG: f64 = 2.0;
pub const ALIGN_EL_TOL_DEG: f64 = 1.0;
/// Network-side outages (no obstruction): warning from 60 s, critical from 10 min.
pub const NETWORK_OUTAGE_WARN_S: f64 = 60.0;
pub const NETWORK_OUTAGE_CRIT_S: f64 = 600.0;
/// Reboots in 24 h: warning from 2 (one nightly update reboot is normal), critical from 4.
pub const REBOOT_WARN: u32 = 2;
pub const REBOOT_CRIT: u32 = 4;
/// Latency p95 above 100 ms (warning) / 200 ms (critical).
pub const LATENCY_P95_WARN_MS: f64 = 100.0;
pub const LATENCY_P95_CRIT_MS: f64 = 200.0;
/// Ping drop rate above 1 % (warning) / 5 % (critical).
pub const DROP_WARN: f64 = 0.01;
pub const DROP_CRIT: f64 = 0.05;
/// Weakest Wi-Fi client below -70 dBm (warning) / -80 dBm (critical).
pub const WIFI_WARN_DBM: f64 = -70.0;
pub const WIFI_CRIT_DBM: f64 = -80.0;
/// Less than 12 h of the 24 h window covered: results are partial.
pub const LOW_COVERAGE_MINUTES: u32 = 12 * 60;
/// Throttled for at least 90 % of the covered time: the limit is permanent.
pub const THROTTLE_PERMANENT_SHARE: f64 = 0.9;

/// Network-side outage causes (not obstruction, not reboot).
pub const NETWORK_CAUSES: &[&str] = &[
    "NO_SCHEDULE",
    "NO_DOWNLINK",
    "NO_PINGS",
    "SKY_SEARCH",
    "NETWORK_ISSUE",
];

/// Extra inputs not contained in the summary.
#[derive(Debug, Clone, Default)]
pub struct RuleContext {
    pub actuators: ActuatorSupport,
    /// Active alerts from the latest live snapshot (e.g. "thermalThrottle").
    pub alerts: Vec<String>,
    /// BOOTING outages in the window (= reboots).
    pub boot_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RulesOutcome {
    pub overall_health: AiOverallHealth,
    pub headline: String,
    pub findings: Vec<AiFinding>,
}

fn pct(f: f64) -> String {
    format!("{:.1} %", f * 100.0)
}

fn deg(d: f64) -> String {
    let a = d.abs();
    if a >= 10.0 {
        format!("{}°", a.round())
    } else {
        format!("{}°", (a * 10.0).round() / 10.0)
    }
}

fn duration(s: f64) -> String {
    let s = s.round() as i64;
    match s {
        0..=59 => format!("{s} s"),
        60..=3599 => format!("{} min {} s", s / 60, s % 60),
        _ => format!("{} h {} min", s / 3600, (s % 3600) / 60),
    }
}

fn hours_list(hours: &[u8]) -> String {
    hours
        .iter()
        .map(|h| format!("{h:02}:00-{:02}:00", (h + 1) % 24))
        .collect::<Vec<_>>()
        .join(", ")
}

fn finding(
    category: Cat,
    severity: Sev,
    title: &str,
    detail: String,
    actions: &[&str],
) -> AiFinding {
    AiFinding {
        category,
        severity,
        title: title.to_string(),
        detail,
        actions: actions.iter().map(|a| a.to_string()).collect(),
    }
}

fn cause_seconds(s: &DiagnosticSummary, cause: &str) -> f64 {
    s.outages_by_cause
        .iter()
        .filter(|(c, _)| c == cause)
        .map(|(_, v)| *v)
        .sum()
}

/// Guidance identical to the UI helper: rotation = desired − actual (positive = clockwise
/// seen from above), tilt = desired − actual (positive = up).
pub fn alignment_actions(delta_az: Option<f64>, delta_el: Option<f64>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(d) = delta_az.filter(|d| d.abs() > ALIGN_AZ_TOL_DEG) {
        let rotate = -d;
        out.push(format!(
            "Rotate the dish {} {}, seen from above.",
            deg(rotate),
            if rotate > 0.0 {
                "clockwise"
            } else {
                "counter-clockwise"
            }
        ));
    }
    if let Some(d) = delta_el.filter(|d| d.abs() > ALIGN_EL_TOL_DEG) {
        let tilt = -d;
        out.push(format!(
            "Tilt the dish {} {}.",
            deg(tilt),
            if tilt > 0.0 { "up" } else { "down" }
        ));
    }
    out
}

/// Runs every rule. Findings are sorted by severity (critical first), then category order.
pub fn evaluate(s: &DiagnosticSummary, ctx: &RuleContext) -> RulesOutcome {
    let mut f: Vec<AiFinding> = Vec::new();
    let frac = s.fraction_obstructed.unwrap_or(0.0);
    let obstructed_s = cause_seconds(s, "OBSTRUCTED");
    let obstruction_significant =
        frac > OBSTRUCTION_WARN || obstructed_s >= OBSTRUCTED_OUTAGE_WARN_S;

    // Insufficient data (partial window).
    if s.history_minutes < LOW_COVERAGE_MINUTES {
        f.push(finding(
            Cat::Configuration,
            Sev::Info,
            "Limited data",
            format!(
                "Only {} of the last 24 hours were recorded, so intermittent problems may be missed.",
                duration(s.history_minutes as f64 * 60.0)
            ),
            &["Keep StarlinkPulse running (it can stay in the tray) and run the diagnosis again later."],
        ));
    }

    // Obstruction.
    if obstruction_significant {
        let sev = if frac > OBSTRUCTION_CRIT || obstructed_s >= OBSTRUCTED_OUTAGE_CRIT_S {
            Sev::Critical
        } else {
            Sev::Warning
        };
        f.push(finding(
            Cat::Obstruction,
            sev,
            "Dish view obstructed",
            format!(
                "{} of the sky is obstructed and obstructions caused {} of outages in the last 24 h.",
                pct(frac),
                duration(obstructed_s)
            ),
            &[
                "Open the obstruction map to see where the blocked area is.",
                "Move the dish higher or to a spot with a clear view of the sky, or trim the obstacle (trees, roof edge, walls).",
            ],
        ));
    }

    // Alignment (manual dishes only).
    if ctx.actuators != ActuatorSupport::Yes {
        let actions = alignment_actions(
            s.alignment_delta_azimuth_deg,
            s.alignment_delta_elevation_deg,
        );
        if !actions.is_empty() {
            let az = s.alignment_delta_azimuth_deg.unwrap_or(0.0);
            let el = s.alignment_delta_elevation_deg.unwrap_or(0.0);
            let mut all: Vec<&str> = actions.iter().map(String::as_str).collect();
            all.push("Use the alignment helper in the app to confirm the new position.");
            f.push(finding(
                Cat::Configuration,
                Sev::Warning,
                "Dish not aimed where Starlink recommends",
                format!(
                    "The dish points {} off in direction and {} off in tilt from the recommended orientation (tolerance {}° / {}°).",
                    deg(az),
                    deg(el),
                    ALIGN_AZ_TOL_DEG,
                    ALIGN_EL_TOL_DEG
                ),
                &all,
            ));
        }
    }

    // POLICY_LIMIT (plan deprioritization).
    if s.throttled_minutes > 0 {
        let share = if s.history_minutes > 0 {
            (s.throttled_minutes as f64 / s.history_minutes as f64).min(1.0)
        } else {
            0.0
        };
        let mut detail = format!(
            "Starlink limited your speed (POLICY_LIMIT) for {} min, {} of the recorded time. This is a plan setting (deprioritization or data limit), not an equipment fault.",
            s.throttled_minutes,
            pct(share)
        );
        if share >= THROTTLE_PERMANENT_SHARE {
            detail.push_str(" The limit is active almost all the time, which is typical of deprioritized or limited plans.");
        }
        if !s.worst_hours.is_empty() {
            detail.push_str(&format!(" Slowest hours: {}.", hours_list(&s.worst_hours)));
        }
        f.push(finding(
            Cat::StarlinkNetwork,
            Sev::Info,
            "Speed limited by your plan",
            detail,
            &[
                "Check your plan and data usage in the Starlink app.",
                "Schedule large downloads outside the busiest evening hours.",
            ],
        ));
    }

    // Network-side outages (only when obstruction does not explain them).
    let network_s: f64 = NETWORK_CAUSES.iter().map(|c| cause_seconds(s, c)).sum();
    if !obstruction_significant && network_s >= NETWORK_OUTAGE_WARN_S {
        let causes: Vec<String> = s
            .outages_by_cause
            .iter()
            .filter(|(c, v)| NETWORK_CAUSES.contains(&c.as_str()) && *v > 0.0)
            .map(|(c, v)| format!("{c} {}", duration(*v)))
            .collect();
        f.push(finding(
            Cat::StarlinkNetwork,
            if network_s >= NETWORK_OUTAGE_CRIT_S { Sev::Critical } else { Sev::Warning },
            "Outages on the Starlink side",
            format!(
                "{} of outages without obstruction in the last 24 h ({}). The dish had a clear view, so these come from the satellite network or coverage.",
                duration(network_s),
                causes.join(", ")
            ),
            &[
                "Check status.starlink.com or the Starlink app for known outages in your area.",
                "If it keeps happening, report it to Starlink support with the outage times.",
            ],
        ));
    }

    // Reboots.
    if ctx.boot_count >= REBOOT_WARN {
        f.push(finding(
            Cat::Hardware,
            if ctx.boot_count >= REBOOT_CRIT { Sev::Critical } else { Sev::Warning },
            "Frequent dish restarts",
            format!(
                "The dish restarted {} times in the last 24 h ({} of BOOTING outages). One restart per day for software updates is normal.",
                ctx.boot_count,
                duration(cause_seconds(s, "BOOTING"))
            ),
            &[
                "Check the power supply and cable connections; avoid power strips and loose plugs.",
                "On battery or solar setups, check that the voltage stays stable under load.",
                "If restarts continue, contact Starlink support.",
            ],
        ));
    }

    // Latency / drop rate measured by the dish (not affected by local Wi-Fi).
    if !obstruction_significant {
        let p95 = s.latency_p95_ms.unwrap_or(0.0);
        let drop = s.drop_rate_avg.unwrap_or(0.0);
        let mut sev = None;
        if p95 > LATENCY_P95_WARN_MS || drop > DROP_WARN {
            sev = Some(Sev::Warning);
        }
        if p95 > LATENCY_P95_CRIT_MS || drop > DROP_CRIT {
            sev = Some(Sev::Critical);
        }
        if let Some(sev) = sev {
            let mut detail = format!(
                "Latency p95 is {} ms and {} of pings were lost (measured by the dish, so local Wi-Fi is not the cause).",
                p95.round(),
                pct(drop)
            );
            if !s.worst_hours.is_empty() {
                detail.push_str(&format!(
                    " Worst hours: {}, which points to network congestion.",
                    hours_list(&s.worst_hours)
                ));
            }
            f.push(finding(
                Cat::StarlinkNetwork,
                sev,
                "Slow or unstable Starlink connection",
                detail,
                &[
                    "Compare with the worst hours: if problems cluster in the evening, it is congestion in your area.",
                    "If devices feel slower than these numbers suggest, check your Wi-Fi as well.",
                ],
            ));
        }
    }

    // Weak Wi-Fi.
    if let Some(dbm) = s.weakest_wifi_signal_dbm.filter(|d| *d < WIFI_WARN_DBM) {
        f.push(finding(
            Cat::Wifi,
            if dbm < WIFI_CRIT_DBM { Sev::Critical } else { Sev::Warning },
            "Weak Wi-Fi signal",
            format!(
                "The weakest connected device has {} dBm (good is above {} dBm). Slowness on that device is local Wi-Fi, not Starlink.",
                dbm.round(),
                WIFI_WARN_DBM
            ),
            &[
                "Move the device or the router closer, away from walls and metal objects.",
                "Add a Starlink mesh node or use a cable for fixed devices.",
            ],
        ));
    }

    // Thermal.
    let shutdown = ctx.alerts.iter().any(|a| a == "thermalShutdown");
    let throttle = ctx.alerts.iter().any(|a| a == "thermalThrottle");
    if shutdown || throttle {
        f.push(finding(
            Cat::Hardware,
            if shutdown {
                Sev::Critical
            } else {
                Sev::Warning
            },
            if shutdown {
                "Dish shut down from heat"
            } else {
                "Dish overheating"
            },
            "The dish reports a thermal alert and limits its performance to cool down.".to_string(),
            &[
                "Give the dish free air flow and avoid enclosures or hot surfaces under it.",
                "Do not cover the dish; it cools down by itself when temperatures drop.",
            ],
        ));
    }

    let rank = |s: Sev| match s {
        Sev::Critical => 0,
        Sev::Warning => 1,
        Sev::Info => 2,
    };
    f.sort_by_key(|x| rank(x.severity));

    let problems = f.iter().filter(|x| x.severity != Sev::Info).count();
    let overall_health = if f.iter().any(|x| x.severity == Sev::Critical) {
        AiOverallHealth::Poor
    } else if problems > 0 {
        AiOverallHealth::Fair
    } else {
        AiOverallHealth::Good
    };
    let headline = match (problems, f.first()) {
        (0, _) => {
            if f.is_empty() {
                f.push(finding(
                    Cat::StarlinkNetwork,
                    Sev::Info,
                    "Connection healthy",
                    format!(
                        "Latency p95 {} ms, {} ping loss, {} outages ({}) in the last 24 h.",
                        s.latency_p95_ms
                            .map_or("n/a".into(), |v| v.round().to_string()),
                        pct(s.drop_rate_avg.unwrap_or(0.0)),
                        s.outage_count,
                        duration(s.outage_total_s)
                    ),
                    &["No action needed."],
                ));
            }
            "No problems found in the last 24 hours.".to_string()
        }
        (1, Some(top)) => format!("1 issue found: {}.", top.title.to_lowercase()),
        (n, Some(top)) => format!(
            "{n} issues found; most important: {}.",
            top.title.to_lowercase()
        ),
        (_, None) => "No problems found in the last 24 hours.".to_string(),
    };
    RulesOutcome {
        overall_health,
        headline,
        findings: f,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy() -> DiagnosticSummary {
        DiagnosticSummary {
            language: "en".into(),
            window_hours: 24,
            history_minutes: 24 * 60,
            latency_avg_ms: Some(30.0),
            latency_p95_ms: Some(45.0),
            drop_rate_avg: Some(0.002),
            fraction_obstructed: Some(0.0),
            ..Default::default()
        }
    }

    fn manual() -> RuleContext {
        RuleContext {
            actuators: ActuatorSupport::No,
            ..Default::default()
        }
    }

    fn titles(o: &RulesOutcome) -> Vec<&str> {
        o.findings.iter().map(|f| f.title.as_str()).collect()
    }

    fn find<'a>(o: &'a RulesOutcome, title: &str) -> Option<&'a AiFinding> {
        o.findings.iter().find(|f| f.title == title)
    }

    #[test]
    fn healthy_connection() {
        let o = evaluate(&healthy(), &manual());
        assert_eq!(o.overall_health, AiOverallHealth::Good);
        assert_eq!(titles(&o), vec!["Connection healthy"]);
        assert_eq!(o.headline, "No problems found in the last 24 hours.");
        assert!(o.findings[0].detail.contains("45 ms"));
    }

    #[test]
    fn obstruction_boundaries() {
        let mut s = healthy();
        s.fraction_obstructed = Some(0.01);
        assert!(
            find(&evaluate(&s, &manual()), "Dish view obstructed").is_none(),
            "exactly 1 % is ok"
        );
        s.fraction_obstructed = Some(0.0101);
        let o = evaluate(&s, &manual());
        assert_eq!(
            find(&o, "Dish view obstructed").unwrap().severity,
            Sev::Warning
        );
        assert!(
            find(&o, "Dish view obstructed")
                .unwrap()
                .detail
                .contains("1.0 %")
        );
        s.fraction_obstructed = Some(0.0301);
        let o = evaluate(&s, &manual());
        assert_eq!(
            find(&o, "Dish view obstructed").unwrap().severity,
            Sev::Critical
        );
        assert_eq!(o.overall_health, AiOverallHealth::Poor);
        // Outage seconds alone also trigger it.
        let mut s = healthy();
        s.outages_by_cause = vec![("OBSTRUCTED".into(), 29.0)];
        assert!(find(&evaluate(&s, &manual()), "Dish view obstructed").is_none());
        s.outages_by_cause = vec![("OBSTRUCTED".into(), 30.0)];
        assert_eq!(
            find(&evaluate(&s, &manual()), "Dish view obstructed")
                .unwrap()
                .severity,
            Sev::Warning
        );
        s.outages_by_cause = vec![("OBSTRUCTED".into(), 300.0)];
        assert_eq!(
            find(&evaluate(&s, &manual()), "Dish view obstructed")
                .unwrap()
                .severity,
            Sev::Critical
        );
    }

    #[test]
    fn alignment_guidance_and_motorized_skip() {
        let mut s = healthy();
        // Recon Mini: actual 9.1°, desired 20.0° -> delta -10.9 -> rotate 11° clockwise.
        s.alignment_delta_azimuth_deg = Some(-10.9);
        s.alignment_delta_elevation_deg = Some(0.1);
        let o = evaluate(&s, &manual());
        let a = find(&o, "Dish not aimed where Starlink recommends").unwrap();
        assert_eq!(
            a.actions[0],
            "Rotate the dish 11° clockwise, seen from above."
        );
        assert_eq!(a.actions.len(), 2, "no tilt action within tolerance");
        // Boundaries: exactly 2° / 1° is fine.
        s.alignment_delta_azimuth_deg = Some(2.0);
        s.alignment_delta_elevation_deg = Some(-1.0);
        assert!(
            find(
                &evaluate(&s, &manual()),
                "Dish not aimed where Starlink recommends"
            )
            .is_none()
        );
        s.alignment_delta_azimuth_deg = Some(2.5);
        s.alignment_delta_elevation_deg = Some(-1.5);
        let o = evaluate(&s, &manual());
        let a = find(&o, "Dish not aimed where Starlink recommends").unwrap();
        assert_eq!(
            a.actions[0],
            "Rotate the dish 2.5° counter-clockwise, seen from above."
        );
        assert_eq!(a.actions[1], "Tilt the dish 1.5° up.");
        // Motorized dishes align themselves.
        let motor = RuleContext {
            actuators: ActuatorSupport::Yes,
            ..Default::default()
        };
        assert!(
            find(
                &evaluate(&s, &motor),
                "Dish not aimed where Starlink recommends"
            )
            .is_none()
        );
    }

    #[test]
    fn throttling_is_info_with_worst_hours() {
        let mut s = healthy();
        s.throttled_minutes = 1400;
        s.worst_hours = vec![20, 21, 23];
        let o = evaluate(&s, &manual());
        let t = find(&o, "Speed limited by your plan").unwrap();
        assert_eq!(t.severity, Sev::Info);
        assert!(t.detail.contains("1400 min"));
        assert!(t.detail.contains("almost all the time"));
        assert!(t.detail.contains("20:00-21:00, 21:00-22:00, 23:00-00:00"));
        assert_eq!(o.overall_health, AiOverallHealth::Good, "info only");
    }

    #[test]
    fn network_outages_only_without_obstruction() {
        let mut s = healthy();
        s.outages_by_cause = vec![("NO_DOWNLINK".into(), 40.0), ("NO_PINGS".into(), 19.0)];
        assert!(
            find(&evaluate(&s, &manual()), "Outages on the Starlink side").is_none(),
            "59 s"
        );
        s.outages_by_cause.push(("SKY_SEARCH".into(), 1.0));
        let o = evaluate(&s, &manual());
        let n = find(&o, "Outages on the Starlink side").unwrap();
        assert_eq!(n.severity, Sev::Warning);
        assert_eq!(n.category, Cat::StarlinkNetwork);
        assert!(n.detail.contains("NO_DOWNLINK 40 s"));
        s.outages_by_cause = vec![("NO_SCHEDULE".into(), 600.0)];
        assert_eq!(
            find(&evaluate(&s, &manual()), "Outages on the Starlink side")
                .unwrap()
                .severity,
            Sev::Critical
        );
        // With obstruction the obstruction finding explains it instead.
        s.fraction_obstructed = Some(0.05);
        let o = evaluate(&s, &manual());
        assert!(find(&o, "Outages on the Starlink side").is_none());
        assert!(find(&o, "Dish view obstructed").is_some());
    }

    #[test]
    fn reboots() {
        let s = healthy();
        let ctx = |n| RuleContext {
            boot_count: n,
            ..manual()
        };
        assert!(find(&evaluate(&s, &ctx(1)), "Frequent dish restarts").is_none());
        assert_eq!(
            find(&evaluate(&s, &ctx(2)), "Frequent dish restarts")
                .unwrap()
                .severity,
            Sev::Warning
        );
        let o = evaluate(&s, &ctx(4));
        let r = find(&o, "Frequent dish restarts").unwrap();
        assert_eq!(r.severity, Sev::Critical);
        assert_eq!(r.category, Cat::Hardware);
    }

    #[test]
    fn latency_and_drop_boundaries() {
        let mut s = healthy();
        s.latency_p95_ms = Some(100.0);
        s.drop_rate_avg = Some(0.01);
        assert!(
            find(
                &evaluate(&s, &manual()),
                "Slow or unstable Starlink connection"
            )
            .is_none()
        );
        s.latency_p95_ms = Some(100.5);
        assert_eq!(
            find(
                &evaluate(&s, &manual()),
                "Slow or unstable Starlink connection"
            )
            .unwrap()
            .severity,
            Sev::Warning
        );
        s.latency_p95_ms = Some(50.0);
        s.drop_rate_avg = Some(0.0501);
        assert_eq!(
            find(
                &evaluate(&s, &manual()),
                "Slow or unstable Starlink connection"
            )
            .unwrap()
            .severity,
            Sev::Critical
        );
        s.latency_p95_ms = Some(201.0);
        s.drop_rate_avg = Some(0.0);
        s.worst_hours = vec![21];
        let o = evaluate(&s, &manual());
        let f = find(&o, "Slow or unstable Starlink connection").unwrap();
        assert_eq!(f.severity, Sev::Critical);
        assert!(f.detail.contains("201 ms") && f.detail.contains("congestion"));
        // Obstruction explains it.
        s.fraction_obstructed = Some(0.02);
        assert!(
            find(
                &evaluate(&s, &manual()),
                "Slow or unstable Starlink connection"
            )
            .is_none()
        );
    }

    #[test]
    fn wifi_boundaries() {
        let mut s = healthy();
        s.weakest_wifi_signal_dbm = Some(-70.0);
        assert!(find(&evaluate(&s, &manual()), "Weak Wi-Fi signal").is_none());
        s.weakest_wifi_signal_dbm = Some(-71.0);
        assert_eq!(
            find(&evaluate(&s, &manual()), "Weak Wi-Fi signal")
                .unwrap()
                .severity,
            Sev::Warning
        );
        s.weakest_wifi_signal_dbm = Some(-80.0);
        assert_eq!(
            find(&evaluate(&s, &manual()), "Weak Wi-Fi signal")
                .unwrap()
                .severity,
            Sev::Warning
        );
        s.weakest_wifi_signal_dbm = Some(-91.0);
        let o = evaluate(&s, &manual());
        let w = find(&o, "Weak Wi-Fi signal").unwrap();
        assert_eq!(w.severity, Sev::Critical);
        assert_eq!(w.category, Cat::Wifi);
        assert!(w.detail.contains("-91 dBm"));
    }

    #[test]
    fn thermal_alerts() {
        let s = healthy();
        let ctx = |a: &str| RuleContext {
            alerts: vec![a.into()],
            ..manual()
        };
        assert_eq!(
            find(&evaluate(&s, &ctx("thermalThrottle")), "Dish overheating")
                .unwrap()
                .severity,
            Sev::Warning
        );
        assert_eq!(
            find(
                &evaluate(&s, &ctx("thermalShutdown")),
                "Dish shut down from heat"
            )
            .unwrap()
            .severity,
            Sev::Critical
        );
        assert_eq!(
            evaluate(&s, &ctx("isHeating")).overall_health,
            AiOverallHealth::Good
        );
    }

    #[test]
    fn limited_data_and_ordering() {
        let mut s = healthy();
        s.history_minutes = 719;
        s.weakest_wifi_signal_dbm = Some(-75.0);
        s.fraction_obstructed = Some(0.04);
        let o = evaluate(&s, &manual());
        assert_eq!(
            titles(&o),
            vec!["Dish view obstructed", "Weak Wi-Fi signal", "Limited data"],
            "critical, warning, info"
        );
        assert!(o.findings[2].detail.contains("11 h 59 min"));
        assert_eq!(
            o.headline,
            "2 issues found; most important: dish view obstructed."
        );
        s.history_minutes = 720;
        assert!(find(&evaluate(&s, &manual()), "Limited data").is_none());
    }

    #[test]
    fn deterministic() {
        let mut s = healthy();
        s.fraction_obstructed = Some(0.02);
        s.throttled_minutes = 10;
        assert_eq!(evaluate(&s, &manual()), evaluate(&s, &manual()));
    }
}
