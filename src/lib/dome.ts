// Projection math for the 3D "dome" view of the obstruction map.
//
// World frame (same as sky.ts / FRAME_EARTH): x = east, y = north, z = up.
// A sky point at azimuth `az` (clockwise from north) and elevation `el` lies on
// the unit hemisphere at (cos el · sin az, cos el · cos az, sin el).
//
// View: `yawDeg` spins the dome around the vertical axis; `tiltDeg` moves the
// camera from straight above (0°, identical to the 2D map: north up, east
// right) towards the horizon on the south side (90°). A simple perspective
// divide gives depth.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface View {
  yawDeg: number;
  /** 0 = top-down, larger = camera lower towards the horizon. */
  tiltDeg: number;
  /** Camera distance in dome radii (> 1). Larger = flatter perspective. */
  distance: number;
}

export interface Projected {
  /** Screen offsets from the centre in dome radii; +y is DOWN (canvas convention). */
  sx: number;
  sy: number;
  /** Towards the viewer is positive. */
  depth: number;
  /** Perspective scale factor, useful for dot size. */
  scale: number;
}

export const MIN_TILT = 0;
export const MAX_TILT = 75;

const rad = (d: number) => (d * Math.PI) / 180;

export function skyToVec(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = rad(azimuthDeg);
  const el = rad(elevationDeg);
  return { x: Math.cos(el) * Math.sin(az), y: Math.cos(el) * Math.cos(az), z: Math.sin(el) };
}

export function clampTilt(t: number): number {
  return Math.min(MAX_TILT, Math.max(MIN_TILT, t));
}

/** Precomputed trig for a view, so projecting thousands of points stays cheap. */
export function viewBasis(v: View) {
  const yaw = rad(v.yawDeg);
  const tilt = rad(clampTilt(v.tiltDeg));
  return { cy: Math.cos(yaw), sy: Math.sin(yaw), ct: Math.cos(tilt), st: Math.sin(tilt), d: Math.max(1.5, v.distance) };
}

export type Basis = ReturnType<typeof viewBasis>;

export function project(p: Vec3, b: Basis): Projected {
  // Spin around the vertical axis (positive yaw turns the dome clockwise seen from above).
  const x = p.x * b.cy + p.y * b.sy;
  const y = -p.x * b.sy + p.y * b.cy;
  // Camera on the south side, tilted down towards the dome centre.
  const up = y * b.ct + p.z * b.st;
  const depth = -y * b.st + p.z * b.ct;
  const scale = b.d / (b.d - depth);
  return { sx: x * scale, sy: -up * scale, depth, scale };
}
