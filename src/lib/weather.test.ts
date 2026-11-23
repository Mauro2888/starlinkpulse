import { describe, expect, it } from "vitest";
import type { DishEvent, WeatherPoint } from "@/types/models";
import { correlateOutages, isWet, weatherAt } from "@/lib/weather";

const H = 3_600_000;
const wp = (hourMs: number, precipitationMm: number | null, snowfallCm: number | null = 0): WeatherPoint => ({
  hourMs,
  precipitationMm,
  snowfallCm,
  cloudCoverPct: null,
  windKmh: null,
});
const ev = (startMs: number, cause = "NO_SATELLITES_IN_VIEW"): DishEvent => ({ startMs, durationMs: 5000, cause, severity: null });

describe("weather correlation", () => {
  it("isWet uses 0.1 mm and any snow, tolerates nulls", () => {
    expect(isWet(wp(0, 0.1))).toBe(true);
    expect(isWet(wp(0, 0.09))).toBe(false);
    expect(isWet(wp(0, 0, 0.2))).toBe(true);
    expect(isWet(wp(0, null, null))).toBe(false);
  });

  it("finds the point of the containing hour", () => {
    const pts = [wp(10 * H, 0), wp(11 * H, 1)];
    expect(weatherAt(pts, 11 * H + 59_000)?.precipitationMm).toBe(1);
    expect(weatherAt(pts, 12 * H)).toBeUndefined();
  });

  it("counts wet outages and ignores reboots", () => {
    const pts = [wp(10 * H, 0), wp(11 * H, 2)];
    const r = correlateOutages([ev(10 * H + 5), ev(11 * H + 5), ev(11 * H + 9, "BOOTING"), ev(13 * H)], pts);
    expect(r).toEqual({ total: 3, wet: 1 });
  });
});
