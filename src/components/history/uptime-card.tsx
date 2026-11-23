import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import type { UptimeStats } from "@/types/models";
import { formatUptime } from "@/lib/usage";
import { formatDuration, isNum } from "@/lib/format";
import type { ApiError } from "@/lib/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/state-panels";

const LABELS: Record<string, string> = { "24h": tk("24 hours"), "7d": tk("7 days"), "30d": tk("30 days") };

export function UptimeCard({ data, error }: { data: UptimeStats | null; error: ApiError | null }) {
  const { t } = useTranslation();
  return (
    <Section title={t("Uptime")} id="uptime">
      {!data && !error && <Skeleton className="h-20 rounded-lg" />}
      {!data && error && <p className="text-xs text-muted-foreground">
          {t("Couldn't load uptime.")} {error.message}
        </p>}
      {data && (
        <>
          <dl className="grid grid-cols-3 gap-2">
            {data.windows.map((w) => {
              const known = isNum(w.uptimePct);
              return (
                <div key={w.label} className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted/40 px-2.5 py-2">
                  <dt className="eyebrow truncate">{LABELS[w.label] ? t(LABELS[w.label]) : w.label}</dt>
                  <dd className="num text-lg font-medium">{known ? formatUptime(w) : "—"}</dd>
                  <dd className="text-[0.6875rem] text-muted-foreground">
                    {known ? (
                      w.outageCount === 0 ? (
                        t("No outages")
                      ) : (
                        t("{{count}} outages, {{duration}}", {
                          count: w.outageCount,
                          duration: formatDuration(w.outageS),
                        })
                      )
                    ) : (
                      t("Not enough data yet")
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-2 text-[0.6875rem] text-muted-foreground">
            {t("Based on the time StarlinkPulse was running. Longer windows fill in over the coming days.")}
          </p>
        </>
      )}
    </Section>
  );
}
