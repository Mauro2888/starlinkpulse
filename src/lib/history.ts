import type { DishEvent, HistoryPoint } from "@/types/models";
import { isNum } from "@/lib/format";

const MINUTE = 60_000;

/** One plotted row. Throughput in Mbps, loss in percent; null = no data (line gap). */
export interface ChartRow {
  t: number;
  latAvg: number | null;
  latP95: number | null;
  loss: number | null;
  down: number | null;
  up: number | null;
  power: number | null;
}

function weightedAvg(items: HistoryPoint[], pick: (p: HistoryPoint) => number | null): number | null {
  let sum = 0;
  let w = 0;
  for (const p of items) {
    const v = pick(p);
    if (!isNum(v)) continue;
    const weight = p.samples > 0 ? p.samples : 1;
    sum += v * weight;
    w += weight;
  }
  return w > 0 ? sum / w : null;
}

function maxOf(items: HistoryPoint[], pick: (p: HistoryPoint) => number | null): number | null {
  let m: number | null = null;
  for (const p of items) {
    const v = pick(p);
    if (isNum(v) && (m === null || v > m)) m = v;
  }
  return m;
}

/**
 * Downsamples per-minute points into at most `maxBuckets` fixed time buckets
 * covering [fromMs, toMs]. Averages are sample-weighted, p95 takes the bucket
 * max (conservative). Empty buckets yield null rows so lines show gaps.
 */
export function bucketHistory(points: HistoryPoint[], fromMs: number, toMs: number, maxBuckets = 240): ChartRow[] {
  const span = Math.max(MINUTE, toMs - fromMs);
  const bucketMs = Math.max(MINUTE, Math.ceil(span / maxBuckets / MINUTE) * MINUTE);
  const count = Math.ceil(span / bucketMs);
  const groups: HistoryPoint[][] = Array.from({ length: count }, () => []);
  for (const p of points) {
    if (p.minuteMs < fromMs || p.minuteMs > toMs) continue;
    const idx = Math.min(count - 1, Math.floor((p.minuteMs - fromMs) / bucketMs));
    groups[idx].push(p);
  }
  return groups.map((g, i) => {
    const t = fromMs + i * bucketMs;
    if (g.length === 0) return { t, latAvg: null, latP95: null, loss: null, down: null, up: null, power: null };
    const loss = weightedAvg(g, (p) => p.dropRateAvg);
    const down = weightedAvg(g, (p) => p.downlinkAvgBps);
    const up = weightedAvg(g, (p) => p.uplinkAvgBps);
    return {
      t,
      latAvg: weightedAvg(g, (p) => p.latencyAvgMs),
      latP95: maxOf(g, (p) => p.latencyP95Ms),
      loss: loss === null ? null : loss * 100,
      down: down === null ? null : down / 1e6,
      up: up === null ? null : up / 1e6,
      power: weightedAvg(g, (p) => p.powerAvgW),
    };
  });
}

export interface HistorySummary {
  latencyAvgMs: number | null;
  latencyP95MaxMs: number | null;
  dropRateAvg: number | null;
  downAvgBps: number | null;
  outageCount: number;
  outageTotalMs: number;
  coverage: number;
}

export function summarizeHistory(points: HistoryPoint[], events: DishEvent[], rangeMinutes: number): HistorySummary {
  // get_events returns outages only (a BOOTING outage marks a reboot).
  return {
    latencyAvgMs: weightedAvg(points, (p) => p.latencyAvgMs),
    latencyP95MaxMs: maxOf(points, (p) => p.latencyP95Ms),
    dropRateAvg: weightedAvg(points, (p) => p.dropRateAvg),
    downAvgBps: weightedAvg(points, (p) => p.downlinkAvgBps),
    outageCount: events.length,
    outageTotalMs: events.reduce((s, e) => s + Math.max(0, e.durationMs), 0),
    coverage: rangeMinutes > 0 ? Math.min(1, points.length / rangeMinutes) : 0,
  };
}

const CSV_COLUMNS: (keyof HistoryPoint)[] = [
  "minuteMs",
  "samples",
  "latencyAvgMs",
  "latencyP95Ms",
  "latencyMaxMs",
  "dropRateAvg",
  "downlinkAvgBps",
  "downlinkMaxBps",
  "uplinkAvgBps",
  "uplinkMaxBps",
  "powerAvgW",
  "powerMaxW",
];

/** CSV with an ISO timestamp column first; nulls become empty cells. */
export function historyToCsv(points: HistoryPoint[]): string {
  const header = ["timeUtc", ...CSV_COLUMNS].join(",");
  const rows = points.map((p) =>
    [
      new Date(p.minuteMs).toISOString(),
      ...CSV_COLUMNS.map((c) => {
        const v = p[c];
        return isNum(v as number | null) ? String(Math.round((v as number) * 1000) / 1000) : "";
      }),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}
