// Canned AI Advisor data for the in-browser mock (dev only). No network calls.

import type { AiFinding, AiOverallHealth, AiReport, DiagnosticSummary, MockProfile } from "@/types/models";
import type { ProfileSpec } from "@/lib/mock/profiles";

export function mockSummary(profile: MockProfile, p: ProfileSpec): DiagnosticSummary {
  if (p.offline) {
    return {
      language: "en",
      windowHours: 24,
      historyMinutes: 0,
      hardwareVersion: null,
      softwareVersion: null,
      latencyAvgMs: null,
      latencyP95Ms: null,
      dropRateAvg: null,
      fractionObstructed: null,
      outageCount: 0,
      outageTotalS: 0,
      outagesByCause: [],
      worstHours: [],
      throttledMinutes: 0,
      alignmentDeltaAzimuthDeg: null,
      alignmentDeltaElevationDeg: null,
      weakestWifiSignalDbm: null,
    };
  }
  const outageCount = Math.round(p.outagesPerDay);
  const byCause = new Map<string, number>();
  p.causes.forEach((c, i) => byCause.set(c, (byCause.get(c) ?? 0) + Math.round((outageCount * 22) / p.causes.length) + i * 3));
  return {
    language: "en",
    windowHours: 24,
    historyMinutes: 30 * 60,
    hardwareVersion: p.capabilities.hardwareVersion,
    softwareVersion: p.capabilities.softwareVersion,
    latencyAvgMs: Math.round(p.latencyMs * 1.08 * 10) / 10,
    latencyP95Ms: Math.round(p.latencyMs * 1.9 * 10) / 10,
    dropRateAvg: p.dropRate,
    fractionObstructed: p.obstructed,
    outageCount,
    outageTotalS: [...byCause.values()].reduce((a, b) => a + b, 0),
    outagesByCause: [...byCause.entries()],
    worstHours: [20, 21, 22],
    throttledMinutes: profile === "throttled" ? 1_312 : 0,
    alignmentDeltaAzimuthDeg: profile === "mini" ? 11.2 : p.capabilities.actuators === "yes" ? null : 1.4,
    alignmentDeltaElevationDeg: profile === "mini" ? -2.1 : p.capabilities.actuators === "yes" ? null : 0.6,
    weakestWifiSignalDbm: p.capabilities.hasRouter ? -71 : null,
  };
}

const wifiFinding: AiFinding = {
  category: "wifi",
  severity: "info",
  title: "One Wi-Fi device has a weak signal",
  detail:
    "The weakest client sits at -71 dBm. That's usable for browsing but can cause stutter on video calls. Starlink itself looks fine for this device.",
  actions: ["Move the router closer to where you work, or raise it off the floor", "Use the 5 GHz band only near the router"],
};

const eveningFinding: AiFinding = {
  category: "starlink_network",
  severity: "info",
  title: "Latency rises in the evening",
  detail:
    "Latency is about 35% higher between 20:00 and 23:00. This matches peak usage in your cell and is normal for Starlink. No action is needed unless it affects your work.",
  actions: ["Schedule large downloads or backups outside 19:00–23:00"],
};

export function mockReport(profile: MockProfile, p: ProfileSpec, model: string): AiReport {
  const payload = mockSummary(profile, p);
  let overallHealth: AiOverallHealth = "good";
  let headline = "Your connection was healthy over the last 24 hours.";
  const findings: AiFinding[] = [];

  if (profile === "obstructed") {
    overallHealth = "poor";
    headline = "Obstructions are causing frequent short dropouts.";
    findings.push({
      category: "obstruction",
      severity: "critical",
      title: "The dish's view of the sky is blocked 8.4% of the time",
      detail:
        "Most of the 30 outages in the last 24 hours were caused by obstructions, each lasting a few seconds. Video calls and games will freeze when this happens. Starlink recommends less than 1% obstruction.",
      actions: [
        "Open the obstruction map in the Starlink app to see which direction is blocked",
        "Move the dish higher or further from trees and roof edges",
        "Re-check obstruction % here after 12 hours",
      ],
    });
    findings.push({
      category: "starlink_network",
      severity: "warning",
      title: "Packet loss is high during dropouts",
      detail: "Average drop rate is 6%. Outside the obstruction events, the network looks normal, so fixing the view should fix this too.",
      actions: ["Fix the obstruction first, then run the Advisor again"],
    });
  } else if (profile === "throttled") {
    overallHealth = "fair";
    headline = "Your plan is limiting speed (POLICY_LIMIT), not your hardware.";
    findings.push({
      category: "starlink_network",
      severity: "warning",
      title: "Speed capped by your Starlink plan for about 22 hours",
      detail:
        "The dish reported POLICY_LIMIT for 1,312 minutes. Starlink applies this after a data allowance runs out or in congested areas. Download averages about 4.5 Mbps while capped. Signal, alignment and obstructions are fine.",
      actions: [
        "Check your data usage and plan in the Starlink app or website",
        "Consider adding priority data or changing plan if this happens often",
        "Pause automatic cloud backups and updates until the cap resets",
      ],
    });
    findings.push(eveningFinding);
  } else if (profile === "mini") {
    overallHealth = "fair";
    headline = "The dish is aimed about 11° away from its ideal direction.";
    findings.push({
      category: "configuration",
      severity: "warning",
      title: "Rotate the dish about 11° east",
      detail:
        "Starlink Mini can't steer itself. It points 11.2° west of the ideal azimuth and 2° too low. This reduces signal margin and can add short dropouts in bad weather.",
      actions: [
        "Turn the dish about 11° clockwise (towards east), seen from above",
        "Tilt it up slightly, about 2°",
        "Use the alignment tool in the Starlink app to confirm",
      ],
    });
    findings.push({
      category: "power",
      severity: "info",
      title: "Power draw is normal for a Mini",
      detail: "Average draw is about 27 W, within the expected range. If you run on battery, plan for roughly 650 Wh per day.",
      actions: [],
    });
    findings.push(wifiFinding);
  } else {
    findings.push(eveningFinding);
    if (p.capabilities.hasRouter) findings.push(wifiFinding);
    findings.push({
      category: "hardware",
      severity: "info",
      title: "No hardware issues detected",
      detail: "No thermal throttling, motor or power supply alerts in the last 24 hours. Firmware is up to date.",
      actions: [],
    });
  }

  return { generatedAtMs: Date.now(), model, overallHealth, headline, findings, payload };
}
