import { useEffect, useMemo, useRef } from "react";
import type { ObstructionMap } from "@/types/models";
import { cellIndex, cellToSky } from "@/lib/sky";
import { clampTilt, project, skyToVec, viewBasis, type Basis, type View } from "@/lib/dome";
import { isNum } from "@/lib/format";
import { snrColor } from "@/components/sky/sky-colors";
import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";

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

const FRAME_MS = 1000 / 30; // ~30 fps is plenty for a slow-moving dome
const AUTO_ROTATE_MS = 30_000; // idle rotation stops after this; resumes on interaction

/** Points sorted by colour bucket, so each frame sets one fillStyle per bucket. */
interface Cloud {
  xyz: Float32Array;
  count: number;
  /** groups[k] = [start, end) indices of bucket k in `xyz`. */
  groups: [number, number][];
}

/** One point per cell: measured cells coloured by SNR, a sparse grid of faint dots where there's no data. */
export function buildCloud(map: ObstructionMap): Cloud {
  const perBucket: number[][] = Array.from({ length: BUCKETS + 1 }, () => []);
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      const p = cellToSky(r, c, map);
      if (!p) continue;
      const v = map.snr[cellIndex(r, c, map.cols)];
      const has = isNum(v);
      if (!has && (r % 3 !== 0 || c % 3 !== 0)) continue; // keep "no data" sparse
      const w = skyToVec(p.azimuthDeg, p.elevationDeg);
      perBucket[has ? Math.round(Math.min(1, Math.max(0, v)) * 100) : NO_DATA].push(w.x, w.y, w.z);
    }
  }
  const count = perBucket.reduce((n, a) => n + a.length / 3, 0);
  const xyz = new Float32Array(count * 3);
  const groups: [number, number][] = [];
  let at = 0;
  for (const arr of perBucket) {
    xyz.set(arr, at * 3);
    groups.push([at, at + arr.length / 3]);
    at += arr.length / 3;
  }
  return { xyz, count, groups };
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

interface Ink {
  fg: string;
  muted: string;
}

function readInk(): Ink {
  return { fg: cssVar("--foreground", "#eef"), muted: cssVar("--muted-foreground", "#99a") };
}

function draw(ctx: CanvasRenderingContext2D, size: number, cloud: Cloud, b: Basis, earthFrame: boolean, ink: Ink) {
  const { fg, muted } = ink;
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

  // Points: project once, then draw back hemisphere (dimmed) and front, one fillStyle per bucket.
  const xs = new Float32Array(cloud.count);
  const ys = new Float32Array(cloud.count);
  const sizes = new Float32Array(cloud.count);
  const front = new Uint8Array(cloud.count);
  const v = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < cloud.count; i++) {
    v.x = cloud.xyz[i * 3];
    v.y = cloud.xyz[i * 3 + 1];
    v.z = cloud.xyz[i * 3 + 2];
    const p = project(v, b);
    xs[i] = cx + p.sx * R;
    ys[i] = cy + p.sy * R;
    sizes[i] = Math.max(1, size * 0.0085 * p.scale);
    front[i] = p.depth >= 0 ? 1 : 0;
  }
  for (const pass of [0, 1]) {
    cloud.groups.forEach(([start, end], k) => {
      if (start === end) return;
      ctx.fillStyle = k === NO_DATA ? muted : BUCKET_STYLE[k];
      ctx.globalAlpha = (pass === 0 ? 0.35 : 1) * (k === NO_DATA ? 0.18 : 1);
      for (let i = start; i < end; i++) {
        if (front[i] !== pass) continue;
        const sz = sizes[i];
        ctx.fillRect(xs[i] - sz / 2, ys[i] - sz / 2, sz, sz);
      }
    });
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
      ctx.fillText(tr(t), cx + p.sx * R, cy + p.sy * R);
    }
    ctx.globalAlpha = 1;
  }
}

/** Interactive dot-cloud dome. Drag or use the arrow keys to rotate; Home resets. */
export function DomeView({ map, earthFrame, label, still = false }: Props) {
  const { t, i18n } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cloud = useMemo(() => buildCloud(map), [map]);
  const view = useRef<View>({ ...INITIAL });
  const state = useRef({ dirty: true, visible: true, lastInteract: 0, raf: 0, size: 0, last: 0, lastDraw: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !wrap || !ctx) return;
    const st = state.current;
    st.dirty = true;
    // Start the idle-rotation window now; it ends AUTO_ROTATE_MS after the last interaction.
    st.lastInteract = performance.now() - IDLE_MS;
    let ink = readInk();
    // Re-read theme colours when the root class/style changes (theme switch).
    const themeObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            ink = readInk();
            if (st.size > 0) draw(ctx, st.size, cloud, viewBasis(view.current), earthFrame, ink);
          })
        : null;
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

    const resize = () => {
      const css = wrap.clientWidth || 260;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(css * dpr);
      canvas.height = Math.round(css * dpr);
      canvas.style.width = `${css}px`;
      canvas.style.height = `${css}px`;
      st.size = canvas.width;
      // Draw right away so the dome never shows blank while waiting for the first animation frame.
      draw(ctx, st.size, cloud, viewBasis(view.current), earthFrame, ink);
      st.dirty = false;
      kick();
    };

    const shouldAnimate = () => {
      if (still || !st.visible || document.visibilityState !== "visible") return false;
      const idle = performance.now() - st.lastInteract;
      return idle > IDLE_MS && idle < IDLE_MS + AUTO_ROTATE_MS;
    };

    const frame = (t: number) => {
      st.raf = 0;
      // Cap at ~30 fps: skip this tick if the last draw was too recent.
      if (st.lastDraw && t - st.lastDraw < FRAME_MS - 1) {
        st.raf = requestAnimationFrame(frame);
        return;
      }
      st.lastDraw = t;
      const dt = st.last ? Math.min(100, t - st.last) : FRAME_MS;
      st.last = t;
      if (shouldAnimate()) {
        view.current.yawDeg = (view.current.yawDeg + (AUTO_DEG_PER_S * dt) / 1000) % 360;
        st.dirty = true;
      }
      if (st.dirty && st.size > 0) {
        draw(ctx, st.size, cloud, viewBasis(view.current), earthFrame, ink);
        st.dirty = false;
      }
      // Keep the loop alive only while something can change.
      if (shouldAnimate() || st.dirty || performance.now() - st.lastInteract <= IDLE_MS + 50) {
        st.raf = requestAnimationFrame(frame);
      } else {
        st.last = 0;
        st.lastDraw = 0;
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
      themeObserver?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("keydown", key);
    };
  }, [cloud, earthFrame, still, i18n.language]);

  return (
    <div ref={wrapRef} className="relative aspect-square w-full max-w-[17rem] dash3:max-w-[22rem]">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${t("Obstruction map, 3D view.")} ${label}`}
        aria-roledescription={t("rotatable 3D sky view")}
        aria-describedby="dome-help"
        tabIndex={0}
        className="block size-full cursor-grab touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      />
      <p id="dome-help" className="sr-only">
        {t("Drag, or use the arrow keys, to rotate. Home resets the view.")}
      </p>
    </div>
  );
}
