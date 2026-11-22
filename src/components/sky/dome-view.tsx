import { useEffect, useMemo, useRef } from "react";
import type { ObstructionMap } from "@/types/models";
import { cellIndex, cellToSky } from "@/lib/sky";
import { clampTilt, project, skyToVec, viewBasis, type Basis, type View } from "@/lib/dome";
import { isNum } from "@/lib/format";
import { snrColor } from "@/components/sky/sky-colors";

interface Props {
  map: ObstructionMap;
  /** Compass labels only in the earth frame. */
  earthFrame: boolean;
  /** Accessible summary (same text as the 2D view). */
  label: string;
  /** Disable idle auto-rotation (reduced motion). */
  still?: boolean;
}

const BUCKETS = 101;
const NO_DATA = BUCKETS; // extra bucket index
const AUTO_DEG_PER_S = 5;
const IDLE_MS = 3000;
const INITIAL: View = { yawDeg: 0, tiltDeg: 50, distance: 3.2 };

interface Cloud {
  xyz: Float32Array;
  bucket: Uint8Array;
  count: number;
}

/** One point per cell: measured cells coloured by SNR, a sparse grid of faint dots where there's no data. */
function buildCloud(map: ObstructionMap): Cloud {
  const n = map.rows * map.cols;
  const xyz = new Float32Array(n * 3);
  const bucket = new Uint8Array(n);
  let count = 0;
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const p = cellToSky(r, c, map);
      if (!p) continue;
      const v = map.snr[cellIndex(r, c, map.cols)];
      const has = isNum(v);
      if (!has && (r % 3 !== 0 || c % 3 !== 0)) continue; // keep "no data" sparse
      const w = skyToVec(p.azimuthDeg, p.elevationDeg);
      xyz[count * 3] = w.x;
      xyz[count * 3 + 1] = w.y;
      xyz[count * 3 + 2] = w.z;
      bucket[count] = has ? Math.round(Math.min(1, Math.max(0, v)) * 100) : NO_DATA;
      count++;
    }
  }
  return { xyz, bucket, count };
}

