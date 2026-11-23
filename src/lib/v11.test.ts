import { describe, expect, it } from "vitest";
import type { HourCell } from "@/types/models";
import { bestAndWorst, toMatrix, weekdayName } from "@/lib/time-of-day";
import { batteryWh, runtimeSeconds, summarizeEnergy } from "@/lib/energy";
import { hasEnoughData } from "@/components/history/locations-card";
import { validateSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/mock";

function grid(fn: (d: number, h: number) => number | null): HourCell[] {
  const cells: HourCell[] = [];
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      const v = fn(d, h);
      cells.push({ weekday: d, hour: h, minutes: v === null ? 0 : 60, latencyAvgMs: v, latencyP95Ms: v, dropRateAvg: v === null ? null : v / 1000, downlinkAvgBps: v === null ? null : 1e9 / v });
    }
  return cells;
}

describe("best times", () => {
  // Weekday mornings 06–10 fast, Sunday 20–23 slow.
  const cells = grid((d, h) => (d < 5 && h >= 6 && h < 10 ? 20 : d === 6 && h >= 20 && h < 23 ? 200 : 60));

  it("finds the best weekday window and the worst single-day window", () => {
    const { best, worst } = bestAndWorst(cells, "latency");
    expect(best).toMatchObject({ days: "weekdays", startHour: 6, endHour: 10 });
    expect(worst).toMatchObject({ days: 6, startHour: 20, endHour: 23 });
  });

  it("treats higher download as better", () => {
    const { best, worst } = bestAndWorst(cells, "download");
    expect(best).toMatchObject({ days: "weekdays", startHour: 6 });
    expect(worst).toMatchObject({ days: 6, startHour: 20 });
  });

  it("ignores windows without enough data and handles empty grids", () => {
    expect(bestAndWorst(grid(() => null), "latency")).toEqual({ best: null, worst: null });
    expect(toMatrix(grid(() => null), "drop")[3][12]).toBeNull();
  });

  it("names weekdays Monday first", () => {
    expect(weekdayName(0, "long")).toBe("Monday");
    expect(weekdayName(6, "long")).toBe("Sunday");
  });
});

describe("energy", () => {
  const battery = { capacityAh: 100, voltage: 12, usableFraction: 0.8 };
  it("estimates runtime from usable Wh and draw", () => {
    expect(batteryWh(battery)).toBe(960);
    expect(runtimeSeconds(battery, 32)).toBeCloseTo(30 * 3600);
    expect(runtimeSeconds(battery, 0)).toBeNull();
    expect(runtimeSeconds(null, 32)).toBeNull();
  });
  it("averages Wh over complete days only", () => {
    const s = summarizeEnergy([
      { dayMs: 0, wh: 1000, avgW: 40, peakW: 60, coveredS: 86400 },
      { dayMs: 1, wh: 200, avgW: 42, peakW: 70, coveredS: 4 * 3600 },
    ]);
    expect(s.whPerDay).toBe(1000);
    expect(s.peakW).toBe(70);
    expect(s.avgW).toBe(41);
  });
});

describe("locations and battery settings", () => {
  it("needs an hour of data per location", () => {
    expect(hasEnoughData({ coveredS: 3599 } as never)).toBe(false);
    expect(hasEnoughData({ coveredS: 3600 } as never)).toBe(true);
  });
  it("validates battery values", () => {
    const base = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications } };
    expect(validateSettings({ ...base, battery: { capacityAh: 100, voltage: 12, usableFraction: 0.8 } })).toEqual({});
    expect(validateSettings({ ...base, battery: { capacityAh: 0, voltage: 12, usableFraction: 0.8 } }).battery).toBeTruthy();
    expect(validateSettings({ ...base, battery: { capacityAh: 100, voltage: 12, usableFraction: 0.05 } }).battery).toBeTruthy();
  });
});
