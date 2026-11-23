import type { BatteryConfig, DailyEnergy } from "@/types/models";
import { isNum } from "@/lib/format";

/** Usable energy of the battery in Wh. */
export function batteryWh(b: BatteryConfig): number {
  return Math.max(0, b.capacityAh) * Math.max(0, b.voltage) * Math.min(1, Math.max(0, b.usableFraction));
}

/** Estimated runtime in seconds at a constant draw; null without a valid draw. */
export function runtimeSeconds(b: BatteryConfig | null | undefined, watts: number | null | undefined): number | null {
  if (!b || !isNum(watts) || watts <= 0) return null;
  return (batteryWh(b) / watts) * 3600;
}

/** Mean of the non-null values, or null. */
export function mean(values: (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (isNum(v)) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : null;
}

export interface EnergySummary {
  /** Average Wh per fully covered day. */
  whPerDay: number | null;
  avgW: number | null;
  peakW: number | null;
}

/** Summary over complete days (≥ 20 h of data), so today's partial day doesn't skew it. */
export function summarizeEnergy(days: DailyEnergy[]): EnergySummary {
  const full = days.filter((d) => d.coveredS >= 20 * 3600);
  const peaks = days.map((d) => d.peakW).filter(isNum);
  return {
    whPerDay: mean(full.map((d) => d.wh)),
    avgW: mean(days.map((d) => d.avgW)),
    peakW: peaks.length ? Math.max(...peaks) : null,
  };
}
