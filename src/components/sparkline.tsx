import { useId } from "react";
import { cn } from "@/lib/utils";
import { isNum } from "@/lib/format";

interface SparklineProps {
  values: (number | null | undefined)[];
  className?: string;
  height?: number;
  /** Force the y-range to start at zero (rates, throughput). */
  zeroBased?: boolean;
  /** Fill under the line with a faint wash. */
  area?: boolean;
  /** Grow to fill a flex column (height becomes the minimum). */
  stretch?: boolean;
}

const W = 100;

/**
 * Lightweight SVG sparkline (decorative: the adjacent number is the readout).
 * Nulls break the line. Color comes from `currentColor`.
 */
export function Sparkline({ values, className, height = 28, zeroBased = false, area = false, stretch = false }: SparklineProps) {
  const gradId = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const nums = values.filter(isNum);
  if (nums.length < 2) {
    return <div aria-hidden className={cn("w-full", stretch && "flex-1", className)} style={{ minHeight: height }} />;
  }
  let min = zeroBased ? 0 : Math.min(...nums);
  let max = Math.max(...nums);
  if (max === min) {
    max += 1;
    min = zeroBased ? 0 : min - 1;
  }
  const pad = 2;
  const h = height;
  const stepX = W / Math.max(1, values.length - 1);
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - pad * 2);

  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  values.forEach((v, i) => {
    if (isNum(v)) cur.push([i * stepX, y(v)]);
    else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  });
  if (cur.length) segments.push(cur);

  const toPath = (pts: [number, number][]) =>
    pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`).join("");

  const svg = (
    <svg
      aria-hidden
      className={cn("block w-full overflow-visible", stretch && "absolute inset-0 h-full", !stretch && className)}
      height={stretch ? undefined : h}
      viewBox={`0 0 ${W} ${h}`}
      preserveAspectRatio="none"
    >
      {area && (
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {area &&
        segments.map((pts, i) =>
          pts.length > 1 ? (
            <path
              key={`a${i}`}
              d={`${toPath(pts)}L${pts[pts.length - 1][0]} ${h}L${pts[0][0]} ${h}Z`}
              fill={`url(#${gradId})`}
              stroke="none"
            />
          ) : null,
        )}
      {segments.map((pts, i) => (
        <path
          key={i}
          d={toPath(pts)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
  // Stretch: the SVG is absolutely positioned, so it never adds height; it only fills space the row already has.
  return stretch ? (
    <div className={cn("relative w-full flex-1", className)} style={{ minHeight: h }}>
      {svg}
    </div>
  ) : (
    svg
  );
}
