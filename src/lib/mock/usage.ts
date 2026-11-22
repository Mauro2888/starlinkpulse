// Synthetic uptime and data usage for the in-browser mock (dev only).

import type { DataUsage, DishEvent, Settings, UptimeStats } from "@/types/models";
import { cycleStart } from "@/lib/usage";
import type { ProfileSpec } from "@/lib/mock/profiles";

const DAY = 86_400_000;

function hash(n: number): number {
  const x = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

/** The mock pretends the app has run ~30 h, so 7d / 30d have partial coverage. */
export function mockUptime(p: ProfileSpec, events24h: DishEvent[], coveredS: number): UptimeStats {
  const windows: [string, number][] = [
    ["24h", 86_400],
    ["7d", 7 * 86_400],
    ["30d", 30 * 86_400],
  ];
  const outageS = events24h.reduce((s, e) => s + e.durationMs / 1000, 0);
  return {
    windows: windows.map(([label, windowS]) => {
      const covered = Math.min(windowS, coveredS);
      const scale = covered / 86_400;
      const out = outageS * Math.max(1, scale);
      const count = Math.round(events24h.length * Math.max(1, scale));
      return {
        label,
        windowS,
        coveredS: covered,
        // Under 10 % coverage the percentage is not meaningful.
        uptimePct: p.offline || covered / windowS < 0.1 ? null : 100 * (1 - out / covered),
        outageCount: count,
        outageS: out,
      };
    }),
  };
}

export function mockUsage(p: ProfileSpec, settings: Settings, days: number): DataUsage {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = cycleStart(new Date(), settings.billingCycleDay);
  const daily = [];
  // Mean throughput of the profile -> rough bytes/day, with weekly rhythm and noise.
  const baseDown = (p.downBps / 6) * 0.014 * 86_400 / 8;
  const baseUp = (p.upBps / 5) * 0.014 * 86_400 / 8;
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = today.getTime() - i * DAY;
    if (p.offline) continue;
    const dow = new Date(dayMs).getDay();
    const weekend = dow === 0 || dow === 6 ? 1.5 : 1;
    const n = 0.5 + hash(dayMs / DAY);
    daily.push({ dayMs, downloadBytes: Math.round(baseDown * weekend * n), uploadBytes: Math.round(baseUp * weekend * n) });
  }
  const inCycle = daily.filter((d) => d.dayMs >= start.getTime());
  return {
    daily,
    cycleStartMs: start.getTime(),
    cycleDownloadBytes: inCycle.reduce((s, d) => s + d.downloadBytes, 0),
    cycleUploadBytes: inCycle.reduce((s, d) => s + d.uploadBytes, 0),
    capGb: settings.dataCapGb,
    isEstimate: true,
  };
}
