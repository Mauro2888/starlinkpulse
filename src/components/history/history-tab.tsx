import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, History, RefreshCw } from "lucide-react";
import { useCapabilities, useDataUsage, useEvents, useHistory, useSettings, useUptime } from "@/hooks/use-pulse";
import { useTranslation } from "react-i18next";
import { BestTimesCard } from "@/components/history/best-times-card";
import { LocationsCard } from "@/components/history/locations-card";
import { EnergyCard } from "@/components/history/energy-card";
import { UptimeCard } from "@/components/history/uptime-card";
import { DataUsageCard } from "@/components/history/data-usage-card";
import { bucketHistory, summarizeHistory } from "@/lib/history";
import {
  EM_DASH,
  fmtNum,
  formatClock,
  formatDurationMs,
  formatMs,
  formatPercent,
  formatBps,
  isNum,
} from "@/lib/format";
import { explainCause, isRebootCause } from "@/lib/explain";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Section, StatePanel } from "@/components/state-panels";
import { TimeSeriesChart } from "@/components/history/time-series-chart";

export const RANGES = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "48h", minutes: 2880 },
] as const;

const C1 = "var(--chart-1)";
const C2 = "var(--chart-2)";

function axisNum(digits: number) {
  return (v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : digits);
}

export function RangePicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  const { t } = useTranslation();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = RANGES.findIndex((r) => r.minutes === value);
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % RANGES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + RANGES.length) % RANGES.length;
    else return;
    e.preventDefault();
    onChange(RANGES[next].minutes);
    const btn = e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next];
    btn?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("Time range")}
      onKeyDown={onKey}
      className="inline-flex h-7 items-center rounded-lg bg-muted p-0.5 ring-1 ring-border"
    >
      {RANGES.map((r) => {
        const active = r.minutes === value;
        return (
          <button
            key={r.minutes}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(r.minutes)}
            className={cn(
              "num h-6 min-w-10 rounded-md px-2 text-xs transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

export function HistoryTab() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [range, setRange] = useState<number>(360);
  const history = useHistory(range);
  const evts = useEvents(range);
  const caps = useCapabilities();
  const uptime = useUptime();
  const usage = useDataUsage(62);

  // Recompute the window whenever new data arrives (refresh every minute).
  const toMs = useMemo(() => Date.now(), [history.data, range]);
  const fromMs = toMs - range * 60_000;
  const points = useMemo(() => history.data ?? [], [history.data]);
  const events = useMemo(() => evts.data ?? [], [evts.data]);
  const rows = useMemo(() => bucketHistory(points, fromMs, toMs), [points, fromMs, toMs]);
  const summary = useMemo(() => summarizeHistory(points, events, range), [points, events, range]);
  const hasPower = Boolean(caps?.hasPowerTelemetry) && points.some((p) => isNum(p.powerAvgW));
  const hasEnergy = Boolean(caps?.hasPowerTelemetry);

  const refresh = () => {
    history.refresh();
    evts.refresh();
  };

  let body;
  if (history.loading && !history.data) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    );
  } else if (history.error && !history.data) {
    body = (
      <StatePanel
        tone="critical"
        icon={<AlertCircle />}
        title={t("Could not load history")}
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCw aria-hidden /> {t("Try again")}
          </Button>
        }
      >
        {history.error.message}
      </StatePanel>
    );
  } else if (points.length === 0) {
    body = (
      <StatePanel icon={<History />} title={t("No history yet")}>
        {t(
          "History builds up while the app runs. The dish keeps about 15 minutes of samples, which are saved here every few minutes.",
        )}
      </StatePanel>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("Avg latency")} value={formatMs(summary.latencyAvgMs)} />
          <Stat label={t("Worst p95")} value={formatMs(summary.latencyP95MaxMs)} />
          <Stat label={t("Avg loss")} value={formatPercent(summary.dropRateAvg, 2)} />
          <Stat
            label={t("Outages")}
            value={fmtNum(summary.outageCount, 0)}
            detail={
              summary.outageCount > 0
                ? t("{{duration}} total", { duration: formatDurationMs(summary.outageTotalMs) })
                : t("None")
            }
          />
        </dl>
        {summary.coverage < 0.9 && (
          <p className="text-xs text-muted-foreground">
            {t("Data covers {{pct}} of this range. Gaps mean the app was not running.", {
              pct: formatPercent(summary.coverage, 0),
            })}
          </p>
        )}

        {/* 4 charts: 2×2, then one row of 4 from 1600 px. 3 charts: last spans 2 at 768, one row of 3 from 1200. */}
        <div
          className={cn(
            "grid gap-3 md:grid-cols-2 [&>*]:h-full",
            hasPower ? "dash4:grid-cols-4" : "dash3:grid-cols-3 [&>*:last-child]:md:col-span-2 [&>*:last-child]:dash3:col-span-1",
          )}
        >
          <ChartCard>
            <TimeSeriesChart
              title={t("Ping latency")}
              unit="ms"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={axisNum(0)}
              series={[
                { key: "latAvg", label: t("Average"), color: C1 },
                { key: "latP95", label: "p95", color: C2, dashed: true },
              ]}
              summary={t("Average {{avg}}, worst p95 {{p95}}.", {
                avg: formatMs(summary.latencyAvgMs),
                p95: formatMs(summary.latencyP95MaxMs),
              })}
            />
          </ChartCard>
          <ChartCard>
            <TimeSeriesChart
              title={t("Ping drop rate")}
              unit="%"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={axisNum(1)}
              series={[{ key: "loss", label: t("Drop rate"), color: C1, kind: "area" }]}
              summary={t("Average {{avg}}.", { avg: formatPercent(summary.dropRateAvg, 2) })}
            />
          </ChartCard>
          <ChartCard>
            <TimeSeriesChart
              title={t("Average throughput")}
              unit="Mbps"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={axisNum(1)}
              series={[
                { key: "down", label: t("Download"), color: C1 },
                { key: "up", label: t("Upload"), color: C2 },
              ]}
              summary={t("Average download {{avg}}.", { avg: formatBps(summary.downAvgBps) })}
            />
          </ChartCard>
          {hasPower && (
            <ChartCard>
              <TimeSeriesChart
                title={t("Power draw")}
                unit="W"
                rows={rows}
                fromMs={fromMs}
                toMs={toMs}
                events={events}
                format={axisNum(0)}
                zeroBased={false}
                series={[{ key: "power", label: t("Average"), color: C1 }]}
                summary={t("Average power draw per interval.")}
              />
            </ChartCard>
          )}
        </div>

        <Section
          title={t("Outage log")}
          aside={
            <span className="num text-xs text-muted-foreground">{t("{{count}} in range", { count: events.length })}</span>
          }
        >
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No outages in this range.")}</p>
          ) : (
            <ol className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto pr-1 text-xs" tabIndex={0} aria-label={t("Outage list, newest first")}>
              {[...events].reverse().map((e) => (
                <li key={`${e.startMs}-${e.cause}`} className="flex items-center gap-3 py-1.5">
                  <span className="num w-20 shrink-0 text-muted-foreground">{formatClock(e.startMs, range > 1440)}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", isRebootCause(e.cause) ? "bg-foreground/60" : "bg-critical")}
                    />
                    {explainCause(e.cause)}
                  </span>
                  <span className="num shrink-0 text-right">{formatDurationMs(e.durationMs)}</span>
                </li>
              ))}
            </ol>
          )}
          {evts.error && (
            <p className="mt-2 text-xs text-critical">
              {t("Could not load events: {{error}}", { error: evts.error.message })}
            </p>
          )}
        </Section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        Summary cards, every row full: 2 cols ≥ 768 (Uptime+Energy stacked | Data usage),
        3 cols ≥ 1200 (Uptime | Energy | Data usage), 4 cols ≥ 1600 (stack | Data usage | Best times ×2).
        The stack wrapper uses display: contents at 3 columns, so reading order never changes.
      */}
      <div className="grid gap-3 md:grid-cols-2 dash3:grid-cols-3 dash4:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-3 dash3:contents dash4:flex [&>section]:flex-1">
          <UptimeCard data={uptime.data} error={uptime.error} />
          {hasEnergy && <EnergyCard battery={settings?.battery ?? null} />}
        </div>
        <div className={cn("min-w-0 [&>section]:h-full", !hasEnergy && "dash3:col-span-2 dash4:col-span-1")}>
          <DataUsageCard data={usage.data} error={usage.error} />
        </div>
        <div className="min-w-0 md:col-span-2 dash3:col-span-3 dash4:col-span-2 [&>section]:h-full">
          <BestTimesCard />
        </div>
        <div className="min-w-0 md:col-span-2 dash3:col-span-3 dash4:col-span-4">
          <LocationsCard />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <RangePicker value={range} onChange={setRange} />
        <Button size="icon-sm" variant="ghost" onClick={refresh} aria-label={t("Refresh history")} title={t("Refresh")}>
          <RefreshCw className={cn(history.loading && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </Button>
      </div>
      {body}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg bg-card px-3 py-2 ring-1 ring-border">
      <dt className="eyebrow">{label}</dt>
      <dd className="num mt-0.5 text-base font-medium">{value || EM_DASH}</dd>
      {detail && <dd className="text-[0.6875rem] text-muted-foreground">{detail}</dd>}
    </div>
  );
}

function ChartCard({ children }: { children: ReactNode }) {
  return <div className="min-w-0 rounded-xl bg-card p-3.5 ring-1 ring-border">{children}</div>;
}
