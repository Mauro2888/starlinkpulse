import type { WifiBand, WifiDevice, WifiQuality } from "@/types/models";
import { tk } from "@/i18n/keys";
import { isNum } from "@/lib/format";

export const BAND_LABELS: Record<WifiBand, string> = {
  "2.4ghz": "2.4 GHz",
  "5ghz": "5 GHz",
  "6ghz": "6 GHz",
  ethernet: tk("Ethernet"),
  unknown: tk("Unknown band"),
};

export function isRepeater(d: WifiDevice): boolean {
  return d.role?.toUpperCase() === "REPEATER";
}

/** Backend quality, or a fallback from dBm (≥ -65 good, ≥ -70 fair, as the backend diagnosis). */
export function wifiQuality(d: WifiDevice): WifiQuality | null {
  if (d.quality) return d.quality;
  if (!isNum(d.signalDbm) || d.band === "ethernet") return null;
  return d.signalDbm >= -65 ? "good" : d.signalDbm >= -70 ? "fair" : "poor";
}

/** Stable list key: name + band + role, with the index as a tiebreaker for duplicates. */
export function wifiDeviceKey(d: WifiDevice, i: number, all: WifiDevice[]): string {
  const base = `${d.name ?? ""}|${d.band}|${d.role ?? ""}`;
  const dup = all.slice(0, i).filter((o) => `${o.name ?? ""}|${o.band}|${o.role ?? ""}` === base).length;
  return dup ? `${base}#${dup}` : base;
}

/** Short advice when some device has a poor signal; null when all is fine. */
export function weakSignalTip(devices: WifiDevice[]): string | null {
  const poor = devices.filter((d) => wifiQuality(d) === "poor" && !isRepeater(d));
  if (poor.length === 0) return null;
  if (poor.some((d) => d.band === "5ghz" || d.band === "6ghz")) {
    return tk(
      "Weak 5/6 GHz signal: move closer to the router, or let far devices use 2.4 GHz, which reaches further but is slower. A mesh unit helps in distant rooms.",
    );
  }
  return tk(
    "Weak signal: move the device or the router closer and away from walls and metal. Near the router, 5 GHz is faster; a mesh unit helps in distant rooms.",
  );
}
