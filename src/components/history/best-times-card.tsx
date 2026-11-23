import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useTimeOfDay } from "@/hooks/use-pulse";
import { EM_DASH, formatBps, formatMs, formatPercent } from "@/lib/format";
import {
  bestAndWorst,
  lowerIsBetter,
  pad2,
  toMatrix,
  weekdayName,
  type TimeWindow,
  type TodMetric,
} from "@/lib/time-of-day";
import { tk } from "@/i18n/keys";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/state-panels";

// Sequential single-hue ramp (dataviz blue), dark → bright = low → high magnitude.
const RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4"];

const METRICS: { id: TodMetric; label: string }[] = [
  { id: "latency", label: tk("p95 latency") },
  { id: "drop", label: tk("Drop rate") },
  { id: "download", label: tk("Download") },
];
const DAYS = [7, 30, 90] as const;

function formatValue(m: TodMetric, v: number | null): string {
  if (v === null) return EM_DASH;
  return m === "latency" ? formatMs(v) : m === "drop" ? formatPercent(v, 2) : formatBps(v);
}

/** Generic segmented control (radio group with roving focus). */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.id === value);
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[n]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey} className="inline-flex h-7 items-center rounded-lg bg-muted p-0.5 ring-1 ring-border">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={cn(
              "h-6 rounded-md px-2 text-xs whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Weekday × hour heatmap with best/worst summary and an accessible table view. */
export function BestTimesCard() {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<TodMetric>("latency");
  const [days, setDays] = useState<number>(30);
  const tod = useTimeOfDay(days);
  const [focus, setFocus] = useState<{ d: number; h: number }>({ d: 0, h: 0 });
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const matrix = useMemo(() => (tod.data ? toMatrix(tod.data.cells, metric) : null), [tod.data, metric]);
  const range = useMemo(() => {
    const vals = (matrix ?? []).flat().filter((v): v is number => v !== null);
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }, [matrix]);
  const bw = useMemo(() => (tod.data ? bestAndWorst(tod.data.cells, metric) : null), [tod.data, metric]);

  const color = (v: number | null) => {
    if (v === null || !range) return undefined;
    const tt = range.max === range.min ? 0.5 : (v - range.min) / (range.max - range.min);
    return RAMP[Math.round(tt * (RAMP.length - 1))];
  };

  const describe = (w: TimeWindow) => {
    const when =
      w.days === "weekdays" ? t("weekdays") : w.days === "weekend" ? t("weekends") : weekdayName(w.days, "short");
    return `${when} ${pad2(w.startHour)}–${pad2(w.endHour)}`;
  };
  const summary =
    bw?.best && bw.worst
      ? t("Best: {{best}} · worst: {{worst}}", { best: describe(bw.best), worst: describe(bw.worst) })
      : null;

  const active = hover ?? null;
  const cellLabel = (d: number, h: number) =>
    `${weekdayName(d, "long")} ${pad2(h)}:00–${pad2((h + 1) % 24)}:00: ${formatValue(metric, matrix?.[d][h] ?? null)}`;

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let { d, h } = focus;
    if (e.key === "ArrowRight") h = Math.min(23, h + 1);
    else if (e.key === "ArrowLeft") h = Math.max(0, h - 1);
    else if (e.key === "ArrowDown") d = Math.min(6, d + 1);
    else if (e.key === "ArrowUp") d = Math.max(0, d - 1);
    else if (e.key === "Home") h = 0;
    else if (e.key === "End") h = 23;
    else return;
    e.preventDefault();
    setFocus({ d, h });
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${d}-${h}"]`)?.focus();
  };

  return (
    <Section title={t("Best times")} id="best-times" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label={t("Metric")}
          value={metric}
          options={METRICS.map((m) => ({ id: m.id, label: t(m.label) }))}
          onChange={setMetric}
        />
        <Segmented
          label={t("Period")}
          value={days}
          options={DAYS.map((d) => ({ id: d, label: t("{{count}} days", { count: d }) }))}
          onChange={setDays}
        />
      </div>

      {!tod.data && !tod.error && <Skeleton className="h-44 rounded-lg" />}
      {!tod.data && tod.error && <p className="text-xs text-muted-foreground">{tod.error.message}</p>}
      {tod.data && matrix && !range && (
        <p className="text-sm text-muted-foreground">{t("Not enough data yet. Best times appear after a few days of running.")}</p>
      )}
      {tod.data && matrix && range && (
        <div className="flex flex-col gap-2">
          {summary && <p className="text-sm">{summary}</p>}
          <div className="relative overflow-x-auto">
            <div
              ref={gridRef}
              role="grid"
              aria-label={t("Hourly {{metric}} by weekday", { metric: t(METRICS.find((m) => m.id === metric)!.label) })}
              aria-describedby="best-times-help"
              onKeyDown={onGridKey}
              className="grid min-w-[20rem] max-w-[56rem] grid-cols-[2.25rem_repeat(24,minmax(0,1fr))] gap-[2px]"
            >
              <div role="row" className="contents">
                {/* Occupies the label column; text is for screen readers only. */}
                <span role="columnheader">
                  <span className="sr-only">{t("Day")}</span>
                </span>
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} role="columnheader" className="num text-center text-[0.6rem] text-muted-foreground">
                    {h % 3 === 0 ? pad2(h) : <span className="sr-only">{pad2(h)}</span>}
                  </span>
                ))}
              </div>
              {matrix.map((row, d) => (
                <div role="row" key={d} className="contents">
                  <span role="rowheader" className="flex items-center text-[0.6875rem] text-muted-foreground">
                    {weekdayName(d)}
                  </span>
                  {row.map((v, h) => {
                    const isFocus = focus.d === d && focus.h === h;
                    return (
                      <span
                        key={h}
                        role="gridcell"
                        data-cell={`${d}-${h}`}
                        tabIndex={isFocus ? 0 : -1}
                        aria-label={cellLabel(d, h)}
                        onMouseEnter={() => setHover({ d, h })}
                        onMouseLeave={() => setHover(null)}
                        onFocus={() => {
                          setFocus({ d, h });
                          setHover({ d, h });
                        }}
                        onBlur={() => setHover(null)}
                        className={cn(
                          "h-4 rounded-[2px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-5",
                          v === null && "bg-muted/30 ring-1 ring-border ring-inset",
                        )}
                        style={{ background: color(v) }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {active && (
              <div
                role="tooltip"
                className="pointer-events-none absolute top-0 right-0 rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg ring-1 ring-border"
              >
                {cellLabel(active.d, active.h)}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              {t("Lower")}
              <span
                aria-hidden
                className="h-2 w-20 rounded-full"
                style={{ background: `linear-gradient(to right, ${RAMP.join(", ")})` }}
              />
              {t("Higher")}
              <span className="ml-1">· {lowerIsBetter(metric) ? t("lower is better") : t("higher is better")}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[2px] bg-muted/30 ring-1 ring-border" />
              {t("No data")}
            </span>
          </div>
          <p id="best-times-help" className="sr-only">
            {t("Use the arrow keys to move between hours and days.")}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              {t("Show as table")}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="num w-full text-[0.6875rem]">
                <caption className="sr-only">{t("Hourly values by weekday")}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="sticky top-0 bg-card px-1 text-left font-normal text-muted-foreground">
                      {t("Hour")}
                    </th>
                    {Array.from({ length: 7 }, (_, d) => (
                      <th key={d} scope="col" className="sticky top-0 bg-card px-1 text-right font-normal text-muted-foreground">
                        {weekdayName(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 24 }, (_, h) => (
                    <tr key={h}>
                      <th scope="row" className="px-1 text-left font-normal text-muted-foreground">
                        {pad2(h)}
                      </th>
                      {Array.from({ length: 7 }, (_, d) => (
                        <td key={d} className="px-1 text-right">
                          {formatValue(metric, matrix[d][h])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </Section>
  );
}
