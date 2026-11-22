// Guided alignment state machine (pure, testable). Fed one telemetry sample at a time.

import type { AlignmentStats } from "@/types/models";
import { AZ_TOLERANCE_DEG, EL_TOLERANCE_DEG, azimuthDelta, normalizeAzimuth } from "@/lib/sky";
import { isNum } from "@/lib/format";

export const UNCERTAINTY_LIMIT_DEG = 1.5;
export const JUMP_LIMIT_DEG = 3;
export const JUMP_WINDOW_MS = 2_000;
export const HOLD_TO_FINISH_MS = 10_000;

export interface AlignSample {
  t: number;
  az: number;
  el: number | null;
  desiredAz: number;
  desiredEl: number | null;
  uncertainty: number | null;
  estimation: string | null;
}

export type HoldReason = "uncertain" | "estimating" | "moving";

export type GuidePhase =
  | { kind: "waiting" }
  | { kind: "hold"; reason: HoldReason }
  | { kind: "direction"; deltaDeg: number }
  | { kind: "tilt"; deltaDeg: number }
  | { kind: "holding"; sinceMs: number; remainingMs: number }
  | { kind: "done" };

export interface GuideState {
  samples: AlignSample[];
  start: { az: number; el: number | null } | null;
  inToleranceSince: number | null;
  done: boolean;
  phase: GuidePhase;
}

export const initialGuide = (): GuideState => ({
  samples: [],
  start: null,
  inToleranceSince: null,
  done: false,
  phase: { kind: "waiting" },
});

export function toSample(a: AlignmentStats, t: number): AlignSample | null {
  if (!isNum(a.azimuthDeg) || !isNum(a.desiredAzimuthDeg)) return null;
  return {
    t,
    az: normalizeAzimuth(a.azimuthDeg),
    el: isNum(a.elevationDeg) ? a.elevationDeg : null,
    desiredAz: normalizeAzimuth(a.desiredAzimuthDeg),
    desiredEl: isNum(a.desiredElevationDeg) ? a.desiredElevationDeg : null,
    uncertainty: isNum(a.uncertaintyDeg) ? a.uncertaintyDeg : null,
    estimation: a.estimationState,
  };
}

/**
 * Only "FILTER_CONVERGED" is confirmed on real dishes; any other reported state
 * (e.g. "FILTER_CONVERGING") means the estimate isn't settled. A missing state
 * (null) doesn't block: the uncertainty and jump checks decide instead, so
 * firmware that never reports it isn't stuck on "Hold still".
 */
export function isConverged(state: string | null): boolean {
  return state === null || state === "FILTER_CONVERGED";
}

/** Largest change in azimuth or elevation between the newest sample and others in the last 2 s. */
export function recentJump(samples: AlignSample[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let max = 0;
  for (const s of samples) {
    if (last.t - s.t > JUMP_WINDOW_MS || s === last) continue;
    max = Math.max(max, Math.abs(azimuthDelta(s.az, last.az)));
    if (s.el !== null && last.el !== null) max = Math.max(max, Math.abs(last.el - s.el));
  }
  return max;
}

export function holdReason(samples: AlignSample[]): HoldReason | null {
  const last = samples[samples.length - 1];
  if (!last) return null;
  if (!isConverged(last.estimation)) return "estimating";
  if (last.uncertainty !== null && last.uncertainty > UNCERTAINTY_LIMIT_DEG) return "uncertain";
  if (recentJump(samples) > JUMP_LIMIT_DEG) return "moving";
  return null;
}

/** Feeds one sample. Direction first, then tilt; done after 10 s within tolerance. Done is sticky. */
export function stepGuide(prev: GuideState, sample: AlignSample | null): GuideState {
  if (prev.done || !sample) return prev;
  const samples = [...prev.samples.filter((s) => sample.t - s.t <= JUMP_WINDOW_MS * 2), sample];
  const start = prev.start ?? { az: sample.az, el: sample.el };
  const dAz = azimuthDelta(sample.az, sample.desiredAz);
  const dEl = sample.el !== null && sample.desiredEl !== null ? sample.desiredEl - sample.el : 0;
  const azOk = Math.abs(dAz) <= AZ_TOLERANCE_DEG;
  const elOk = Math.abs(dEl) <= EL_TOLERANCE_DEG;
  const hold = holdReason(samples);

  if (hold) {
    // Shaky readings: no directions, and the 10 s countdown starts over.
    return { samples, start, inToleranceSince: null, done: false, phase: { kind: "hold", reason: hold } };
  }
  if (!azOk) {
    return { samples, start, inToleranceSince: null, done: false, phase: { kind: "direction", deltaDeg: dAz } };
  }
  if (!elOk) {
    return { samples, start, inToleranceSince: null, done: false, phase: { kind: "tilt", deltaDeg: dEl } };
  }
  const since = prev.inToleranceSince ?? sample.t;
  const held = sample.t - since;
  if (held >= HOLD_TO_FINISH_MS) {
    return { samples, start, inToleranceSince: since, done: true, phase: { kind: "done" } };
  }
  return {
    samples,
    start,
    inToleranceSince: since,
    done: false,
    phase: { kind: "holding", sinceMs: since, remainingMs: HOLD_TO_FINISH_MS - held },
  };
}

/** 0 (far) .. 1 (on target) closeness for audio pacing; null when no guidance applies. */
export function closeness(phase: GuidePhase): number | null {
  if (phase.kind === "direction") return 1 - Math.min(1, Math.abs(phase.deltaDeg) / 45);
  if (phase.kind === "tilt") return 1 - Math.min(1, Math.abs(phase.deltaDeg) / 15);
  if (phase.kind === "holding" || phase.kind === "done") return 1;
  return null;
}

/** Milliseconds between beeps: slow when far, fast when close. */
export function beepIntervalMs(close: number): number {
  return Math.round(900 - 750 * Math.min(1, Math.max(0, close)));
}
