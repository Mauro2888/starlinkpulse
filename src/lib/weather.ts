import type { DishEvent, WeatherPoint, WeatherSeries } from "@/types/models";
import { isNum } from "@/lib/format";
import { isRebootCause } from "@/lib/explain";

const HOUR = 3_600_000;

/** An hour counts as wet at >= 0.1 mm precipitation or any snowfall. */
export function isWet(p: WeatherPoint): boolean {
  return (isNum(p.precipitationMm) && p.precipitationMm >= 0.1) || (isNum(p.snowfallCm) && p.snowfallCm > 0);
}

export function isSnow(p: WeatherPoint): boolean {
  return isNum(p.snowfallCm) && p.snowfallCm > 0;
}

/** Weather point of the hour containing `ms`, if any. */
export function weatherAt(points: WeatherPoint[], ms: number): WeatherPoint | undefined {
  const hour = Math.floor(ms / HOUR) * HOUR;
  return points.find((p) => p.hourMs === hour);
}

export interface OutageWeather {
  /** Outages (reboots excluded) in the range. */
  total: number;
  /** Of those, how many started in a wet hour. */
  wet: number;
}

export function correlateOutages(events: DishEvent[], points: WeatherPoint[]): OutageWeather {
  let total = 0;
  let wet = 0;
  for (const e of events) {
    if (isRebootCause(e.cause)) continue;
    total++;
    const p = weatherAt(points, e.startMs);
    if (p && isWet(p)) wet++;
  }
  return { total, wet };
}

/** Chart rows: rain in mm, snowfall in cm. */
export function precipRows(series: WeatherSeries): { t: number; rain: number | null; snow: number | null }[] {
  return series.points.map((p) => ({
    t: p.hourMs,
    rain: isNum(p.precipitationMm) ? p.precipitationMm : null,
    snow: isNum(p.snowfallCm) ? p.snowfallCm : null,
  }));
}
