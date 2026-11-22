import { describe, expect, it } from "vitest";
import { clampTilt, MAX_TILT, project, skyToVec, viewBasis } from "@/lib/dome";
import { resolveSkyMode } from "@/lib/view-pref";

const b = (yawDeg: number, tiltDeg: number, distance = 3) => viewBasis({ yawDeg, tiltDeg, distance });

describe("dome projection", () => {
  it("maps the zenith to the centre when looking straight down, for any yaw", () => {
    for (const yaw of [0, 45, 133, 270]) {
      const p = project(skyToVec(0, 90), b(yaw, 0));
      expect(p.sx).toBeCloseTo(0);
      expect(p.sy).toBeCloseTo(0);
    }
  });

  it("puts horizon north at the top and east on the right at yaw 0 (same as the 2D map)", () => {
    const n = project(skyToVec(0, 0), b(0, 0));
    expect(n.sx).toBeCloseTo(0);
    expect(n.sy).toBeLessThan(0); // canvas y grows downwards
    const e = project(skyToVec(90, 0), b(0, 0));
    expect(e.sx).toBeGreaterThan(0);
    expect(e.sy).toBeCloseTo(0);
    // North stays at the top when the camera is tilted.
    const nt = project(skyToVec(0, 0), b(0, 50));
    expect(nt.sx).toBeCloseTo(0);
    expect(nt.sy).toBeLessThan(0);
  });

  it("keeps the horizon a circle under yaw when looking straight down", () => {
    const r = (az: number, yaw: number) => {
      const p = project(skyToVec(az, 0), b(yaw, 0));
      return Math.hypot(p.sx, p.sy);
    };
    for (const yaw of [0, 30, 200]) for (const az of [0, 90, 222]) expect(r(az, yaw)).toBeCloseTo(r(0, 0));
  });

  it("positive yaw turns the dome clockwise seen from above (same as adding azimuth)", () => {
    const a = project(skyToVec(30, 40), b(25, 35));
    const c = project(skyToVec(55, 40), b(0, 35));
    expect(a.sx).toBeCloseTo(c.sx);
    expect(a.sy).toBeCloseTo(c.sy);
    expect(a.depth).toBeCloseTo(c.depth);
  });

  it("brings the south side towards a tilted camera and pushes the north side away", () => {
    const s = project(skyToVec(180, 0), b(0, 60));
    const n = project(skyToVec(0, 0), b(0, 60));
    expect(s.depth).toBeGreaterThan(0);
    expect(n.depth).toBeLessThan(0);
    expect(s.scale).toBeGreaterThan(n.scale); // perspective: nearer looks bigger
  });

  it("clamps tilt", () => {
    expect(clampTilt(-10)).toBe(0);
    expect(clampTilt(500)).toBe(MAX_TILT);
  });
});

describe("sky view mode preference", () => {
  it("defaults to 3D on desktop and 2D in the tray", () => {
    expect(resolveSkyMode(null, true, false)).toBe("3d");
    expect(resolveSkyMode(null, false, false)).toBe("2d");
  });
  it("respects the saved choice", () => {
    expect(resolveSkyMode("2d", true, false)).toBe("2d");
    expect(resolveSkyMode("3d", false, false)).toBe("3d");
  });
  it("forces 2D with reduced motion", () => {
    expect(resolveSkyMode("3d", true, true)).toBe("2d");
  });
});
