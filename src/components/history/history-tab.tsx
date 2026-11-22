import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { AlertCircle, History, RefreshCw } from "lucide-react";
import { useCapabilities, useEvents, useHistory } from "@/hooks/use-pulse";
import { bucketHistory, summarizeHistory } from "@/lib/history";
import {
  EM_DASH,
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

function fmtNum(digits: number) {
  return (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(digits).replace(/\.0+$/, ""));
}

export function RangePicker({ value, onChange }: { value: number; onChange: (m: number) => void }) {
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
      aria-label="Time range"
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
  const [range, setRange] = useState<number>(360);
  const history = useHistory(range);
  const evts = useEvents(range);
  const caps = useCapabilities();

  // Recompute the window whenever new data arrives (refresh every minute).
  const toMs = useMemo(() => Date.now(), [history.data, range]);
  const fromMs = toMs - range * 60_000;
  const points = useMemo(() => history.data ?? [], [history.data]);
  const events = useMemo(() => evts.data ?? [], [evts.data]);
  const rows = useMemo(() => bucketHistory(points, fromMs, toMs), [points, fromMs, toMs]);
  const summary = useMemo(() => summarizeHistory(points, events, range), [points, events, range]);
  const hasPower = Boolean(caps?.hasPowerTelemetry) && points.some((p) => isNum(p.powerAvgW));

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
        title="Could not load history"
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        }
      >
        {history.error.message}
      </StatePanel>
    );
  } else if (points.length === 0) {
    body = (
      <StatePanel icon={<History />} title="No history yet">
        History builds up while the app runs. The dish keeps about 15 minutes of samples, which are saved here every
        few minutes.
      </StatePanel>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Avg latency" value={formatMs(summary.latencyAvgMs)} />
          <Stat label="Worst p95" value={formatMs(summary.latencyP95MaxMs)} />
          <Stat label="Avg loss" value={formatPercent(summary.dropRateAvg, 2)} />
          <Stat
            label="Outages"
            value={String(summary.outageCount)}
            detail={summary.outageCount > 0 ? `${formatDurationMs(summary.outageTotalMs)} total` : "None"}
          />
        </dl>
        {summary.coverage < 0.9 && (
          <p className="text-xs text-muted-foreground">
            Data covers {Math.round(summary.coverage * 100)}% of this range. Gaps mean the app was not running.
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <ChartCard>
            <TimeSeriesChart
              title="Ping latency"
              unit="ms"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={fmtNum(0)}
              series={[
                { key: "latAvg", label: "Average", color: C1 },
                { key: "latP95", label: "p95", color: C2, dashed: true },
              ]}
              summary={`Average ${formatMs(summary.latencyAvgMs)}, worst p95 ${formatMs(summary.latencyP95MaxMs)}.`}
            />
          </ChartCard>
          <ChartCard>
            <TimeSeriesChart
              title="Ping drop rate"
              unit="%"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={fmtNum(1)}
              series={[{ key: "loss", label: "Drop rate", color: C1, kind: "area" }]}
              summary={`Average ${formatPercent(summary.dropRateAvg, 2)}.`}
            />
          </ChartCard>
          <ChartCard>
            <TimeSeriesChart
              title="Average throughput"
              unit="Mbps"
              rows={rows}
              fromMs={fromMs}
              toMs={toMs}
              events={events}
              format={fmtNum(1)}
              series={[
                { key: "down", label: "Download", color: C1 },
                { key: "up", label: "Upload", color: C2 },
              ]}
              summary={`Average download ${formatBps(summary.downAvgBps)}.`}
            />
          </ChartCard>
          {hasPower && (
            <ChartCard>
              <TimeSeriesChart
                title="Power draw"
                unit="W"
                rows={rows}
                fromMs={fromMs}
                toMs={toMs}
                events={events}
                format={fmtNum(0)}
                zeroBased={false}
                series={[{ key: "power", label: "Average", color: C1 }]}
                summary="Average power draw per interval."
              />
            </ChartCard>
          )}
        </div>

        <Section
          title="Outages"
          aside={<span className="num text-xs text-muted-foreground">{events.length} in range</span>}
        >
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No outages in this range.</p>
          ) : (
            <ol className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto pr-1 text-xs" tabIndex={0} aria-label="Outage list, newest first">
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
          {evts.error && <p className="mt-2 text-xs text-critical">Could not load events: {evts.error.message}</p>}
        </Section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <RangePicker value={range} onChange={setRange} />
        <Button size="icon-sm" variant="ghost" onClick={refresh} aria-label="Refresh history" title="Refresh">
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
