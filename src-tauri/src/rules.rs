//! Deterministic rule engine (ADR-005, Phase 4.6): the default diagnosis, offline and free.
//!
//! Pure function over the 24 h [`DiagnosticSummary`] plus a small [`RuleContext`] (dish
//! motors, live alerts, reboot count). Thresholds are named constants documented in
//! `docs/diagnostics.md`. Texts come from the EN/IT catalog (`i18n::RuleTexts`) and always
//! quote the measured numbers, formatted per locale.

use crate::i18n::{Lang, RuleTexts, dec, dec_trim, fill};
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
/// Per-axis tolerances: which rotate/tilt actions to give, and the fallback check when the
/// combined pointing error is unknown (same as the UI helper).
pub const ALIGN_AZ_TOL_DEG: f64 = 2.0;
pub const ALIGN_EL_TOL_DEG: f64 = 1.0;
/// Combined pointing error above which the dish counts as misaligned. Third-party guides
/// report ~5° as the point where the Starlink app warns; not an official figure.
pub const ALIGN_TOTAL_TOL_DEG: f64 = 5.0;
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

/// Congestion is claimed only when the worst hour's p95 exceeds this multiple of the 24 h
/// average latency.
pub const CONGESTION_FACTOR: f64 = 1.5;

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
    /// Latency p95 during the worst local hour (`worstHours[0]`), for the congestion claim.
    pub worst_hour_p95_ms: Option<f64>,
    /// Text language (numbers use its decimal separator).
    pub lang: Lang,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RulesOutcome {
    pub overall_health: AiOverallHealth,
    pub headline: String,
    pub findings: Vec<AiFinding>,
}

/// Locale-aware formatting helpers bound to one language.
struct Fmt {
    lang: Lang,
}

impl Fmt {
    fn pct(&self, f: f64) -> String {
        format!("{} %", dec(self.lang, f * 100.0, 1))
    }

    /// ≥ 10° whole degrees, otherwise 0.1° (same as the UI helper).
    fn deg(&self, d: f64) -> String {
        let a = d.abs();
        if a >= 10.0 {
            format!("{}°", dec_trim(self.lang, a.round(), 0))
        } else {
            format!("{}°", dec_trim(self.lang, (a * 10.0).round() / 10.0, 1))
        }
    }

    fn int(&self, v: f64) -> String {
        dec_trim(self.lang, v.round(), 0)
    }
}

