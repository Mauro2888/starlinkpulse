import { useEffect, useMemo, useRef } from "react";
import type { ObstructionMap } from "@/types/models";
import { cellIndex, cellToSky, summarizeObstructionMap, type MapSummary } from "@/lib/sky";
import { formatPercent, isNum } from "@/lib/format";
import { snrColor, type Rgba } from "@/components/sky/sky-colors";
import { DomeView } from "@/components/sky/dome-view";

const LUT = Array.from({ length: 101 }, (_, i) => snrColor(i / 100));
export { snrColor };
const css = ([r, g, b, a]: Rgba) => `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(2)})`;

/** Compass directions are only meaningful in the earth frame (or when the frame is unknown). */
export function isEarthFrame(frame: string | null | undefined): boolean {
  return frame == null || frame === "" || frame === "FRAME_EARTH";
}

export function describeMap(s: MapSummary, earthFrame = true): string {
  const parts = [`${formatPercent(s.coverage, 0)} of the sky has data`];
  if (s.obstructedFraction !== null) {
    parts.push(`${formatPercent(s.obstructedFraction)} of it is obstructed`);
  }
  if (earthFrame && s.worstDirection && s.obstructedFraction && s.obstructedFraction > 0.005) {
    const elev = isNum(s.worstElevationDeg) ? `, about ${Math.round(s.worstElevationDeg)}° above the horizon` : "";
    parts.push(`mostly towards the ${s.worstDirection}${elev}`);
  }
  return parts.join(", ") + ".";
}

export type MapMode = "2d" | "3d";

export function ObstructionMapView({
  map,
  mode = "2d",
  still = false,
}: {
  map: ObstructionMap;
  mode?: MapMode;
  /** No idle animation in 3D (reduced motion). */
  still?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = useMemo(() => summarizeObstructionMap(map), [map]);
  const maxTheta = isNum(map.maxThetaDeg) ? map.maxThetaDeg : 80;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (mode !== "2d" || !canvas || !ctx || map.rows <= 0 || map.cols <= 0) return;
    canvas.width = map.cols;
    canvas.height = map.rows;
    const img = ctx.createImageData(map.cols, map.rows);
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const i = cellIndex(r, c, map.cols);
        const v = map.snr[i];
        if (!isNum(v) || !cellToSky(r, c, map)) continue; // no data: transparent
        img.data.set(LUT[Math.round(Math.min(1, Math.max(0, v)) * 100)], i * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [map, mode]);

  // Rings at zenith angles 30/60/80 -> elevation 60/30/10 degrees.
  const rings = [30, 60, 80].filter((t) => t <= maxTheta);
  const earth = isEarthFrame(map.referenceFrame);
  const label = describeMap(summary, earth);

  return (
    <figure className="flex flex-col items-center gap-2.5">
      {mode === "3d" ? (
        <DomeView map={map} earthFrame={earth} label={label} still={still} />
      ) : (
      <div className="relative aspect-square w-full max-w-[17rem]" role="img" aria-label={`Obstruction map. ${label}`}>
        <div className="absolute inset-[7%] rounded-full bg-muted/40 ring-1 ring-border" aria-hidden />
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-[7%] h-[86%] w-[86%] rounded-full"
          style={{ imageRendering: "auto" }}
        />
        <svg viewBox="-8 -8 116 116" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          {rings.map((t) => {
            const r = (t / maxTheta) * 50;
            return (
              <g key={t}>
                <circle cx={50} cy={50} r={r} fill="none" stroke="var(--foreground)" strokeOpacity={0.22} strokeWidth={0.4} strokeDasharray={t === maxTheta ? undefined : "1.2 1.2"} />
                <text x={50 + r * 0.707 + 1} y={50 - r * 0.707 - 1} fontSize={3.4} fill="var(--muted-foreground)" className="num">
                  {90 - t}°
                </text>
              </g>
            );
          })}
          <line x1={50} y1={0} x2={50} y2={100} stroke="var(--foreground)" strokeOpacity={0.12} strokeWidth={0.3} />
          <line x1={0} y1={50} x2={100} y2={50} stroke="var(--foreground)" strokeOpacity={0.12} strokeWidth={0.3} />
          <circle cx={50} cy={50} r={0.9} fill="var(--foreground)" fillOpacity={0.6} />
          {earth && [
            ["N", 50, -3.2],
            ["E", 104, 51.3],
            ["S", 50, 106.5],
            ["W", -4, 51.3],
          ].map(([t, x, y]) => (
            <text key={t} x={x} y={y} fontSize={4.2} fontWeight={600} textAnchor="middle" fill="var(--foreground)" fillOpacity={0.85}>
              {t}
            </text>
          ))}
        </svg>
      </div>
      )}
      <figcaption className="flex w-full flex-col gap-2">
        <p className="text-xs leading-relaxed text-foreground">{label}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: css(LUT[100]) }} />
            Clear
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-12 rounded-full"
              style={{ background: `linear-gradient(to right, ${css(LUT[65])}, ${css(LUT[30])}, ${css(LUT[0])})` }}
            />
            Partly → fully obstructed
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full bg-muted/40 ring-1 ring-border" />
            No data yet
          </span>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          {mode === "3d"
            ? `3D view of the sky above the dish${earth ? "" : " (dish-relative orientation)"}. Drag or use the arrow keys to rotate; the solid ring is the horizon, dashed rings are 30° and 60° up.`
            : earth
            ? "Top-down view: north up, east right, centre straight up. Rings show elevation above the horizon."
            : "Dish-relative orientation: this firmware reports the map relative to the dish, not to compass directions. Centre is straight up; rings show elevation above the horizon."}
        </p>
      </figcaption>
    </figure>
  );
}
