import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BatteryConfig, DailyEnergy } from "@/types/models";
import { useEnergy } from "@/hooks/use-pulse";
import { EM_DASH, fmtNum, formatDate, formatDuration, formatWatts, isNum } from "@/lib/format";
import { batteryWh, runtimeSeconds, summarizeEnergy } from "@/lib/energy";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/state-panels";

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" };

const dayLabel = (ms: number) => formatDate(ms, { day: "numeric", month: "short" });

function formatWh(wh: number | null): string {
  if (!isNum(wh)) return EM_DASH;
  return wh >= 1000 ? `${fmtNum(wh / 1000, 2)} kWh` : `${fmtNum(wh, 0)} Wh`;
}

/** Daily energy use and battery runtime (only shown when the dish reports power). */
export function EnergyCard({ battery }: { battery: BatteryConfig | null }) {
  const { t } = useTranslation();
  const energy = useEnergy(14);
  const days: DailyEnergy[] = energy.data ?? [];
  const s = summarizeEnergy(days);
  const runtime = runtimeSeconds(battery, s.avgW);

  return (
    <Section title={t("Energy")} id="energy" className="min-w-0">
      {!energy.data && !energy.error && <Skeleton className="h-40 rounded-lg" />}
      {!energy.data && energy.error && <p className="text-xs text-muted-foreground">{energy.error.message}</p>}
      {energy.data && days.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("Energy data appears after the first day of running.")}</p>
      )}
      {energy.data && days.length > 0 && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-2">
            <div>
              <dt className="eyebrow">{t("Per day")}</dt>
              <dd className="num text-base font-medium">{formatWh(s.whPerDay)}</dd>
            </div>
            <div>
              <dt className="eyebrow">{t("Average")}</dt>
              <dd className="num text-base font-medium">{formatWatts(s.avgW)}</dd>
            </div>
            <div>
              <dt className="eyebrow">{t("Peak")}</dt>
              <dd className="num text-base font-medium">{formatWatts(s.peakW)}</dd>
            </div>
          </dl>

          <figure className="flex flex-col gap-1">
            <figcaption className="text-[0.6875rem] text-muted-foreground">{t("Wh per day, last 14 days")}</figcaption>
            <table className="sr-only">
              <caption>{t("Energy use per day")}</caption>
              <tbody>
                {days.map((d) => (
                  <tr key={d.dayMs}>
                    <th scope="row">{dayLabel(d.dayMs)}</th>
                    <td>{formatWh(d.wh)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="-ml-1 h-28" aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="dayMs" tickFormatter={dayLabel} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--chart-axis)" }} minTickGap={24} />
                  <YAxis width={36} tick={AXIS_TICK} tickLine={false} axisLine={false} tickCount={4} tickFormatter={(v: number) => fmtNum(v, 0)} />
                  <Tooltip
                    cursor={{ fill: "var(--foreground)", fillOpacity: 0.06 }}
                    isAnimationActive={false}
                    content={(p) => {
                      const row = days.find((d) => d.dayMs === p.label);
                      if (!p.active || !row) return null;
                      return (
                        <div className="rounded-md bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-border">
                          <p className="mb-1 text-muted-foreground">{dayLabel(row.dayMs)}</p>
                          <p className="num">{formatWh(row.wh)}</p>
                          {row.coveredS < 20 * 3600 && (
                            <p className="text-muted-foreground">{t("Partial day ({{duration}})", { duration: formatDuration(row.coveredS) })}</p>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="wh" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>

          {battery ? (
            <p className="text-sm">
              {runtime !== null
                ? t("≈ {{runtime}} at {{watts}} on your {{wh}} battery", {
                    runtime: formatDuration(runtime),
                    watts: formatWatts(s.avgW),
                    wh: formatWh(batteryWh(battery)),
                  })
                : t("Runtime appears once power readings arrive.")}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("Running on a battery? Add it in Controls → Settings to see how long it lasts.")}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