pub fn duration(s: f64) -> String {
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
pub fn alignment_actions(
    lang: Lang,
    az_correction: Option<f64>,
    el_correction: Option<f64>,
) -> Vec<String> {
    let t = RuleTexts::get(lang);
    let fm = Fmt { lang };
    let mut out = Vec::new();
    if let Some(rotate) = az_correction.filter(|d| d.abs() > ALIGN_AZ_TOL_DEG) {
        let tpl = if rotate > 0.0 {
            t.rotate_cw
        } else {
            t.rotate_ccw
        };
        out.push(fill(tpl, &[("deg", &fm.deg(rotate))]));
    }
    if let Some(tilt) = el_correction.filter(|d| d.abs() > ALIGN_EL_TOL_DEG) {
        let tpl = if tilt > 0.0 { t.tilt_up } else { t.tilt_down };
        out.push(fill(tpl, &[("deg", &fm.deg(tilt))]));
    }
    out
}

/// Runs every rule. Findings are sorted by severity (critical first), then category order.
pub fn evaluate(s: &DiagnosticSummary, ctx: &RuleContext) -> RulesOutcome {
    let lang = ctx.lang;
    let t = RuleTexts::get(lang);
    let fm = Fmt { lang };
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
            t.limited_title,
            fill(
                t.limited_detail,
                &[("duration", &duration(s.history_minutes as f64 * 60.0))],
            ),
            &[t.limited_action],
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
            t.obstruction_title,
            fill(
                t.obstruction_detail,
                &[
                    ("pct", &fm.pct(frac)),
                    ("duration", &duration(obstructed_s)),
                ],
            ),
            &[t.obstruction_action_map, t.obstruction_action_move],
        ));
    }

    // Alignment: concrete rotate/tilt actions only for dishes known to have no motors.
    let off_az = s
        .azimuth_correction_deg
        .is_some_and(|d| d.abs() > ALIGN_AZ_TOL_DEG);
    let off_el = s
        .elevation_correction_deg
        .is_some_and(|d| d.abs() > ALIGN_EL_TOL_DEG);
    let misaligned = match s.pointing_error_deg {
        Some(e) => e > ALIGN_TOTAL_TOL_DEG,
        None => off_az || off_el,
    };
    let az = fm.deg(s.azimuth_correction_deg.unwrap_or(0.0));
    let el = fm.deg(s.elevation_correction_deg.unwrap_or(0.0));
    if ctx.actuators == ActuatorSupport::Unknown && misaligned {
        f.push(finding(
            Cat::Configuration,
            Sev::Info,
            t.orientation_unknown_title,
            fill(t.orientation_unknown_detail, &[("az", &az), ("el", &el)]),
            &[t.orientation_unknown_action],
        ));
    }
    if ctx.actuators == ActuatorSupport::No && misaligned {
        let actions = alignment_actions(lang, s.azimuth_correction_deg, s.elevation_correction_deg);
        if !actions.is_empty() {
            let mut all: Vec<&str> = actions.iter().map(String::as_str).collect();
            all.push(t.alignment_confirm);
            f.push(finding(
                Cat::Configuration,
                Sev::Warning,
                t.misaligned_title,
                fill(t.misaligned_detail, &[("az", &az), ("el", &el)])
                    + &s.pointing_error_deg.map_or(String::new(), |e| {
                        fill(
                            t.misaligned_total,
                            &[
                                ("total", &fm.deg(e)),
                                ("tol", &dec_trim(lang, ALIGN_TOTAL_TOL_DEG, 1)),
                            ],
                        )
                    }),
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
        let mut detail = fill(
            t.throttle_detail,
            &[
                ("minutes", &s.throttled_minutes.to_string()),
                ("pct", &fm.pct(share)),
            ],
        );
        if share >= THROTTLE_PERMANENT_SHARE {
            detail.push_str(t.throttle_permanent);
        }
        f.push(finding(
            Cat::StarlinkNetwork,
            Sev::Info,
            t.throttle_title,
            detail,
            &[t.throttle_action_plan, t.throttle_action_schedule],
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
        // "Clear view" only when obstruction was actually measured and is low.
        let view = if s.fraction_obstructed.is_some_and(|f| f <= OBSTRUCTION_WARN) {
            t.network_clear_view
        } else {
            t.network_no_obstruction
        };
        let mut detail = fill(
            t.network_detail,
            &[
                ("duration", &duration(network_s)),
                ("causes", &causes.join(", ")),
                ("view", view),
            ],
        );
        if cause_seconds(s, "SKY_SEARCH") > 0.0 {
            detail.push_str(t.network_sky_search);
        }
        f.push(finding(
            Cat::StarlinkNetwork,
            if network_s >= NETWORK_OUTAGE_CRIT_S {
                Sev::Critical
            } else {
                Sev::Warning
            },
            t.network_title,
            detail,
            &[t.network_action_status, t.network_action_support],
        ));
    }

    // Reboots.
    if ctx.boot_count >= REBOOT_WARN {
        f.push(finding(
            Cat::Hardware,
            if ctx.boot_count >= REBOOT_CRIT {
                Sev::Critical
            } else {
                Sev::Warning
            },
            t.reboot_title,
            fill(
                t.reboot_detail,
                &[
                    ("count", &ctx.boot_count.to_string()),
                    ("duration", &duration(cause_seconds(s, "BOOTING"))),
                ],
            ),
            &[
                t.reboot_action_power,
                t.reboot_action_battery,
                t.reboot_action_support,
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
            let mut detail = fill(
                t.slow_detail,
                &[("p95", &fm.int(p95)), ("pct", &fm.pct(drop))],
            );
            // Claim congestion only when the worst hour clearly stands out from the day.
            let avg = s.latency_avg_ms.unwrap_or(0.0);
            if let (Some(&hour), Some(worst)) = (s.worst_hours.first(), ctx.worst_hour_p95_ms)
                && avg > 0.0
                && worst > CONGESTION_FACTOR * avg
            {
                detail.push_str(&fill(
                    t.slow_congestion,
                    &[
                        ("hour", &hours_list(&[hour])),
                        ("worst", &fm.int(worst)),
                        ("avg", &fm.int(avg)),
                    ],
                ));
            }
            f.push(finding(
                Cat::StarlinkNetwork,
                sev,
                t.slow_title,
                detail,
                &[t.slow_action_hours, t.slow_action_wifi],
            ));
        }
    }

    // Weak Wi-Fi.
    if let Some(dbm) = s.weakest_wifi_signal_dbm.filter(|d| *d < WIFI_WARN_DBM) {
        f.push(finding(
            Cat::Wifi,
            if dbm < WIFI_CRIT_DBM {
                Sev::Critical
            } else {
                Sev::Warning
            },
            t.wifi_title,
            fill(
                t.wifi_detail,
                &[("dbm", &fm.int(dbm)), ("limit", &fm.int(WIFI_WARN_DBM))],
            ),
            &[t.wifi_action_move, t.wifi_action_mesh],
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
                t.thermal_shutdown_title
            } else {
                t.thermal_title
            },
            t.thermal_detail.to_string(),
            &[t.thermal_action_air, t.thermal_action_cover],
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
                    t.healthy_title,
                    fill(
                        t.healthy_detail,
                        &[
                            (
                                "p95",
                                &s.latency_p95_ms
                                    .map_or(t.not_available.to_string(), |v| fm.int(v)),
                            ),
                            ("pct", &fm.pct(s.drop_rate_avg.unwrap_or(0.0))),
                            ("count", &s.outage_count.to_string()),
                            ("duration", &duration(s.outage_total_s)),
                        ],
                    ),
                    &[t.healthy_action],
                ));
            }
            t.headline_none.to_string()
        }
        (1, Some(top)) => fill(t.headline_one, &[("title", &top.title.to_lowercase())]),
        (n, Some(top)) => fill(
            t.headline_many,
            &[
                ("count", &n.to_string()),
                ("title", &top.title.to_lowercase()),
            ],
        ),
        (_, None) => t.headline_none.to_string(),
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
        // Recon Mini: actual 9.1°, desired 20.0° -> correction +10.9 -> rotate 11° clockwise.
        s.azimuth_correction_deg = Some(10.9);
        s.elevation_correction_deg = Some(0.1);
        let o = evaluate(&s, &manual());
        let a = find(&o, "Dish not aimed where Starlink recommends").unwrap();
        assert_eq!(
            a.actions[0],
            "Rotate the dish 11° clockwise, seen from above."
        );
        assert_eq!(a.actions.len(), 2, "no tilt action within tolerance");
        // Boundaries: exactly 2° / 1° is fine.
        s.azimuth_correction_deg = Some(2.0);
        s.elevation_correction_deg = Some(-1.0);
        assert!(
            find(
                &evaluate(&s, &manual()),
                "Dish not aimed where Starlink recommends"
            )
            .is_none()
        );
        s.azimuth_correction_deg = Some(-2.5);
        s.elevation_correction_deg = Some(1.5);
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
        let o = evaluate(&s, &motor);
        assert!(find(&o, "Dish not aimed where Starlink recommends").is_none());
        assert!(find(&o, "Dish orientation differs from the recommendation").is_none());
        // Unknown motors: info with the numbers, no rotate/tilt instructions.
        let unknown = RuleContext::default();
        assert_eq!(unknown.actuators, ActuatorSupport::Unknown);
        let o = evaluate(&s, &unknown);
        assert!(find(&o, "Dish not aimed where Starlink recommends").is_none());
        let i = find(&o, "Dish orientation differs from the recommendation").unwrap();
        assert_eq!(i.severity, Sev::Info);
        assert!(i.detail.contains("2.5°") && i.detail.contains("1.5°"));
        assert!(
            i.actions
                .iter()
                .all(|a| !a.contains("Rotate") && !a.contains("Tilt"))
        );
        assert!(i.actions[0].starts_with("If your dish has no motors"));
        // Combined error wins over per-axis checks: the installer's Mini at 69° elevation
        // (6.7° / 3.3° off per axis) is 4.2° off in total, which the Starlink app calls aligned.
        s.azimuth_correction_deg = Some(-6.7);
        s.elevation_correction_deg = Some(-3.3);
        s.pointing_error_deg = Some(4.2);
        assert!(
            find(
                &evaluate(&s, &manual()),
                "Dish not aimed where Starlink recommends"
            )
            .is_none()
        );
        assert!(
            find(
                &evaluate(&s, &unknown),
                "Dish orientation differs from the recommendation"
            )
            .is_none()
        );
        s.pointing_error_deg = Some(5.1);
        let o = evaluate(&s, &manual());
        let a = find(&o, "Dish not aimed where Starlink recommends").unwrap();
        assert_eq!(a.actions.len(), 3, "rotate + tilt + confirm");
        assert!(a.detail.ends_with(
            "Combined, it points 5.1° away from the target, more than the 5° Starlink tolerates."
        ));
        s.pointing_error_deg = None;
        // Within tolerance: nothing at all.
        s.azimuth_correction_deg = Some(1.0);
        s.elevation_correction_deg = Some(0.5);
        assert!(
            find(
                &evaluate(&s, &unknown),
                "Dish orientation differs from the recommendation"
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
        assert!(
            !t.detail.contains("20:00"),
            "no hours in the POLICY_LIMIT finding"
        );
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
        assert!(n.detail.contains("clear view"), "fraction measured at 0 %");
        assert!(n.detail.contains("SKY_SEARCH can also follow a restart"));
        // Obstruction not measured: no "clear view" claim.
        let mut unmeasured = s.clone();
        unmeasured.fraction_obstructed = None;
        let d = find(
            &evaluate(&unmeasured, &manual()),
            "Outages on the Starlink side",
        )
        .unwrap()
        .detail
        .clone();
        assert!(!d.contains("clear view") && d.contains("No significant obstruction was measured"));
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
        // Worst hour not clearly above the day (avg 30 ms, factor 1.5 -> 45 ms): no claim.
        let flat = RuleContext {
            worst_hour_p95_ms: Some(45.0),
            ..manual()
        };
        let f = find(&evaluate(&s, &flat), "Slow or unstable Starlink connection")
            .unwrap()
            .clone();
        assert_eq!(f.severity, Sev::Critical);
        assert!(f.detail.contains("201 ms") && !f.detail.contains("congestion"));
        let peaky = RuleContext {
            worst_hour_p95_ms: Some(46.0),
            ..manual()
        };
        let o = evaluate(&s, &peaky);
        let f = find(&o, "Slow or unstable Starlink connection").unwrap();
        assert!(f.detail.contains("21:00-22:00") && f.detail.contains("congestion"));
        // Without the per-hour value no congestion claim either.
        assert!(
            !find(
                &evaluate(&s, &manual()),
                "Slow or unstable Starlink connection"
            )
            .unwrap()
            .detail
            .contains("congestion")
        );
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

    #[test]
    fn italian_output_uses_comma_decimals() {
        let mut s = healthy();
        s.fraction_obstructed = Some(0.0412);
        s.outages_by_cause = vec![("OBSTRUCTED".into(), 75.0)];
        s.azimuth_correction_deg = Some(-2.5);
        s.elevation_correction_deg = Some(1.5);
        s.history_minutes = 600;
        let ctx = RuleContext {
            lang: Lang::It,
            ..manual()
        };
        let o = evaluate(&s, &ctx);
        let obs = find(&o, "Visuale della parabola ostruita").unwrap();
        assert_eq!(obs.severity, Sev::Critical);
        assert_eq!(
            obs.detail,
            "Il 4,1 % del cielo è ostruito e le ostruzioni hanno causato 1 min 15 s di interruzioni nelle ultime 24 h."
        );
        let al = find(&o, "Parabola non orientata come consigliato da Starlink").unwrap();
        assert_eq!(
            al.actions[0],
            "Ruota la parabola di 2,5° in senso antiorario, vista dall'alto."
        );
        assert_eq!(al.actions[1], "Inclina la parabola di 1,5° verso l'alto.");
        assert!(
            find(&o, "Dati limitati")
                .unwrap()
                .detail
                .contains("10 h 0 min")
        );
        assert_eq!(
            o.headline,
            "2 problemi rilevati; il più importante: visuale della parabola ostruita."
        );
        // Same findings in English.
        let en = evaluate(&s, &manual());
        assert_eq!(en.findings.len(), o.findings.len());
        assert!(en.findings[0].detail.starts_with("4.1 % of the sky"));
    }
}
