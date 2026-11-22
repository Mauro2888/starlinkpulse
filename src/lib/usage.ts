import type { DataUsage, UptimeWindow } from "@/types/models";
import { EM_DASH, isNum } from "@/lib/format";

const GB = 1e9;

/** Decimal units, as ISPs use: "812 MB", "14.2 GB", "1.31 TB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isNum(bytes) || bytes < 0) return EM_DASH;
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${Math.round(bytes)} B`;
}

export type CapState = "none" | "ok" | "warning" | "over";

export interface CycleProgress {
  totalBytes: number;
  capBytes: number | null;
  /** 0..n share of the cap used; null without a cap. */
  fraction: number | null;
  state: CapState;
}

/** Cycle total vs cap: warning from 80 %, over at 100 %. */
export function cycleProgress(u: Pick<DataUsage, "cycleDownloadBytes" | "cycleUploadBytes" | "capGb">): CycleProgress {
  const totalBytes = Math.max(0, u.cycleDownloadBytes) + Math.max(0, u.cycleUploadBytes);
  if (!isNum(u.capGb) || u.capGb <= 0) return { totalBytes, capBytes: null, fraction: null, state: "none" };
  const capBytes = u.capGb * GB;
  const fraction = totalBytes / capBytes;
  return { totalBytes, capBytes, fraction, state: fraction >= 1 ? "over" : fraction >= 0.8 ? "warning" : "ok" };
}

export interface UsageBar {
  dayMs: number;
  /** GB */
  down: number;
  up: number;
}

/** Days of the current cycle (newest last), in GB for plotting. */
export function cycleBars(u: DataUsage): UsageBar[] {
  return u.daily
    .filter((d) => d.dayMs >= u.cycleStartMs)
    .sort((a, b) => a.dayMs - b.dayMs)
    .map((d) => ({ dayMs: d.dayMs, down: d.downloadBytes / GB, up: d.uploadBytes / GB }));
}

/** Uptime percentage text; null means not enough data in that window. */
export function formatUptime(w: Pick<UptimeWindow, "uptimePct">): string {
  if (!isNum(w.uptimePct)) return EM_DASH;
  const p = Math.min(100, Math.max(0, w.uptimePct));
  if (p >= 99.995) return "100 %";
  return `${p >= 99 ? p.toFixed(2) : p.toFixed(1)} %`;
}

/** Start of the billing cycle containing `now` for a reset day 1-28 (local time). */
export function cycleStart(now: Date, resetDay: number): Date {
  const day = Math.min(28, Math.max(1, Math.round(resetDay)));
  const start = new Date(now.getFullYear(), now.getMonth(), day);
  if (start > now) start.setMonth(start.getMonth() - 1);
  return start;
}
