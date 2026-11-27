import { CircleCheck, Compass, Footprints } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AlignmentStats } from "@/types/models";
import { ALIGNED_TOLERANCE_DEG, alignmentGuidance, AZ_TOLERANCE_DEG, normalizeAzimuth } from "@/lib/sky";
import { fmtNum, isNum } from "@/lib/format";
import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";
import { StatusDot } from "@/components/metric";

function polar(azDeg: number, r: number): [number, number] {
  const a = (azDeg * Math.PI) / 180;
  return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
}

/** Compass dial: needle = where the dish faces now, dot = where it should face. */
function Dial({ current, desired, desiredEl }: { current: number; desired: number; desiredEl: number | null }) {
  const [nx, ny] = polar(current, 34);
  const [dx, dy] = polar(desired, 40);
  // Tolerance wedge: azimuth offset that alone reaches the combined limit at this elevation.
  const half =
    desiredEl !== null ? Math.min(60, ALIGNED_TOLERANCE_DEG / Math.max(0.1, Math.cos((desiredEl * Math.PI) / 180))) : AZ_TOLERANCE_DEG;
  const [t1x, t1y] = polar(desired - half, 44);
  const [t2x, t2y] = polar(desired + half, 44);
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
      ].map(([label, az]) => {
        const [x, y] = polar(az as number, 51);
        return (
          <text key={label} x={x} y={y + 2.4} fontSize={7.5} textAnchor="middle" fill="var(--muted-foreground)" fontWeight={600}>
            {tr(label as string)}
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
        style={{ left: pct(desired - ALIGNED_TOLERANCE_DEG), width: `${((ALIGNED_TOLERANCE_DEG * 2) / 90) * 100}%` }}
      />
      <div className="absolute top-1/2 size-2.5 -translate-1/2 rounded-full bg-primary ring-2 ring-card" style={{ left: pct(desired) }} />
      <div className="absolute top-1/2 h-3.5 w-0.5 -translate-1/2 rounded-full bg-foreground" style={{ left: pct(current) }} />
    </div>
  );
}

export function AlignmentHelper({
  alignment,
  onStartGuided,
}: {
  alignment: AlignmentStats;
  /** Opens full-window guided alignment (dishes without motors only). */
  onStartGuided?: () => void;
}) {
  const g = alignmentGuidance(alignment);
  const { t } = useTranslation();
  if (!g || !isNum(alignment.azimuthDeg) || !isNum(alignment.desiredAzimuthDeg)) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3.5">
        <Dial
          current={normalizeAzimuth(alignment.azimuthDeg)}
          desired={normalizeAzimuth(alignment.desiredAzimuthDeg)}
          desiredEl={isNum(alignment.desiredElevationDeg) ? alignment.desiredElevationDeg : null}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {g.aligned ? (
            <p className="flex items-center gap-2 text-sm font-medium">
              <CircleCheck className="size-4 shrink-0 text-good" aria-hidden />
              {t("Aligned within tolerance")}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm font-medium">
              <Compass className="size-4 shrink-0 text-warning" aria-hidden />
              {t("Adjust the dish")}
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
        <caption className="sr-only">{t("Dish orientation now and target")}</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="font-normal">
              <span className="sr-only">{t("Axis")}</span>
            </th>
            <th scope="col" className="font-normal">{t("Now")}</th>
            <th scope="col" className="font-normal">{t("Target")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="pr-3 text-left font-normal text-muted-foreground">{t("Direction")}</th>
            <td className="num">{fmtNum(normalizeAzimuth(alignment.azimuthDeg), 1, true)}°</td>
            <td className="num">{fmtNum(normalizeAzimuth(alignment.desiredAzimuthDeg), 1, true)}°</td>
          </tr>
          {isNum(alignment.elevationDeg) && isNum(alignment.desiredElevationDeg) && (
            <tr>
              <th scope="row" className="pr-3 text-left font-normal text-muted-foreground">{t("Elevation")}</th>
              <td className="num">{fmtNum(alignment.elevationDeg, 1, true)}°</td>
              <td className="num">{fmtNum(alignment.desiredElevationDeg, 1, true)}°</td>
            </tr>
          )}
        </tbody>
      </table>
      {isNum(alignment.elevationDeg) && isNum(alignment.desiredElevationDeg) && (
        <ElevationBar current={alignment.elevationDeg} desired={alignment.desiredElevationDeg} />
      )}

      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        {t("Needle: where the dish faces now. Dot: target. Good within {{deg}}° of the target, direction and elevation combined.", {
          deg: ALIGNED_TOLERANCE_DEG,
        })}
        {g.uncertaintyDeg !== null &&
          ` ${t("Measurement uncertainty ±{{deg}}°.", { deg: fmtNum(g.uncertaintyDeg, 1, true) })}`}
      </p>
      {onStartGuided && (
        <Button size="sm" onClick={onStartGuided} className="self-start">
          <Footprints aria-hidden /> {t("Start guided alignment")}
        </Button>
      )}
    </div>
  );
}
