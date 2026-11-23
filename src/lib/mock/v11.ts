// Phase 6 (v1.1) mock data: locations, time-of-day, energy. Dev only.

import type { DailyEnergy, HourCell, LocationStats, TimeOfDayStats } from "@/types/models";
import type { ProfileSpec } from "@/lib/mock/profiles";

const DAY = 86_400_000;

function hash(n: number): number {
  const x = Math.sin(n * 78.233 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

interface LocSeed {
  coveredS: number;
  outagesPerHour: number;
  obstructed: number;
  p95: number;
  drop: number;
  downBps: number;
  firstDaysAgo: number;
}

/** Mutable per-session location store. */
export class MockLocations {
  private seeds = new Map<string, LocSeed>([
    ["", { coveredS: 6 * 3600, outagesPerHour: 0.4, obstructed: 0.004, p95: 62, drop: 0.006, downBps: 120e6, firstDaysAgo: 12 }],
    ["Home", { coveredS: 41 * 3600, outagesPerHour: 0.3, obstructed: 0.002, p95: 55, drop: 0.004, downBps: 150e6, firstDaysAgo: 9 }],
    ["Campsite", { coveredS: 7 * 3600, outagesPerHour: 2.6, obstructed: 0.061, p95: 88, drop: 0.031, downBps: 70e6, firstDaysAgo: 3 }],
    ["Harbour", { coveredS: 35 * 60, outagesPerHour: 1, obstructed: 0.01, p95: 70, drop: 0.01, downBps: 90e6, firstDaysAgo: 1 }],
  ]);

  /** Makes sure the active tag exists and grows while the app runs. */
  touch(active: string | null): void {
    const name = active ?? "";
    const s = this.seeds.get(name);
    if (s) s.coveredS += 3;
    else this.seeds.set(name, { coveredS: 60, outagesPerHour: 0.5, obstructed: 0.005, p95: 60, drop: 0.008, downBps: 110e6, firstDaysAgo: 0 });
  }

  stats(): LocationStats[] {
    const now = Date.now();
    return [...this.seeds.entries()].map(([name, s]) => {
      const enough = s.coveredS >= 3600;
      const hours = s.coveredS / 3600;
      const outageCount = Math.round(s.outagesPerHour * hours);
      return {
        name,
        firstSeenMs: now - s.firstDaysAgo * DAY,
        lastSeenMs: now - (name === "Home" ? 0 : DAY),
        coveredS: s.coveredS,
        outageCount,
        outageS: outageCount * 9,
        outagesPerHour: enough ? s.outagesPerHour : null,
        fractionObstructedAvg: enough ? s.obstructed : null,
        latencyAvgMs: enough ? s.p95 * 0.6 : null,
        latencyP95Ms: enough ? s.p95 : null,
        dropRateAvg: enough ? s.drop : null,
        downlinkAvgBps: enough ? s.downBps : null,
      };
    });
  }

  rename(from: string, to: string): void {
    const s = this.seeds.get(from);
    if (!s) return;
    this.seeds.delete(from);
    const existing = this.seeds.get(to);
    if (existing) existing.coveredS += s.coveredS;
    else this.seeds.set(to, s);
  }

  /** Removes the tag; its data counts as untagged. */
  remove(name: string): void {
    const s = this.seeds.get(name);
    if (!s || name === "") return;
    this.seeds.delete(name);
    const u = this.seeds.get("");
    if (u) u.coveredS += s.coveredS;
  }
}

/** Weekday × hour grid with an evening busy period; sparse at night for short windows. */
export function mockTimeOfDay(p: ProfileSpec, days: number): TimeOfDayStats {
  const cells: HourCell[] = [];
  const perCell = Math.round((days / 7) * 60);
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const n = hash(weekday * 24 + hour + days);
      // Short windows: the app wasn't running some nights.
      if (days <= 7 && hour >= 1 && hour <= 5 && n < 0.6) {
        cells.push({ weekday, hour, minutes: 0, latencyAvgMs: null, latencyP95Ms: null, dropRateAvg: null, downlinkAvgBps: null });
        continue;
      }
      const evening = hour >= 19 && hour <= 23 ? 1 : hour >= 17 ? 0.5 : 0;
      const weekend = weekday >= 5 ? 0.35 : 0;
      const sunday = weekday === 6 && hour >= 20 ? 0.4 : 0;
      const morning = hour >= 6 && hour <= 10 && weekday < 5 ? -0.25 : 0;
      const load = Math.max(0, evening + weekend * (hour > 9 ? 1 : 0) + sunday + morning + (n - 0.5) * 0.2);
      cells.push({
        weekday,
        hour,
        minutes: perCell,
        latencyAvgMs: p.latencyMs * (1 + load * 0.5),
        latencyP95Ms: p.latencyMs * (1.5 + load * 1.1),
        dropRateAvg: Math.max(0, p.dropRate * (0.6 + load * 1.8)),
        downlinkAvgBps: (p.downBps / 4) * Math.max(0.2, 1.1 - load * 0.55),
      });
    }
  }
  return { days, cells };
}

export function mockEnergy(p: ProfileSpec, days: number): DailyEnergy[] {
  if (p.powerW === null) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: DailyEnergy[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = today.getTime() - i * DAY;
    const n = hash(dayMs / DAY);
    // Today is partial; a few older days have gaps (app closed).
    const coveredS = i === 0 ? ((Date.now() - dayMs) / 1000) : n < 0.15 ? 12 * 3600 : 86_400;
    const avgW = p.powerW * (0.9 + n * 0.2);
    out.push({ dayMs, wh: (avgW * coveredS) / 3600, avgW, peakW: avgW * (1.35 + n * 0.3), coveredS });
  }
  return out;
}
