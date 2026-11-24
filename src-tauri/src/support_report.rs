//! Anonymized Markdown support report (`get_support_report` / `export_support_report`).
//!
//! Contains only aggregated metrics, firmware/hardware versions, outages, alerts and rule
//! findings. Never device IDs, location/GPS, MAC addresses or Wi-Fi device names.

use chrono::{DateTime, Local, TimeZone};

use crate::error::AppError;
use crate::i18n::{Lang, ReportTexts, dec_trim, fill};
use crate::models::{
    ActuatorSupport, AiSeverity, DiagnosticSummary, DishCapabilities, DishEvent, UptimeStats,
};
use crate::rules::duration;
use crate::state::{AppState, lock_db};
use crate::time::now_ms;
use crate::wifi::WifiSummary;

pub const OUTAGE_WINDOW_MINUTES: u32 = 48 * 60;
pub const MAX_OUTAGE_ROWS: usize = 50;

pub struct ReportInputs<'a> {
    pub generated_ms: i64,
    pub app_version: &'a str,
    pub caps: &'a DishCapabilities,
    /// 24 h summary including the rule findings.
    pub summary: &'a DiagnosticSummary,
    pub uptime: &'a UptimeStats,
    pub outages_48h: &'a [DishEvent],
    pub alerts: &'a [String],
    /// `None` when no Starlink router is connected.
    pub wifi: Option<&'a WifiSummary>,
}

/// Table cell / inline text: no pipes or line breaks.
fn cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\n', '\r'], " ")
}

fn pct(lang: Lang, fraction: Option<f64>, t: &ReportTexts) -> String {
    match fraction.filter(|v| v.is_finite()) {
        Some(f) => format!("{} %", dec_trim(lang, f * 100.0, 2)),
        None => t.unknown.to_string(),
    }
}

fn ms(lang: Lang, v: Option<f64>) -> String {
    v.filter(|x| x.is_finite())
        .map(|x| dec_trim(lang, x, 0))
        .unwrap_or_else(|| "–".into())
}

