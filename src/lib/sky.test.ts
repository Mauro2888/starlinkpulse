import { describe, expect, it } from "vitest";
import type { ObstructionMap } from "@/types/models";
import {
  alignmentGuidance,
  azimuthDelta,
  cellIndex,
  cellToSky,
  compassPoint,
  skyToCell,
  summarizeObstructionMap,
} from "@/lib/sky";
import { mockObstructionMap } from "@/lib/mock/obstruction";
import { describeMap, isEarthFrame, snrColor } from "@/components/sky/obstruction-map";

const geo = { rows: 123, cols: 123, maxThetaDeg: 80 };

describe("obstruction map indexing", () => {
  it("maps the centre to the zenith", () => {
    const p = cellToSky(61, 61, geo)!;
    expect(p.thetaDeg).toBe(0);
    expect(p.elevationDeg).toBe(90);
  });

  it("puts north up and east right", () => {
    expect(cellToSky(5, 61, geo)!.azimuthDeg).toBeCloseTo(0);
    expect(cellToSky(61, 117, geo)!.azimuthDeg).toBeCloseTo(90);
    expect(cellToSky(117, 61, geo)!.azimuthDeg).toBeCloseTo(180);
    expect(cellToSky(61, 5, geo)!.azimuthDeg).toBeCloseTo(270);
  });

  it("returns null outside the plotted circle (corners)", () => {
    expect(cellToSky(0, 0, geo)).toBeNull();
  });

  it("round-trips sky positions through the grid", () => {
    for (const [az, el] of [[225, 24], [10, 60], [90, 15]]) {
      const { row, col } = skyToCell(az, el, geo);
      const p = cellToSky(row, col, geo)!;
      expect(Math.abs(azimuthDelta(az, p.azimuthDeg))).toBeLessThan(3);
      expect(Math.abs(p.elevationDeg - el)).toBeLessThan(2);
    }
  });

  it("uses row-major indices", () => {
    expect(cellIndex(2, 3, 10)).toBe(23);
  });

  it("summarizes coverage and obstruction on a tiny grid", () => {
    // 5x5 grid: centre clear, north edge obstructed, rest no data. Corners fall outside the circle.
    const snr: (number | null)[] = new Array(25).fill(null);
    snr[cellIndex(2, 2, 5)] = 1;
    snr[cellIndex(0, 2, 5)] = 0.1;
    const map: ObstructionMap = { rows: 5, cols: 5, minElevationDeg: 10, maxThetaDeg: 80, referenceFrame: "FRAME_EARTH", snr };
    const s = summarizeObstructionMap(map);
    expect(s.skyCells).toBe(21);
    expect(s.coverage).toBeCloseTo(2 / 21);
    expect(s.obstructedFraction).toBeCloseTo(0.5);
    expect(s.worstDirection).toBe("north");
  });

  it("finds the mock tree in the south-west for the obstructed profile", () => {
    const s = summarizeObstructionMap(mockObstructionMap("obstructed"));
    expect(s.worstDirection).toBe("south-west");
    expect(s.obstructedFraction!).toBeGreaterThan(0.02);
    expect(summarizeObstructionMap(mockObstructionMap("throttled")).obstructedFraction).toBe(0);
  });
});

describe("alignment guidance", () => {
  const base = { tiltAngleDeg: null, uncertaintyDeg: 0.9 };

  it("wraps azimuth deltas across north", () => {
    expect(azimuthDelta(350, 10)).toBe(20);
    expect(azimuthDelta(10, 350)).toBe(-20);
    expect(azimuthDelta(0, 180)).toBe(180);
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(225)).toBe("SW");
  });

  it("gives plain directions outside tolerance", () => {
    const g = alignmentGuidance({ ...base, azimuthDeg: 166.8, desiredAzimuthDeg: 178, elevationDeg: 64, desiredElevationDeg: 66 })!;
    expect(g.aligned).toBe(false);
    expect(g.azimuth.delta).toBeCloseTo(11.2);
    expect(g.azimuth.text).toBe("Rotate 11° clockwise, seen from above, to face 178° S");
    expect(g.elevation!.text).toBe("Tilt 2° up");
    expect(g.uncertaintyDeg).toBe(0.9);
  });

  it("says counter-clockwise and down when needed", () => {
    const g = alignmentGuidance({ ...base, azimuthDeg: 5, desiredAzimuthDeg: 355, elevationDeg: 70, desiredElevationDeg: 66.5 })!;
    expect(g.azimuth.text).toMatch(/^Rotate 10° counter-clockwise/);
    expect(g.elevation!.text).toBe("Tilt 3.5° down");
  });

  it("is OK within ±2° azimuth and ±1° elevation", () => {
    const g = alignmentGuidance({ ...base, azimuthDeg: 179.1, desiredAzimuthDeg: 178, elevationDeg: 65.6, desiredElevationDeg: 66 })!;
    expect(g.aligned).toBe(true);
    expect(g.azimuth.ok && g.elevation!.ok).toBe(true);
  });

  it("returns null without azimuth data and skips elevation when missing", () => {
    expect(alignmentGuidance({ ...base, azimuthDeg: null, desiredAzimuthDeg: 178, elevationDeg: 1, desiredElevationDeg: 2 })).toBeNull();
    expect(alignmentGuidance({ ...base, azimuthDeg: 1, desiredAzimuthDeg: 2, elevationDeg: null, desiredElevationDeg: 2 })!.elevation).toBeNull();
  });
});

describe("map reference frame and colours", () => {
  it("only uses compass directions in the earth frame", () => {
    expect(isEarthFrame("FRAME_EARTH")).toBe(true);
    expect(isEarthFrame(null)).toBe(true);
    expect(isEarthFrame("FRAME_UT")).toBe(false);
    const s = summarizeObstructionMap(mockObstructionMap("obstructed"));
    expect(describeMap(s, true)).toMatch(/towards the south-west/);
    expect(describeMap(s, false)).not.toMatch(/towards/);
  });

  it("keeps clear sky cool and translucent and obstruction warm and opaque", () => {
    const [r, , b, a] = snrColor(1);
    expect(b).toBeGreaterThan(r); // cool
    expect(a).toBeLessThan(255);
    const [r2, , b2, a2] = snrColor(0);
    expect(r2).toBeGreaterThan(b2); // warm
    expect(a2).toBe(255);
  });

  it("draws the mock as thin tracks with gaps, not full coverage", () => {
    const s = summarizeObstructionMap(mockObstructionMap("standard"));
    expect(s.coverage).toBeGreaterThan(0.2);
    expect(s.coverage).toBeLessThan(0.85);
  });
});
