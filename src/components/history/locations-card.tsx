import { useTranslation } from "react-i18next";
import type { LocationStats } from "@/types/models";
import { useLocationStats, useSettings } from "@/hooks/use-pulse";
import { EM_DASH, fmtNum, formatDuration, formatMs, formatPercent, isNum } from "@/lib/format";
import { tk } from "@/i18n/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/state-panels";

/** A location needs this much data before its averages mean anything. */
export const MIN_COVERED_S = 3600;

type Key = "outagesPerHour" | "fractionObstructedAvg" | "latencyP95Ms" | "dropRateAvg";

const COLUMNS: { key: Key; label: string; format: (v: number) => string }[] = [
  { key: "outagesPerHour", label: tk("Outages / h"), format: (v) => fmtNum(v, 1) },
  { key: "fractionObstructedAvg", label: tk("Obstruction"), format: (v) => formatPercent(v) },
  { key: "latencyP95Ms", label: tk("p95 latency"), format: (v) => formatMs(v) },
  { key: "dropRateAvg", label: tk("Drop rate"), format: (v) => formatPercent(v, 2) },
];

export function hasEnoughData(l: LocationStats): boolean {
  return l.coveredS >= MIN_COVERED_S;
}

/** Side-by-side comparison of tagged locations, with small bars per metric (lower is better for all). */
export function LocationsCard() {
  const { t } = useTranslation();
  const stats = useLocationStats();
  const { settings } = useSettings();
  const current = settings?.activeLocation ?? null;
  const rows = (stats.data ?? []).slice().sort((a, b) => b.coveredS - a.coveredS);
  const max = (k: Key) => Math.max(0, ...rows.filter(hasEnoughData).map((r) => r[k] ?? 0));

  return (
    <Section title={t("Compare locations")} id="locations" className="min-w-0">
      {!stats.data && !stats.error && <Skeleton className="h-32 rounded-lg" />}
      {!stats.data && stats.error && <p className="text-xs text-muted-foreground">{stats.error.message}</p>}
      {stats.data && rows.filter((r) => r.name !== "").length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("Set a location in the header (for example Home or Campsite) to compare how the dish performs in different places.")}
        </p>
      )}
      {stats.data && rows.some((r) => r.name !== "") && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-xs">
            <caption className="sr-only">{t("Connection quality per location. Lower is better in every column.")}</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-normal">
                  {t("Location")}
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className="py-1 pr-3 font-normal">
                    {t(c.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.name || "untagged"}>
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                    <span className={r.name ? "text-foreground" : "text-muted-foreground italic"}>
                      {r.name || t("No location")}
                    </span>
                    {r.name !== "" && r.name === current && <span className="ml-1 text-primary">· {t("current")}</span>}
                    <span className="block text-[0.6875rem] text-muted-foreground">{formatDuration(r.coveredS)}</span>
                  </th>
                  {hasEnoughData(r) ? (
                    COLUMNS.map((c) => {
                      const v = r[c.key];
                      const m = max(c.key);
                      return (
                        <td key={c.key} className="py-1.5 pr-3 align-top">
                          <span className="num">{isNum(v) ? c.format(v) : EM_DASH}</span>
                          {isNum(v) && m > 0 && (
                            <span aria-hidden className="mt-1 block h-1.5 w-full max-w-24 rounded-full bg-muted">
                              <span className="block h-full rounded-full bg-chart-1" style={{ width: `${Math.max(4, (v / m) * 100)}%` }} />
                            </span>
                          )}
                        </td>
                      );
                    })
                  ) : (
                    <td colSpan={COLUMNS.length} className="py-1.5 pr-3 text-muted-foreground">
                      {t("Not enough data yet (needs at least 1 h)")}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[0.6875rem] text-muted-foreground">{t("Lower is better in every column.")}</p>
        </div>
      )}
    </Section>
  );
}
