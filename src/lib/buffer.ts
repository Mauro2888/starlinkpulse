import type { TelemetrySnapshot } from "@/types/models";

/** Rolling window kept for sparklines. */
export const LIVE_WINDOW_MS = 5 * 60_000;
const MAX_POINTS = 400;

/**
 * Appends a snapshot to the rolling buffer: ignores duplicates/out-of-order
 * samples and drops anything older than `windowMs` relative to the newest.
 */
export function appendSnapshot(
  buffer: readonly TelemetrySnapshot[],
  snap: TelemetrySnapshot,
  windowMs = LIVE_WINDOW_MS,
): TelemetrySnapshot[] {
  const last = buffer[buffer.length - 1];
  if (last && snap.timestampMs <= last.timestampMs) return buffer as TelemetrySnapshot[];
  const cutoff = snap.timestampMs - windowMs;
  const kept = buffer.filter((s) => s.timestampMs >= cutoff);
  kept.push(snap);
  return kept.length > MAX_POINTS ? kept.slice(kept.length - MAX_POINTS) : kept;
}
