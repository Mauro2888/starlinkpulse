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
    { azimuthDeg: 225, elevationDeg: 24, azSpread: 28, elSpread: 14, depth: 0.95 },
    { azimuthDeg: 250, elevationDeg: 38, azSpread: 10, elSpread: 8, depth: 0.7 },
    { azimuthDeg: 5, elevationDeg: 14, azSpread: 35, elSpread: 5, depth: 0.6 },
  ],
  standard: [{ azimuthDeg: 70, elevationDeg: 13, azSpread: 8, elSpread: 3, depth: 0.6 }],
  standard_actuated: [{ azimuthDeg: 300, elevationDeg: 12, azSpread: 6, elSpread: 3, depth: 0.5 }],
  mini: [{ azimuthDeg: 140, elevationDeg: 16, azSpread: 12, elSpread: 4, depth: 0.55 }],
  throttled: [],
};

/**
 * Builds a 123x123 row-major SNR grid. Coverage is patchy like real maps:
 * cells are only filled where satellite tracks passed (arcs + noise).
 */
export function mockObstructionMap(profile: MockProfile): ObstructionMap {
  const blobs = BLOBS[profile] ?? [];
  const meta = { rows: SIZE, cols: SIZE, maxThetaDeg: 80 };
  const snr: (number | null)[] = new Array(SIZE * SIZE).fill(null);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const p = cellToSky(r, c, meta);
      if (!p) continue;
      const i = cellIndex(r, c, SIZE);
      // Satellite tracks: diagonal bands + random speckle, denser near the zenith.
      const band = Math.sin((p.azimuthDeg / 360) * Math.PI * 14 + p.thetaDeg / 9) > -0.35;
      const covered = band ? hash(i) < 0.92 : hash(i + 3) < 0.25;
      if (!covered) continue;
      let v = 0.82 + hash(i + 11) * 0.18;
      for (const b of blobs) {
        const da = azimuthDelta(b.azimuthDeg, p.azimuthDeg) / b.azSpread;
        const de = (p.elevationDeg - b.elevationDeg) / b.elSpread;
        const d = da * da + de * de;
        if (d < 1.6) v -= b.depth * Math.exp(-d * 1.4) * (0.85 + hash(i + 29) * 0.3);
      }
      snr[i] = Math.max(0, Math.min(1, v));
    }
  }
  return { rows: SIZE, cols: SIZE, minElevationDeg: 10, maxThetaDeg: 80, referenceFrame: "FRAME_EARTH", snr };
}
