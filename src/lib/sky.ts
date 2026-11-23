// Geometry helpers for the obstruction map and the alignment helper.
//
// ORIENTATION ASSUMPTION (FRAME_EARTH): the obstruction grid is a top-down
// polar projection of the sky. The grid centre is the zenith; distance from
// the centre is the zenith angle (theta), reaching `maxThetaDeg` at the
// inscribed circle's edge. Row 0 is NORTH (up) and column indices grow
// towards EAST (right), so azimuth is measured clockwise from north.
// If a firmware turns out to use another frame, only `cellToSky`/`skyToCell`
// need to change.

import type { AlignmentStats, ObstructionMap } from "@/types/models";
import { fmtNum, isNum } from "@/lib/format";
import { tr as t } from "@/i18n";
import { tk } from "@/i18n/keys";

export const DEFAULT_MAX_THETA_DEG = 80;
/** SNR below this counts as an obstructed cell in the summary. */
export const OBSTRUCTED_SNR = 0.35;

export interface SkyPoint {
  /** Zenith angle, 0 = straight up. */
  thetaDeg: number;
  elevationDeg: number;
  /** 0 = north, 90 = east, clockwise. */
  azimuthDeg: number;
}

function geometry(map: Pick<ObstructionMap, "rows" | "cols" | "maxThetaDeg">) {
  const cx = (map.cols - 1) / 2;
  const cy = (map.rows - 1) / 2;
  const radius = Math.min(map.rows, map.cols) / 2;
  const maxTheta = isNum(map.maxThetaDeg) && map.maxThetaDeg > 0 ? map.maxThetaDeg : DEFAULT_MAX_THETA_DEG;
  return { cx, cy, radius, maxTheta };
}

export function normalizeAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Sky position of a grid cell, or null outside the plotted circle. */
export function cellToSky(
  row: number,
  col: number,
  map: Pick<ObstructionMap, "rows" | "cols" | "maxThetaDeg">,
): SkyPoint | null {
  const { cx, cy, radius, maxTheta } = geometry(map);
  const dx = col - cx; // + east
  const dy = cy - row; // + north
  const dist = Math.hypot(dx, dy);
  if (dist > radius) return null;
  const thetaDeg = (dist / radius) * maxTheta;
  const azimuthDeg = dist === 0 ? 0 : normalizeAzimuth((Math.atan2(dx, dy) * 180) / Math.PI);
  return { thetaDeg, elevationDeg: 90 - thetaDeg, azimuthDeg };
}

/** Nearest grid cell for an azimuth / elevation (inverse of `cellToSky`). */
export function skyToCell(
  azimuthDeg: number,
  elevationDeg: number,
  map: Pick<ObstructionMap, "rows" | "cols" | "maxThetaDeg">,
): { row: number; col: number } {
  const { cx, cy, radius, maxTheta } = geometry(map);
  const dist = ((90 - elevationDeg) / maxTheta) * radius;
  const a = (azimuthDeg * Math.PI) / 180;
  return { row: Math.round(cy - dist * Math.cos(a)), col: Math.round(cx + dist * Math.sin(a)) };
}

/** Row-major index of a cell. */
export function cellIndex(row: number, col: number, cols: number): number {
  return row * cols + col;
}

const POINTS = [tk("N"), tk("NE"), tk("E"), tk("SE"), tk("S"), tk("SW"), tk("W"), tk("NW")] as const;
const POINT_NAMES: Record<(typeof POINTS)[number], string> = {
  N: tk("north"),
  NE: tk("north-east"),
  E: tk("east"),
  SE: tk("south-east"),
  S: tk("south"),
  SW: tk("south-west"),
  W: tk("west"),
  NW: tk("north-west"),
};

export function compassPoint(azimuthDeg: number): (typeof POINTS)[number] {
  return POINTS[Math.round(normalizeAzimuth(azimuthDeg) / 45) % 8];
}

export function compassName(azimuthDeg: number): string {
  return t(POINT_NAMES[compassPoint(azimuthDeg)]);
}

