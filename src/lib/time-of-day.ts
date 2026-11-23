// Best/worst times from weekday × hour aggregates.

import type { HourCell } from "@/types/models";
import { formatDate, isNum } from "@/lib/format";

export type TodMetric = "latency" | "drop" | "download";

/** Value plotted for a cell (null when the cell has no data). */
export function cellValue(c: HourCell, m: TodMetric): number | null {
  if (c.minutes <= 0) return null;
  const v = m === "latency" ? c.latencyP95Ms : m === "drop" ? c.dropRateAvg : c.downlinkAvgBps;
  return isNum(v) ? v : null;
}

/** Lower is better for latency and drop rate; higher is better for download. */
export const lowerIsBetter = (m: TodMetric) => m !== "download";

/** 7 × 24 matrix (Monday first) of values. */
export function toMatrix(cells: HourCell[], m: TodMetric): (number | null)[][] {
  const grid: (number | null)[][] = Array.from({ length: 7 }, () => new Array<number | null>(24).fill(null));
  for (const c of cells) {
    if (c.weekday >= 0 && c.weekday < 7 && c.hour >= 0 && c.hour < 24) grid[c.weekday][c.hour] = cellValue(c, m);
  }
  return grid;
}

export type DayGroup = "weekdays" | "weekend" | number;

export interface TimeWindow {
  days: DayGroup;
  startHour: number;
  /** Exclusive end hour (e.g. 10 for 06–10). */
  endHour: number;
  value: number;
}

const GROUP_DAYS: Record<"weekdays" | "weekend", number[]> = { weekdays: [0, 1, 2, 3, 4], weekend: [5, 6] };

function windowValue(grid: (number | null)[][], days: number[], start: number, len: number): number | null {
  let sum = 0;
  let n = 0;
  let total = 0;
  for (const d of days) {
    for (let h = start; h < start + len; h++) {
      total++;
      const v = grid[d][h];
      if (v !== null) {
        sum += v;
        n++;
      }
    }
  }
  // Need most of the window covered to make a claim.
  return n >= total * 0.75 ? sum / n : null;
}

/**
 * Best = 4-hour window over weekdays or weekend with the best average.
 * Worst = 3-hour window on a single day with the worst average.
 */
export function bestAndWorst(
  cells: HourCell[],
  m: TodMetric,
): { best: TimeWindow | null; worst: TimeWindow | null } {
  const grid = toMatrix(cells, m);
  const better = (a: number, b: number) => (lowerIsBetter(m) ? a < b : a > b);
  let best: TimeWindow | null = null;
  for (const g of ["weekdays", "weekend"] as const) {
    for (let s = 0; s + 4 <= 24; s++) {
      const v = windowValue(grid, GROUP_DAYS[g], s, 4);
      if (v !== null && (!best || better(v, best.value))) best = { days: g, startHour: s, endHour: s + 4, value: v };
    }
  }
  let worst: TimeWindow | null = null;
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s + 3 <= 24; s++) {
      const v = windowValue(grid, [d], s, 3);
      if (v !== null && (!worst || better(worst.value, v))) worst = { days: d, startHour: s, endHour: s + 3, value: v };
    }
  }
  return { best, worst };
}

/** Localized short weekday name, Monday = 0. */
export function weekdayName(i: number, style: "short" | "long" = "short"): string {
  // 1 Jan 2024 was a Monday.
  return formatDate(new Date(2024, 0, 1 + i).getTime(), { weekday: style });
}

export const pad2 = (h: number) => String(h).padStart(2, "0");
