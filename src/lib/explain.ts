// Plain-language explanations for raw dish enums. Unknown values fall back to
// a humanized version of the raw name, never an error.

import { humanizeEnum } from "@/lib/format";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

/** Normalizes "thermal_throttle", "thermalThrottle", "THERMAL-THROTTLE" to "thermalthrottle". */
function key(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

interface AlertInfo {
  title: string;
  detail: string;
  tone: Tone;
}

const ALERTS: Record<string, AlertInfo> = {
  motorsstuck: { title: "Motors stuck", detail: "The dish cannot move to its optimal position.", tone: "critical" },
  thermalthrottle: { title: "Thermal throttling", detail: "The dish is too hot and has reduced performance.", tone: "serious" },
  thermalshutdown: { title: "Thermal shutdown", detail: "The dish shut down to protect itself from heat.", tone: "critical" },
  powersupplythermalthrottle: { title: "Power supply hot", detail: "The power supply is throttling to cool down.", tone: "serious" },
  mastnotnearvertical: { title: "Mount not vertical", detail: "The mast is tilted. Check the mount.", tone: "warning" },
  unexpectedlocation: { title: "Unexpected location", detail: "The dish is outside its registered service area.", tone: "warning" },
  slowethernetspeeds: { title: "Slow Ethernet", detail: "The Ethernet link negotiated below 1 Gbps. Check the cable.", tone: "warning" },
  slowethernetspeeds100: { title: "Slow Ethernet", detail: "The Ethernet link is running at 100 Mbps. Check the cable.", tone: "warning" },
  roaming: { title: "Roaming", detail: "The dish is using roaming service.", tone: "neutral" },
  installpending: { title: "Update ready", detail: "A software update will install on the next reboot.", tone: "neutral" },
  isheating: { title: "Heating", detail: "Snow melt is warming the dish surface.", tone: "neutral" },
  dishwaterdetected: { title: "Water detected", detail: "Water was detected inside the dish.", tone: "critical" },
  routerwaterdetected: { title: "Router water detected", detail: "Water was detected inside the router.", tone: "critical" },
  lowersignalthanpredicted: { title: "Weak signal", detail: "Signal is lower than expected for this location.", tone: "warning" },
  obstructionmapreset: { title: "Obstruction map reset", detail: "The dish is rebuilding its view of the sky.", tone: "neutral" },
  ispowersaveidle: { title: "Power save", detail: "The dish is idle in power-save mode.", tone: "neutral" },
  upsufficientsignal: { title: "Weak uplink", detail: "Upload signal is not sufficient.", tone: "warning" },
};

export function explainAlert(raw: string): AlertInfo {
  return (
    ALERTS[key(raw)] ?? {
      title: humanizeEnum(raw),
      detail: "Reported by the dish.",
      tone: "warning",
    }
  );
}

export interface RestrictionInfo {
  restricted: boolean;
  title: string;
  detail: string;
}

/** Explains `dl/ulBandwidthRestrictedReason`. NO_LIMIT, UNKNOWN and null mean "not restricted". */
export function explainRestriction(raw: string | null | undefined): RestrictionInfo {
  const k = raw ? key(raw) : "";
  if (!k || k === "nolimit" || k === "unknown") {
    return { restricted: false, title: "No limit", detail: "Your plan is not limiting speed right now." };
  }
  if (k === "policylimit") {
    return {
      restricted: true,
      title: "Speed limited by plan",
      detail:
        "Starlink is capping your speed under your plan's fair-use policy, for example after a data allowance or in a congested area. The dish itself is fine.",
    };
  }
  return { restricted: true, title: humanizeEnum(raw), detail: "Starlink is limiting bandwidth for this reason." };
}

const CAUSES: Record<string, string> = {
  obstructed: "Obstructed",
  nodownlink: "No downlink",
  noschedule: "No satellite scheduled",
  nopings: "No pings",
  booting: "Reboot",
  skysearch: "Searching sky",
  stowed: "Stowed",
  thermalshutdown: "Thermal shutdown",
  gpsinvalid: "GPS invalid",
  antenna: "Antenna fault",
  networkunreachable: "Network unreachable",
  cellisdisabled: "Cell disabled",
  rollingupdate: "Software update",
  unknown: "Unknown",
};

/** Human label for an outage cause, e.g. "OUTAGE_NO_DOWNLINK" -> "No downlink". */
export function explainCause(raw: string): string {
  const k = key(raw).replace(/^outage/, "");
  return CAUSES[k] ?? humanizeEnum(raw.replace(/^OUTAGE_/i, ""));
}

/** True when the event marks a reboot rather than a connectivity drop. */
export function isRebootCause(raw: string): boolean {
  return key(raw).replace(/^outage/, "") === "booting";
}

/** Disablement codes other than OKAY mean the service is off. */
export function explainDisablement(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = key(raw);
  if (k === "okay" || k === "unknownstate" || k === "unknown") return null;
  return humanizeEnum(raw);
}
