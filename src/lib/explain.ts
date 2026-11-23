// Plain-language explanations for raw dish enums. Unknown values fall back to
// a humanized version of the raw name, never an error.

import { humanizeEnum } from "@/lib/format";
import { tr as t } from "@/i18n";
import { tk } from "@/i18n/keys";

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
  motorsstuck: { title: tk("Motors stuck"), detail: tk("The dish cannot move to its optimal position."), tone: "critical" },
  thermalthrottle: { title: tk("Thermal throttling"), detail: tk("The dish is too hot and has reduced performance."), tone: "serious" },
  thermalshutdown: { title: tk("Thermal shutdown"), detail: tk("The dish shut down to protect itself from heat."), tone: "critical" },
  powersupplythermalthrottle: { title: tk("Power supply hot"), detail: tk("The power supply is throttling to cool down."), tone: "serious" },
  mastnotnearvertical: { title: tk("Mount not vertical"), detail: tk("The mast is tilted. Check the mount."), tone: "warning" },
  unexpectedlocation: { title: tk("Unexpected location"), detail: tk("The dish is outside its registered service area."), tone: "warning" },
  slowethernetspeeds: { title: tk("Slow Ethernet"), detail: tk("The Ethernet link negotiated below 1 Gbps. Check the cable."), tone: "warning" },
  slowethernetspeeds100: { title: tk("Slow Ethernet"), detail: tk("The Ethernet link is running at 100 Mbps. Check the cable."), tone: "warning" },
  roaming: { title: tk("Roaming"), detail: tk("The dish is using roaming service."), tone: "neutral" },
  installpending: { title: tk("Update ready"), detail: tk("A software update will install on the next reboot."), tone: "neutral" },
  isheating: { title: tk("Heating"), detail: tk("Snow melt is warming the dish surface."), tone: "neutral" },
  dishwaterdetected: { title: tk("Water detected"), detail: tk("Water was detected inside the dish."), tone: "critical" },
  routerwaterdetected: { title: tk("Router water detected"), detail: tk("Water was detected inside the router."), tone: "critical" },
  lowersignalthanpredicted: { title: tk("Weak signal"), detail: tk("Signal is lower than expected for this location."), tone: "warning" },
  obstructionmapreset: { title: tk("Obstruction map reset"), detail: tk("The dish is rebuilding its view of the sky."), tone: "neutral" },
  ispowersaveidle: { title: tk("Power save"), detail: tk("The dish is idle in power-save mode."), tone: "neutral" },
  upsufficientsignal: { title: tk("Weak uplink"), detail: tk("Upload signal is not sufficient."), tone: "warning" },
};

export function explainAlert(raw: string): AlertInfo {
  const info = ALERTS[key(raw)];
  if (!info) return { title: humanizeEnum(raw), detail: t("Reported by the dish."), tone: "warning" };
  return { ...info, title: t(info.title), detail: t(info.detail) };
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
    return { restricted: false, title: t("No limit"), detail: t("Your plan is not limiting speed right now.") };
  }
  if (k === "policylimit") {
    return {
      restricted: true,
      title: t("Speed limited by plan"),
      detail: t(
        "Starlink is capping your speed under your plan's fair-use policy, for example after a data allowance or in a congested area. The dish itself is fine.",
      ),
    };
  }
  return { restricted: true, title: humanizeEnum(raw), detail: t("Starlink is limiting bandwidth for this reason.") };
}

const CAUSES: Record<string, string> = {
  obstructed: tk("Obstructed"),
  nodownlink: tk("No downlink"),
  noschedule: tk("No satellite scheduled"),
  nopings: tk("No pings"),
  booting: tk("Reboot"),
  skysearch: tk("Searching sky"),
  stowed: tk("Stowed"),
  thermalshutdown: tk("Thermal shutdown"),
  gpsinvalid: tk("GPS invalid"),
  antenna: tk("Antenna fault"),
  networkunreachable: tk("Network unreachable"),
  cellisdisabled: tk("Cell disabled"),
  rollingupdate: tk("Software update"),
  unknown: tk("Unknown"),
};

/** Human label for an outage cause, e.g. "OUTAGE_NO_DOWNLINK" -> "No downlink". */
export function explainCause(raw: string): string {
  const k = key(raw).replace(/^outage/, "");
  return CAUSES[k] ? t(CAUSES[k]) : humanizeEnum(raw.replace(/^OUTAGE_/i, ""));
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