fn local_time<Tz: TimeZone>(ms: i64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(tz).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Renders the report (pure; `tz` is the local time zone in the app).
pub fn render<Tz: TimeZone>(inp: &ReportInputs<'_>, lang: Lang, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let t = ReportTexts::get(lang);
    let s = inp.summary;
    let mut out = String::with_capacity(4096);
    let mut line = |l: &str| {
        out.push_str(l);
        out.push('\n');
    };

    line(&format!("# {}", t.title));
    line("");
    line(&fill(
        t.generated,
        &[
            ("time", &local_time(inp.generated_ms, tz)),
            ("version", inp.app_version),
        ],
    ));
    if inp.caps.is_mock || s.is_simulated {
        line("");
        line(&format!("> **{}**", t.simulated));
    }

    // Dish
    line("");
    line(&format!("## {}", t.dish));
    line("");
    let hw = inp
        .caps
        .hardware_version
        .as_deref()
        .or(s.hardware_version.as_deref())
        .unwrap_or(t.unknown);
    let fw = inp
        .caps
        .software_version
        .as_deref()
        .or(s.software_version.as_deref())
        .unwrap_or(t.unknown);
    line(&format!("- {}: `{}`", t.hardware, cell(hw)));
    line(&format!("- {}: `{}`", t.firmware, cell(fw)));
    let motorized = match inp.caps.actuators {
        ActuatorSupport::Yes => t.yes,
        ActuatorSupport::No => t.no,
        ActuatorSupport::Unknown => t.unknown,
    };
    line(&format!("- {}: {motorized}", t.motorized));
    let day = inp.uptime.windows.iter().find(|w| w.label == "24h");
    let coverage = day
        .filter(|w| w.window_s > 0.0)
        .map(|w| (w.covered_s / w.window_s).clamp(0.0, 1.0));
    line(&format!(
        "- {}: {}",
        t.coverage,
        fill(
            t.coverage_value,
            &[
                ("pct", &pct(lang, coverage, t)),
                ("minutes", &s.history_minutes.to_string()),
            ],
        )
    ));

    // Uptime
    line("");
    line(&format!("## {}", t.uptime));
    line("");
    line(&format!(
        "| {} | {} | {} | {} | {} |",
        t.window, t.uptime, t.outages, t.downtime, t.coverage
    ));
    line("|---|---:|---:|---:|---:|");
    for w in &inp.uptime.windows {
        let cov = (w.window_s > 0.0).then(|| (w.covered_s / w.window_s).clamp(0.0, 1.0));
        line(&format!(
            "| {} | {} | {} | {} | {} |",
            cell(&w.label),
            pct(lang, w.uptime_pct.map(|p| p / 100.0), t),
            w.outage_count,
            duration(w.outage_s),
            pct(lang, cov, t)
        ));
    }

    // Last 24 h
    line("");
    line(&format!("## {}", t.last_24h));
    line("");
    line(&format!(
        "- {}: {} / {} ms",
        t.latency,
        ms(lang, s.latency_avg_ms),
        ms(lang, s.latency_p95_ms)
    ));
    line(&format!("- {}: {}", t.loss, pct(lang, s.drop_rate_avg, t)));
    line(&format!(
        "- {}: {}",
        t.obstruction,
        pct(lang, s.fraction_obstructed, t)
    ));
    line(&format!("- {}: {}", t.throttled, s.throttled_minutes));
    let alerts = if inp.alerts.is_empty() {
        t.none.to_string()
    } else {
        inp.alerts
            .iter()
            .map(|a| format!("`{}`", cell(a)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    line(&format!("- {}: {alerts}", t.alerts));

    // Outages 48 h
    line("");
    line(&format!("## {}", t.outages_48h));
    line("");
    if inp.outages_48h.is_empty() {
        line(t.no_outages);
    } else {
        let mut by_cause: Vec<(String, u32, f64)> = Vec::new();
        for o in inp.outages_48h {
            let secs = o.duration_ms.max(0) as f64 / 1000.0;
            match by_cause.iter_mut().find(|(c, _, _)| *c == o.cause) {
                Some(e) => {
                    e.1 += 1;
                    e.2 += secs;
                }
                None => by_cause.push((o.cause.clone(), 1, secs)),
            }
        }
        by_cause.sort_by(|a, b| b.2.total_cmp(&a.2));
        line(&format!("**{}**", t.totals_by_cause));
        line("");
        line(&format!("| {} | {} | {} |", t.cause, t.count, t.duration));
        line("|---|---:|---:|");
        for (cause, n, secs) in &by_cause {
            line(&format!(
                "| `{}` | {n} | {} |",
                cell(cause),
                duration(*secs)
            ));
        }
        line("");
        let mut rows: Vec<&DishEvent> = inp.outages_48h.iter().collect();
        rows.sort_by_key(|a| std::cmp::Reverse(a.start_ms));
        line(&format!("| {} | {} | {} |", t.start, t.duration, t.cause));
        line("|---|---:|---|");
        for o in rows.iter().take(MAX_OUTAGE_ROWS) {
            line(&format!(
                "| {} | {} | `{}` |",
                local_time(o.start_ms, tz),
                duration(o.duration_ms.max(0) as f64 / 1000.0),
                cell(&o.cause)
            ));
        }
        if rows.len() > MAX_OUTAGE_ROWS {
            line("");
            line(&fill(
                t.more_rows,
                &[("count", &(rows.len() - MAX_OUTAGE_ROWS).to_string())],
            ));
        }
    }

    // Rule findings
    line("");
    line(&format!("## {}", t.diagnosis));
    line("");
    if s.rule_findings.is_empty() {
        line(t.no_findings);
    }
    for f in &s.rule_findings {
        let sev = match f.severity {
            AiSeverity::Info => t.info,
            AiSeverity::Warning => t.warning,
            AiSeverity::Critical => t.critical,
        };
        line(&format!(
            "- **[{sev}] {}**: {}",
            cell(&f.title),
            cell(&f.detail)
        ));
        for a in &f.actions {
            line(&format!("  - {}", cell(a)));
        }
    }

    // Wi-Fi (counts only, never names)
    line("");
    line(&format!("## {}", t.wifi));
    line("");
    match inp.wifi {
        None => line(t.wifi_absent),
        Some(w) => {
            line(&format!(
                "- {}",
                fill(
                    t.wifi_devices,
                    &[
                        ("total", &w.total.to_string()),
                        ("b24", &w.ghz2_4.to_string()),
                        ("b5", &w.ghz5.to_string()),
                        ("b6", &w.ghz6.to_string()),
                        ("eth", &w.ethernet.to_string()),
                        ("other", &w.other.to_string()),
                    ],
                )
            ));
            let weakest = w
                .weakest_dbm
                .map(|d| format!("{} dBm", dec_trim(lang, d, 0)))
                .unwrap_or_else(|| "–".into());
            line(&format!(
                "- {}",
                fill(
                    t.wifi_signal,
                    &[
                        ("good", &w.good.to_string()),
                        ("fair", &w.fair.to_string()),
                        ("poor", &w.poor.to_string()),
                        ("weakest", &weakest),
                    ],
                )
            ));
        }
    }

    line("");
    line("---");
    line("");
    line(&format!("_{}_", t.privacy));
    out
}

/// Builds the report from the active data source in the current UI language.
pub async fn build(state: &AppState) -> Result<String, AppError> {
    let now = now_ms();
    let summary = crate::ai::current_summary(state).await?;
    let uptime = crate::commands::uptime_stats(state).await?;
    let db = state.current_db().await;
    let outages =
        tokio::task::spawn_blocking(move || lock_db(&db).outages(OUTAGE_WINDOW_MINUTES, now))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))??;
    let caps = state.capabilities.read().await.clone();
    let alerts = state
        .snapshot
        .read()
        .await
        .as_ref()
        .map(|s| s.alerts.clone())
        .unwrap_or_default();
    let router = state.status.read().await.router_available;
    let wifi = if router {
        Some(crate::wifi::summary(&state.wifi_clients.read().await))
    } else {
        None
    };
    Ok(render(
        &ReportInputs {
            generated_ms: now,
            app_version: env!("CARGO_PKG_VERSION"),
            caps: &caps,
            summary: &summary,
            uptime: &uptime,
            outages_48h: &outages,
            alerts: &alerts,
            wifi: wifi.as_ref(),
        },
        crate::i18n::current(),
        &Local,
    ))
}

/// Suggested file name, e.g. `starlinkpulse-support-20261122-1730.md` (local time).
pub fn default_file_name(now_ms: i64) -> String {
    let t = DateTime::from_timestamp_millis(now_ms)
        .unwrap_or_default()
        .with_timezone(&Local);
    format!("starlinkpulse-support-{}.md", t.format("%Y%m%d-%H%M"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dish::{DeviceName, WifiClientInfo};
    use crate::models::{AiFinding, AiFindingCategory, UptimeWindow};
    use chrono::Utc;

    fn inputs_and_render(lang: Lang, n_outages: usize) -> String {
        let caps = DishCapabilities {
            hardware_version: Some("mini1_prod1".into()),
            software_version: Some("2026.11.1.mr1".into()),
            actuators: ActuatorSupport::No,
            ..Default::default()
        };
        let summary = DiagnosticSummary {
            history_minutes: 1400,
            latency_avg_ms: Some(31.4),
            latency_p95_ms: Some(58.2),
            drop_rate_avg: Some(0.0125),
            fraction_obstructed: Some(0.031),
            throttled_minutes: 12,
            rule_findings: vec![AiFinding {
                category: AiFindingCategory::Obstruction,
                severity: AiSeverity::Warning,
                title: "Obstructions".into(),
                detail: "3.1 % of the sky | blocked".into(),
                actions: vec!["Move the dish".into()],
            }],
            ..Default::default()
        };
        let uptime = UptimeStats {
            windows: vec![
                UptimeWindow {
                    label: "24h".into(),
                    window_s: 86_400.0,
                    covered_s: 84_000.0,
                    uptime_pct: Some(99.5),
                    outage_count: 3,
                    outage_s: 250.0,
                },
                UptimeWindow {
                    label: "7d".into(),
                    window_s: 604_800.0,
                    covered_s: 0.0,
                    uptime_pct: None,
                    outage_count: 0,
                    outage_s: 0.0,
                },
            ],
        };
        let base = 1_795_305_600_000i64;
        let outages: Vec<DishEvent> = (0..n_outages)
            .map(|i| DishEvent {
                start_ms: base + i as i64 * 60_000,
                duration_ms: 5_000,
                cause: if i % 2 == 0 {
                    "OBSTRUCTED"
                } else {
                    "NO_DOWNLINK"
                }
                .into(),
                severity: None,
            })
            .collect();
        let clients = vec![
            WifiClientInfo {
                name: Some(DeviceName("Secret Phone".into())),
                iface: Some("RF_2GHZ".into()),
                role: Some("CLIENT".into()),
                signal_strength_dbm: Some(-80.0),
                ..Default::default()
            },
            WifiClientInfo {
                name: Some(DeviceName("Kitchen TV".into())),
                iface: Some("RF_5GHZ".into()),
                role: Some("CLIENT".into()),
                signal_strength_dbm: Some(-50.0),
                ..Default::default()
            },
        ];
        let wifi = crate::wifi::summary(&clients);
        render(
            &ReportInputs {
                generated_ms: base,
                app_version: "1.2.3",
                caps: &caps,
                summary: &summary,
                uptime: &uptime,
                outages_48h: &outages,
                alerts: &["thermalThrottle".to_string()],
                wifi: Some(&wifi),
            },
            lang,
            &Utc,
        )
    }

    #[test]
    fn report_contents_without_names() {
        let md = inputs_and_render(Lang::En, 60);
        for needle in [
            "# StarlinkPulse support report",
            "2026-11-22 00:00",
            "StarlinkPulse 1.2.3",
            "`mini1_prod1`",
            "`2026.11.1.mr1`",
            "Motorized: no",
            "1400 min",
            "| 24h | 99.5 % | 3 | 4 min 10 s |",
            "31 / 58 ms",
            "Ping loss: 1.25 %",
            "Sky obstructed: 3.1 %",
            "Throttled minutes: 12",
            "`thermalThrottle`",
            "| `OBSTRUCTED` | 30 | 2 min 30 s |",
            "10 older outages not shown.",
            "**[warning] Obstructions**: 3.1 % of the sky \\| blocked",
            "  - Move the dish",
            "Devices: 2 (2.4 GHz: 1, 5 GHz: 1",
            "poor 1; weakest -80 dBm",
            "no device IDs, location/GPS, MAC addresses or device names",
        ] {
            assert!(md.contains(needle), "missing {needle:?} in\n{md}");
        }
        // Newest first and at most 50 outage rows.
        assert_eq!(md.matches("| 5 s |").count(), MAX_OUTAGE_ROWS);
        assert!(md.find("00:59").unwrap() < md.find("00:58").unwrap());
        assert!(!md.contains("Secret Phone") && !md.contains("Kitchen TV"));

        let it = inputs_and_render(Lang::It, 0);
        assert!(it.contains("# Report di supporto StarlinkPulse"));
        assert!(it.contains("Ping persi: 1,25 %"));
        assert!(it.contains("Nessuna interruzione registrata."));
        assert!(!it.contains("Secret Phone"));
    }

    #[test]
    fn file_name() {
        let n = default_file_name(1_795_305_600_000);
        assert!(n.starts_with("starlinkpulse-support-2026112"));
        assert!(n.ends_with(".md") && n.len() == "starlinkpulse-support-20261122-0000.md".len());
    }
}