export interface MapSummary {
  /** Cells inside the plotted circle. */
  skyCells: number;
  /** Share of the plotted sky that has measurements. */
  coverage: number;
  /** Share of measured cells below `OBSTRUCTED_SNR`. */
  obstructedFraction: number | null;
  /** Compass direction holding most obstructed cells, if any. */
  worstDirection: string | null;
  /** Average elevation of obstructed cells (degrees above horizon). */
  worstElevationDeg: number | null;
}

export function summarizeObstructionMap(map: ObstructionMap): MapSummary {
  let skyCells = 0;
  let measured = 0;
  let obstructed = 0;
  let elevSum = 0;
  const sectors = new Array<number>(8).fill(0);
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const p = cellToSky(r, c, map);
      if (!p) continue;
      skyCells++;
      const v = map.snr[cellIndex(r, c, map.cols)];
      if (!isNum(v)) continue;
      measured++;
      if (v < OBSTRUCTED_SNR) {
        obstructed++;
        elevSum += p.elevationDeg;
        sectors[Math.round(p.azimuthDeg / 45) % 8]++;
      }
    }
  }
  const worst = obstructed > 0 ? sectors.indexOf(Math.max(...sectors)) : -1;
  return {
    skyCells,
    coverage: skyCells ? measured / skyCells : 0,
    obstructedFraction: measured ? obstructed / measured : null,
    worstDirection: worst >= 0 ? t(POINT_NAMES[POINTS[worst]]) : null,
    worstElevationDeg: obstructed ? elevSum / obstructed : null,
  };
}

// ---- Alignment -----------------------------------------------------------

export const AZ_TOLERANCE_DEG = 2;
export const EL_TOLERANCE_DEG = 1;

/** Signed shortest rotation from `from` to `to`, in (-180, 180]. Positive = clockwise. */
export function azimuthDelta(from: number, to: number): number {
  const d = normalizeAzimuth(to - from);
  return d > 180 ? d - 360 : d;
}

export interface AxisGuidance {
  delta: number;
  ok: boolean;
  text: string;
}

export interface AlignmentGuidance {
  azimuth: AxisGuidance;
  elevation: AxisGuidance | null;
  aligned: boolean;
  uncertaintyDeg: number | null;
}

function deg(n: number): string {
  const a = Math.abs(n);
  return `${a >= 10 ? fmtNum(Math.round(a), 0) : fmtNum(a, 1)}°`;
}

/** Plain-language guidance; null when the dish doesn't report enough alignment data. */
export function alignmentGuidance(a: AlignmentStats): AlignmentGuidance | null {
  if (!isNum(a.azimuthDeg) || !isNum(a.desiredAzimuthDeg)) return null;
  const dAz = azimuthDelta(a.azimuthDeg, a.desiredAzimuthDeg);
  const azOk = Math.abs(dAz) <= AZ_TOLERANCE_DEG;
  const target = normalizeAzimuth(a.desiredAzimuthDeg);
  const azimuth: AxisGuidance = {
    delta: dAz,
    ok: azOk,
    text: azOk
      ? t("Direction is good")
      : dAz > 0
        ? t("Rotate {{deg}} clockwise, seen from above, to face {{target}}° {{point}}", {
            deg: deg(dAz),
            target: Math.round(target),
            point: t(compassPoint(target)),
          })
        : t("Rotate {{deg}} counter-clockwise, seen from above, to face {{target}}° {{point}}", {
            deg: deg(dAz),
            target: Math.round(target),
            point: t(compassPoint(target)),
          }),
  };

  let elevation: AxisGuidance | null = null;
  if (isNum(a.elevationDeg) && isNum(a.desiredElevationDeg)) {
    const dEl = a.desiredElevationDeg - a.elevationDeg;
    const elOk = Math.abs(dEl) <= EL_TOLERANCE_DEG;
    elevation = {
      delta: dEl,
      ok: elOk,
      text: elOk
        ? t("Tilt is good")
        : dEl > 0
          ? t("Tilt {{deg}} up", { deg: deg(dEl) })
          : t("Tilt {{deg}} down", { deg: deg(dEl) }),
    };
  }

  return {
    azimuth,
    elevation,
    aligned: azOk && (elevation?.ok ?? true),
    uncertaintyDeg: isNum(a.uncertaintyDeg) ? a.uncertaintyDeg : null,
  };
}