const BUCKET_STYLE = Array.from({ length: BUCKETS }, (_, i) => {
  const [r, g, b, a] = snrColor(i / 100);
  // Dots are small: give clear sky a bit more presence than on the flat map.
  return `rgb(${r} ${g} ${b} / ${Math.min(1, (a / 255) * 1.5).toFixed(2)})`;
});

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function draw(ctx: CanvasRenderingContext2D, size: number, cloud: Cloud, b: Basis, earthFrame: boolean) {
  const fg = cssVar("--foreground", "#eef");
  const muted = cssVar("--muted-foreground", "#99a");
  const R = size * 0.38;
  const cx = size / 2;
  const cy = size / 2 + size * 0.04;
  ctx.clearRect(0, 0, size, size);

  // Ground disc + horizon ring (back half dimmer).
  const ring = (elevationDeg: number, alpha: number, dash: number[]) => {
    ctx.save();
    ctx.strokeStyle = fg;
    ctx.lineWidth = Math.max(1, size / 360);
    ctx.setLineDash(dash);
    for (const front of [false, true]) {
      ctx.globalAlpha = front ? alpha : alpha * 0.4;
      ctx.beginPath();
      let started = false;
      for (let a = 0; a <= 360; a += 4) {
        const p = project(skyToVec(a, elevationDeg), b);
        const isFront = p.depth >= -0.02;
        if (isFront !== front) {
          started = false;
          continue;
        }
        const x = cx + p.sx * R;
        const y = cy + p.sy * R;
        if (!started) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        started = true;
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  ring(0, 0.5, []);
  ring(30, 0.16, [3, 4]);
  ring(60, 0.16, [3, 4]);

  // Points: back hemisphere first (dimmed), then front; one fillStyle per colour bucket.
  const sizes = new Float32Array(cloud.count);
  const xs = new Float32Array(cloud.count);
  const ys = new Float32Array(cloud.count);
  const front = new Uint8Array(cloud.count);
  for (let i = 0; i < cloud.count; i++) {
    const p = project({ x: cloud.xyz[i * 3], y: cloud.xyz[i * 3 + 1], z: cloud.xyz[i * 3 + 2] }, b);
    xs[i] = cx + p.sx * R;
    ys[i] = cy + p.sy * R;
    sizes[i] = Math.max(1, size * 0.0085 * p.scale);
    front[i] = p.depth >= 0 ? 1 : 0;
  }
  for (const pass of [0, 1]) {
    for (let k = 0; k <= NO_DATA; k++) {
      ctx.globalAlpha = pass === 0 ? 0.35 : 1;
      ctx.fillStyle = k === NO_DATA ? muted : BUCKET_STYLE[k];
      if (k === NO_DATA) ctx.globalAlpha *= 0.18;
      for (let i = 0; i < cloud.count; i++) {
        if (cloud.bucket[i] !== k || front[i] !== pass) continue;
        const s = sizes[i];
        ctx.fillRect(xs[i] - s / 2, ys[i] - s / 2, s, s);
      }
    }
  }
  ctx.globalAlpha = 1;

  // Dish marker at the centre of the ground plane.
  const corner = (dx: number, dy: number) => project({ x: dx, y: dy, z: 0 }, b);
  const pts = [corner(-0.07, -0.07), corner(0.07, -0.07), corner(0.07, 0.07), corner(-0.07, 0.07)];
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(cx + p.sx * R, cy + p.sy * R) : ctx.moveTo(cx + p.sx * R, cy + p.sy * R)));
  ctx.closePath();
  ctx.fillStyle = fg;
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Compass labels just outside the horizon.
  if (earthFrame) {
    ctx.font = `600 ${Math.round(size * 0.04)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [t, az] of [
      ["N", 0],
      ["E", 90],
      ["S", 180],
      ["W", 270],
    ] as const) {
      const v = skyToVec(az, 0);
      const p = project({ x: v.x * 1.14, y: v.y * 1.14, z: 0 }, b);
      ctx.globalAlpha = p.depth >= 0 ? 0.9 : 0.45;
      ctx.fillStyle = fg;
      ctx.fillText(t, cx + p.sx * R, cy + p.sy * R);
    }
    ctx.globalAlpha = 1;
  }
}

/** Interactive dot-cloud dome. Drag or use the arrow keys to rotate; Home resets. */
export function DomeView({ map, earthFrame, label, still = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cloud = useMemo(() => buildCloud(map), [map]);
  const view = useRef<View>({ ...INITIAL });
  const state = useRef({ dirty: true, visible: true, lastInteract: 0, raf: 0, size: 0, last: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !wrap || !ctx) return;
    const st = state.current;
    st.dirty = true;

    const resize = () => {
      const css = wrap.clientWidth || 260;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
      canvas.style.width = `${css}px`;
      canvas.style.height = `${css}px`;
      st.size = canvas.width;
      st.dirty = true;
      kick();
    };

    const shouldAnimate = () =>
      !still && st.visible && document.visibilityState === "visible" && performance.now() - st.lastInteract > IDLE_MS;

    const frame = (t: number) => {
      st.raf = 0;
      const dt = st.last ? Math.min(100, t - st.last) : 16;
      st.last = t;
      if (shouldAnimate()) {
        view.current.yawDeg = (view.current.yawDeg + (AUTO_DEG_PER_S * dt) / 1000) % 360;
        st.dirty = true;
      }
      if (st.dirty && st.size > 0) {
        draw(ctx, st.size, cloud, viewBasis(view.current), earthFrame);
        st.dirty = false;
      }
      // Keep the loop alive only while something can change.
      if (shouldAnimate() || st.dirty || performance.now() - st.lastInteract <= IDLE_MS + 50) {
        st.raf = requestAnimationFrame(frame);
      } else {
        st.last = 0;
      }
    };

    function kick() {
      if (!st.raf) st.raf = requestAnimationFrame(frame);
    }

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);
    resize();

    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([e]) => {
            st.visible = e.isIntersecting;
            if (st.visible) kick();
          })
        : null;
    io?.observe(canvas);
    const onVis = () => document.visibilityState === "visible" && kick();
    document.addEventListener("visibilitychange", onVis);

    // Pointer drag rotates; keyboard arrows rotate in steps.
    let dragging: { x: number; y: number } | null = null;
    const interact = () => {
      st.lastInteract = performance.now();
      st.dirty = true;
      kick();
    };
    const down = (e: PointerEvent) => {
      dragging = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture?.(e.pointerId);
      interact();
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      view.current.yawDeg -= (e.clientX - dragging.x) * 0.5;
      view.current.tiltDeg = clampTilt(view.current.tiltDeg + (e.clientY - dragging.y) * 0.35);
      dragging = { x: e.clientX, y: e.clientY };
      interact();
    };
    const up = () => {
      dragging = null;
      interact();
    };
    const key = (e: KeyboardEvent) => {
      const v = view.current;
      if (e.key === "ArrowLeft") v.yawDeg += 10;
      else if (e.key === "ArrowRight") v.yawDeg -= 10;
      else if (e.key === "ArrowUp") v.tiltDeg = clampTilt(v.tiltDeg - 5);
      else if (e.key === "ArrowDown") v.tiltDeg = clampTilt(v.tiltDeg + 5);
      else if (e.key === "Home") Object.assign(v, INITIAL);
      else return;
      e.preventDefault();
      interact();
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("keydown", key);

    return () => {
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("keydown", key);
    };
  }, [cloud, earthFrame, still]);

  return (
    <div ref={wrapRef} className="relative aspect-square w-full max-w-[17rem]">
      <canvas
        ref={canvasRef}
        role="img"
        aria-roledescription="rotatable 3D sky view"
        aria-label={`Obstruction map, 3D view. ${label}`}
        aria-describedby="dome-help"
        tabIndex={0}
        className="block size-full cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      />
      <p id="dome-help" className="sr-only">
        Drag, or use the arrow keys, to rotate. Home resets the view.
      </p>
    </div>
  );
}
