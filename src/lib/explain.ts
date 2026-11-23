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
  return {
    restricted: true,
    title: labelEnum(RESTRICTIONS, raw),
    detail: t("Starlink is limiting bandwidth for this reason."),
  };
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
  nosats: tk("No satellites in view"),
  actuatoractivity: tk("Dish moving"),
  cabletest: tk("Cable test"),
  sleeping: tk("Sleeping (power save)"),
  movingwhilenotpermitted: tk("Moving while not allowed"),
  movingtoofast: tk("Moving too fast"),
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
  return labelEnum(DISABLEMENT, raw);
}

// ---- Readable labels for other dish enums (EN keys, translated at call time) ----

/** Maps a raw enum to a translated label; unknown values fall back to a humanized name. */
export function labelEnum(map: Record<string, string>, raw: string | null | undefined, strip?: RegExp): string {
  if (!raw) return humanizeEnum(raw);
  const k = key(strip ? raw.replace(strip, "") : raw);
  return map[k] ? t(map[k]) : humanizeEnum(strip ? raw.replace(strip, "") : raw);
}

const RESTRICTIONS: Record<string, string> = {
  policylimit: tk("Speed limited by plan"),
  networkcongestion: tk("Network congestion"),
  datacap: tk("Data allowance used up"),
};

const DISABLEMENT: Record<string, string> = {
  noactiveaccount: tk("No active account"),
  accountdisabled: tk("Account disabled"),
  toofarfromserviceaddress: tk("Too far from the service address"),
  inocean: tk("In ocean (plan doesn't cover it)"),
  blockedcountry: tk("Not available in this country"),
  dataoveragesandboxpolicy: tk("Data limit reached"),
  cellisdisabled: tk("Service cell disabled"),
  roamrestricted: tk("Roaming not allowed"),
  unknownlocation: tk("Location unknown"),
  unsupportedversion: tk("Software version not supported"),
  movingtoofastpolicy: tk("Moving too fast for this plan"),
  aviationflyoverlimits: tk("Aviation limits"),
};

const SOFTWARE_UPDATE: Record<string, string> = {
  idle: tk("Up to date"),
  fetching: tk("Downloading update"),
  precheck: tk("Checking update"),
  writing: tk("Installing update"),
  postcheck: tk("Verifying update"),
  rebootrequired: tk("Restart needed to finish update"),
  disabled: tk("Updates disabled"),
  faulted: tk("Update failed"),
  unknown: tk("Unknown"),
};

/** Software update state, e.g. "IDLE" → "Up to date". */
export function explainSoftwareUpdate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return labelEnum(SOFTWARE_UPDATE, raw, /^SOFTWARE_UPDATE_STATE_/i);
}

const ESTIMATION: Record<string, string> = {
  converged: tk("Position settled"),
  converging: tk("Settling position"),
  unconverged: tk("Position not settled"),
  initializing: tk("Starting position estimate"),
  reset: tk("Position estimate restarted"),
  unknown: tk("Unknown"),
};

/** Attitude estimator state, e.g. "FILTER_CONVERGED" → "Position settled". */
export function explainEstimation(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return labelEnum(ESTIMATION, raw, /^(ATTITUDE_)?FILTER_/i);
}
