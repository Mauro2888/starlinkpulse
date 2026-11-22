import { CircleCheck, Compass } from "lucide-react";
import type { AlignmentStats } from "@/types/models";
import { alignmentGuidance, AZ_TOLERANCE_DEG, EL_TOLERANCE_DEG, normalizeAzimuth } from "@/lib/sky";
import { isNum } from "@/lib/format";
import { StatusDot } from "@/components/metric";

function polar(azDeg: number, r: number): [number, number] {
  const a = (azDeg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
}

/** Compass dial: needle = where the dish faces now, dot = where it should face. */
function Dial({ current, desired }: { current: number; desired: number }) {
  const [nx, ny] = polar(current, 34);
  const [dx, dy] = polar(desired, 40);
  // Tolerance wedge around the desired azimuth.
  const [t1x, t1y] = polar(desired - AZ_TOLERANCE_DEG * 2, 44);
  const [t2x, t2y] = polar(desired + AZ_TOLERANCE_DEG * 2, 44);
  return (
    <svg viewBox="-6 -6 112 112" className="size-24 shrink-0 overflow-visible" aria-hidden>
      <circle cx={50} cy={50} r={44} fill="var(--muted)" fillOpacity={0.4} stroke="var(--border)" />
      {Array.from({ length: 36 }, (_, i) => {
        const [x1, y1] = polar(i * 10, i % 9 === 0 ? 37 : 40.5);
        const [x2, y2] = polar(i * 10, 43);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--foreground)" strokeOpacity={i % 9 === 0 ? 0.5 : 0.18} strokeWidth={0.8} />;
      })}
      <path d={`M50 50 L${t1x} ${t1y} A44 44 0 0 1 ${t2x} ${t2y} Z`} fill="var(--primary)" fillOpacity={0.18} />
      {[
        ["N", 0],
        ["E", 90],
        ["S", 180],
        ["W", 270],
      ].map(([t, az]) => {
        const [x, y] = polar(az as number, 51);
        return (
          <text key={t} x={x} y={y + 2.4} fontSize={7.5} textAnchor="middle" fill="var(--muted-foreground)" fontWeight={600}>
            {t}
          </text>
        );
      })}
      <line x1={50} y1={50} x2={nx} y2={ny} stroke="var(--foreground)" strokeWidth={2.2} strokeLinecap="round" />
      <circle cx={50} cy={50} r={2.6} fill="var(--foreground)" />
      <circle cx={dx} cy={dy} r={3.4} fill="var(--primary)" stroke="var(--card)" strokeWidth={1.2} />
    </svg>
  );
}

/** Horizontal elevation gauge (0-90°) with the tolerance band around the target. */
function ElevationBar({ current, desired }: { current: number; desired: number }) {
  const pct = (v: number) => `${(Math.min(90, Math.max(0, v)) / 90) * 100}%`;
  return (
    <div className="relative mt-1 h-2 w-full rounded-full bg-muted" aria-hidden>
      <div
        className="absolute inset-y-0 rounded-full bg-primary/25"
        style={{ left: pct(desired - EL_TOLERANCE_DEG), width: `${((EL_TOLERANCE_DEG * 2) / 90) * 100}%` }}
      />
      <div className="absolute top-1/2 size-2.5 -translate-1/2 rounded-full bg-primary ring-2 ring-card" style={{ left: pct(desired) }} />
      <div className="absolute top-1/2 h-3.5 w-0.5 -translate-1/2 rounded-full bg-foreground" style={{ left: pct(current) }} />
    </div>
  );
}

export function AlignmentHelper({ alignment }: { alignment: AlignmentStats }) {
  const g = alignmentGuidance(alignment);
  if (!g || !isNum(alignment.azimuthDeg) || !isNum(alignment.desiredAzimuthDeg)) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3.5">
        <Dial current={normalizeAzimuth(alignment.azimuthDeg)} desired={normalizeAzimuth(alignment.desiredAzimuthDeg)} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {g.aligned ? (
            <p className="flex items-center gap-2 text-sm font-medium">
              <CircleCheck className="size-4 shrink-0 text-good" aria-hidden />
              Aligned within tolerance
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm font-medium">
              <Compass className="size-4 shrink-0 text-warning" aria-hidden />
              Adjust the dish
            </p>
          )}
          <ul className="flex flex-col gap-1 text-xs">
            <li className="flex items-start gap-2">
              <StatusDot tone={g.azimuth.ok ? "good" : "warning"} className="mt-1.5" />
              <span>{g.azimuth.text}</span>
            </li>
            {g.elevation && (
              <li className="flex items-start gap-2">
                <StatusDot tone={g.elevation.ok ? "good" : "warning"} className="mt-1.5" />
                <span>{g.elevation.text}</span>
              </li>
            )}
          </ul>
        </div>
      </div>

      <table className="w-full text-xs">
        <caption className="sr-only">Dish orientation now and target</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="font-normal">
              <span className="sr-only">Axis</span>
            </th>
            <th scope="col" className="font-normal">Now</th>
            <th scope="col" className="font-normal">Target</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="pr-3 text-left font-normal text-muted-foreground">Direction</th>
            <td className="num">{normalizeAzimuth(alignment.azimuthDeg).toFixed(1)}°</td>
            <td className="num">{normalizeAzimuth(alignment.desiredAzimuthDeg).toFixed(1)}°</td>
          </tr>
          {isNum(alignment.elevationDeg) && isNum(alignment.desiredElevationDeg) && (
            <tr>
              <th scope="row" className="pr-3 text-left font-normal text-muted-foreground">Elevation</th>
              <td className="num">{alignment.elevationDeg.toFixed(1)}°</td>
              <td className="num">{alignment.desiredElevationDeg.toFixed(1)}°</td>
            </tr>
          )}
        </tbody>
      </table>
      {isNum(alignment.elevationDeg) && isNum(alignment.desiredElevationDeg) && (
        <ElevationBar current={alignment.elevationDeg} desired={alignment.desiredElevationDeg} />
      )}

      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        Needle: where the dish faces now. Dot: target. Good within ±{AZ_TOLERANCE_DEG}° direction and ±{EL_TOLERANCE_DEG}°
        elevation.
        {g.uncertaintyDeg !== null && (
          <>
            {" "}
            Measurement uncertainty <span className="num">±{g.uncertaintyDeg.toFixed(1)}°</span>.
          </>
        )}
      </p>
    </div>
  );
}
