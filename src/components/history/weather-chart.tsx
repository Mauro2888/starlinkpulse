import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bar, CartesianGrid, Cell, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { WeatherSeries } from "@/types/models";
import { fmtNum, formatClock } from "@/lib/format";
import { precipRows } from "@/lib/weather";

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" };

/** Hourly rain/snow bars on the same time domain as the latency chart. */
export function WeatherChart({ series, fromMs, toMs }: { series: WeatherSeries; fromMs: number; toMs: number }) {
  const { t } = useTranslation();
  const rows = useMemo(() => precipRows(series), [series]);
  const hasSnow = rows.some((r) => (r.snow ?? 0) > 0);
  const span = toMs - fromMs;
  const total = rows.reduce((a, r) => a + (r.rain ?? 0), 0);
  const summary = t("Total precipitation {{mm}} mm.", { mm: fmtNum(total, 1) });
  return (
    <figure
      className="flex min-w-0 flex-col gap-2"
      aria-label={`${t("{{title}} chart.", { title: t("Rain and snow") })} ${summary}`}
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium">
          {t("Rain and snow")} <span className="text-xs font-normal text-muted-foreground">mm/h</span>
        </span>
        <span className="text-[0.6875rem] text-muted-foreground">{series.locationName}</span>
      </figcaption>
      <div style={{ height: 88 }} className="-ml-1" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[fromMs, toMs]}
              tickFormatter={(v: number) => formatClock(v, span > 30 * 3_600_000)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: "var(--chart-axis)" }}
              minTickGap={28}
              allowDataOverflow
            />
            <YAxis
              width={40}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              domain={[0, "auto"]}
              tickCount={3}
              tickFormatter={(v: number) => fmtNum(v, 1)}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: "var(--muted)", fillOpacity: 0.4 }}
              content={(p) => {
                const row = p.active ? rows.find((r) => r.t === p.label) : undefined;
                if (!row) return null;
                return (
                  <div className="rounded-md bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-border">
                    <p className="num mb-1 text-muted-foreground">{formatClock(row.t, span > 30 * 3_600_000)}</p>
                    <p className="num">{t("Rain {{mm}} mm", { mm: fmtNum(row.rain ?? 0, 1) })}</p>
                    {hasSnow && <p className="num">{t("Snow {{cm}} cm", { cm: fmtNum(row.snow ?? 0, 1) })}</p>}
                  </div>
                );
              }}
            />
            {/* Precipitation already includes snow (water equivalent): colour snowy hours differently. */}
            <Bar dataKey="rain" name={t("Rain")} fill="var(--chart-1)" isAnimationActive={false} maxBarSize={14}>
              {rows.map((r) => (
                <Cell key={r.t} fill={(r.snow ?? 0) > 0 ? "var(--chart-2)" : "var(--chart-1)"} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
