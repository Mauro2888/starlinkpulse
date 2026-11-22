import { useEffect, useMemo, useRef } from "react";
import type { ObstructionMap } from "@/types/models";
import { cellIndex, cellToSky, summarizeObstructionMap, type MapSummary } from "@/lib/sky";
import { formatPercent, isNum } from "@/lib/format";

// Sequential single-hue ramp (warm), encoding obstruction = 1 - snr.
// Clear sky recedes towards the surface; obstructions glow. OKLCH endpoints:
const RAMP_FROM = { l: 0.4, c: 0.006, h: 50 }; // clear: near-neutral, quiet
const RAMP_TO = { l: 0.8, c: 0.16, h: 50 }; // obstructed

function oklchToRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }) as [number, number, number];
}

/** Color for an SNR value (0 obstructed .. 1 clear). */
export function snrColor(snr: number): [number, number, number] {
  const t = 1 - Math.min(1, Math.max(0, snr));
  return oklchToRgb(
    RAMP_FROM.l + (RAMP_TO.l - RAMP_FROM.l) * t,
    RAMP_FROM.c + (RAMP_TO.c - RAMP_FROM.c) * t,
    RAMP_FROM.h + (RAMP_TO.h - RAMP_FROM.h) * t,
  );
}

const LUT = Array.from({ length: 101 }, (_, i) => snrColor(i / 100));
const css = ([r, g, b]: [number, number, number]) => `rgb(${r} ${g} ${b})`;

export function describeMap(s: MapSummary): string {
  const parts = [`${formatPercent(s.coverage, 0)} of the sky has data`];
  if (s.obstructedFraction !== null) {
    parts.push(`${formatPercent(s.obstructedFraction)} of it is obstructed`);
  }
  if (s.worstDirection && s.obstructedFraction && s.obstructedFraction > 0.005) {
    const elev = isNum(s.worstElevationDeg) ? `, about ${Math.round(s.worstElevationDeg)}° above the horizon` : "";
    parts.push(`mostly towards the ${s.worstDirection}${elev}`);
  }
  return parts.join(", ") + ".";
}

export function ObstructionMapView({ map }: { map: ObstructionMap }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const summary = useMemo(() => summarizeObstructionMap(map), [map]);
  const maxTheta = isNum(map.maxThetaDeg) ? map.maxThetaDeg : 80;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || map.rows <= 0 || map.cols <= 0) return;
    canvas.width = map.cols;
    canvas.height = map.rows;
    const img = ctx.createImageData(map.cols, map.rows);
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const i = cellIndex(r, c, map.cols);
        const v = map.snr[i];
        if (!isNum(v) || !cellToSky(r, c, map)) continue; // no data: transparent
        const [red, green, blue] = LUT[Math.round(Math.min(1, Math.max(0, v)) * 100)];
        img.data.set([red, green, blue, 255], i * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [map]);

  // Rings at zenith angles 30/60/80 -> elevation 60/30/10 degrees.
  const rings = [30, 60, 80].filter((t) => t <= maxTheta);
  const label = describeMap(summary);

  return (
    <figure className="flex flex-col items-center gap-2.5">
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
          {[
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
      <figcaption className="flex w-full flex-col gap-2">
        <p className="text-xs leading-relaxed text-foreground">{label}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            Clear
            <span
              aria-hidden
              className="h-2 w-16 rounded-full"
              style={{ background: `linear-gradient(to right, ${css(LUT[100])}, ${css(LUT[50])}, ${css(LUT[0])})` }}
            />
            Obstructed
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full bg-muted/40 ring-1 ring-border" />
            No data yet
          </span>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          Top-down view: north up, east right, centre straight up. Rings show elevation above the horizon.
        </p>
      </figcaption>
    </figure>
  );
}
