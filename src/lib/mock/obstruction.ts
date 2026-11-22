// Synthetic obstruction maps for the in-browser mock (dev only).

import type { MockProfile, ObstructionMap } from "@/types/models";
import { azimuthDelta, cellIndex, cellToSky } from "@/lib/sky";

const SIZE = 123;

interface Blob {
  azimuthDeg: number;
  elevationDeg: number;
  /** Angular half-widths. */
  azSpread: number;
  elSpread: number;
  depth: number;
}

function hash(n: number): number {
  const x = Math.sin(n * 91.345 + 47.853) * 43758.5453;
  return x - Math.floor(x);
}

const BLOBS: Partial<Record<MockProfile, Blob[]>> = {
  // A tree low in the south-west plus a roof edge to the north.
  obstructed: [
    { azimuthDeg: 225, elevationDeg: 36, azSpread: 30, elSpread: 12, depth: 0.95 },
    { azimuthDeg: 255, elevationDeg: 48, azSpread: 10, elSpread: 7, depth: 0.8 },
    { azimuthDeg: 5, elevationDeg: 31, azSpread: 30, elSpread: 4, depth: 0.7 },
  ],
  standard: [{ azimuthDeg: 70, elevationDeg: 32, azSpread: 7, elSpread: 3, depth: 0.8 }],
  standard_actuated: [{ azimuthDeg: 300, elevationDeg: 31, azSpread: 6, elSpread: 3, depth: 0.8 }],
  mini: [{ azimuthDeg: 140, elevationDeg: 33, azSpread: 12, elSpread: 4, depth: 0.8 }],
  throttled: [],
};

/**
 * Coverage mask made of satellite-track arcs: real maps only fill cells along
 * the paths satellites took, so they look like thin curved lines with gaps.
 * Each track is a quadratic curve between two points on the horizon circle,
 * bent towards (but rarely through) the zenith.
 */
function trackMask(): Uint8Array {
  const mask = new Uint8Array(SIZE * SIZE);
  const c = (SIZE - 1) / 2;
  const R = SIZE / 2 - 0.5;
  const TRACKS = 42;
  for (let t = 0; t < TRACKS; t++) {
    // Most passes run roughly north-south (inclined orbits), with some spread.
    const base = hash(t * 7.1) < 0.5 ? 10 : 190;
    const a1 = ((base + (hash(t * 3.3) - 0.5) * 120) * Math.PI) / 180;
    const a2 = a1 + Math.PI + (hash(t * 5.9) - 0.5) * 1.6;
    const p1 = [c + R * Math.sin(a1), c - R * Math.cos(a1)];
    const p2 = [c + R * Math.sin(a2), c - R * Math.cos(a2)];
    // Control point: offset from the centre, so arcs pass at varied distances from zenith.
    const off = (hash(t * 9.7) - 0.5) * R * 2.2;
    const mid = (a1 + a2) / 2;
    const ctrl = [c + off * Math.cos(mid), c + off * Math.sin(mid)];
    const steps = 260;
    let gapUntil = -1;
    for (let k = 0; k <= steps; k++) {
      // Random gaps along the track (no ping data for a while).
      if (k > gapUntil && hash(t * 131 + k) < 0.012) gapUntil = k + 6 + Math.floor(hash(t + k) * 18);
      if (k <= gapUntil) continue;
      const u = k / steps;
      const x = (1 - u) * (1 - u) * p1[0] + 2 * (1 - u) * u * ctrl[0] + u * u * p2[0];
      const y = (1 - u) * (1 - u) * p1[1] + 2 * (1 - u) * u * ctrl[1] + u * u * p2[1];
      for (const [dx, dy] of [[0, 0], [1, 0]]) {
        const col = Math.round(x) + dx;
        const row = Math.round(y) + dy;
        if (row >= 0 && row < SIZE && col >= 0 && col < SIZE) mask[cellIndex(row, col, SIZE)] = 1;
      }
    }
  }
  return mask;
}

let cachedMask: Uint8Array | null = null;

/** Builds a 123x123 row-major SNR grid along satellite tracks, with profile-specific obstructions. */
export function mockObstructionMap(profile: MockProfile): ObstructionMap {
  cachedMask ??= trackMask();
  const mask = cachedMask;
  const blobs = BLOBS[profile] ?? [];
  const meta = { rows: SIZE, cols: SIZE, maxThetaDeg: 80 };
  const snr: (number | null)[] = new Array(SIZE * SIZE).fill(null);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = cellToSky(r, c, meta);
      if (!p) continue;
      const i = cellIndex(r, c, SIZE);
      if (!mask[i]) continue;
      // Real maps concentrate data at 30-70° elevation; keep only a little outside that band.
      if ((p.elevationDeg < 27 || p.elevationDeg > 73) && hash(i + 5) > 0.12) continue;
      let o = 0;
      for (const b of blobs) {
        const da = azimuthDelta(b.azimuthDeg, p.azimuthDeg) / b.azSpread;
        const de = (p.elevationDeg - b.elevationDeg) / b.elSpread;
        const d = da * da + de * de;
        if (d < 1.6) o = Math.max(o, b.depth * Math.exp(-d * 1.4));
      }
      // Real SNR is almost always exactly 0 (blocked) or 1 (clear), with few values in between.
      const h = hash(i + 29);
      snr[i] = o > 0.4 ? (h < 0.88 ? 0 : 0.45) : h < 0.97 ? 1 : 0.8;
    }
  }
  return { rows: SIZE, cols: SIZE, minElevationDeg: 10, maxThetaDeg: 80, referenceFrame: "FRAME_EARTH", snr };
}
