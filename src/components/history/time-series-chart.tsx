import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DishEvent } from "@/types/models";
import type { ChartRow } from "@/lib/history";
import { EM_DASH, formatClock, isNum } from "@/lib/format";
import { explainCause, isRebootCause } from "@/lib/explain";

export interface SeriesSpec {
  key: Exclude<keyof ChartRow, "t">;
  label: string;
  color: string;
  kind?: "line" | "area";
  dashed?: boolean;
}

interface Props {
  title: string;
  rows: ChartRow[];
  series: SeriesSpec[];
  fromMs: number;
  toMs: number;
  events: DishEvent[];
  format: (v: number) => string;
  /** Short unit label shown next to the title. */
  unit: string;
  height?: number;
  /** Plain-language summary for screen readers. */
  summary: string;
  zeroBased?: boolean;
}

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" };

export function TimeSeriesChart({
  title,
  rows,
  series,
  fromMs,
  toMs,
  events,
  format,
  unit,
  height = 132,
  summary,
  zeroBased = true,
}: Props) {
  const span = toMs - fromMs;
  const withDay = span > 20 * 3_600_000;
  const minWidth = span / 240;
  const outages = useMemo(() => events.filter((e) => !isRebootCause(e.cause)), [events]);
  const reboots = useMemo(() => events.filter((e) => isRebootCause(e.cause)), [events]);

  return (
    <figure className="flex min-w-0 flex-col gap-2" aria-label={`${title} chart. ${summary}`}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">
          {title} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
        </span>
        <Legend series={series} hasOutages={outages.length > 0} hasReboots={reboots.length > 0} />
      </figcaption>
      <div style={{ height }} className="-ml-1" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 4, right: 14, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[fromMs, toMs]}
              tickFormatter={(v: number) => formatClock(v, withDay && span > 30 * 3_600_000)}
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
              tickFormatter={(v: number) => format(v)}
              domain={zeroBased ? [0, "auto"] : ["auto", "auto"]}
              tickCount={4}
            />
            {outages.map((e) => (
              <ReferenceArea
                key={`o${e.startMs}`}
                x1={e.startMs}
                x2={e.startMs + Math.max(e.durationMs, minWidth)}
                fill="var(--status-critical)"
                fillOpacity={0.22}
                strokeOpacity={0}
                ifOverflow="hidden"
              />
            ))}
            {reboots.map((e) => (
              <ReferenceLine
                key={`r${e.startMs}`}
                x={e.startMs}
                stroke="var(--foreground)"
                strokeOpacity={0.55}
                strokeDasharray="3 3"
                ifOverflow="hidden"
              />
            ))}
            <Tooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1, strokeDasharray: "2 2" }}
              isAnimationActive={false}
              content={(p) => (
                <ChartTooltip
                  active={Boolean(p.active)}
                  label={typeof p.label === "number" ? p.label : null}
                  rows={rows}
                  series={series}
                  format={format}
                  events={events}
                  withDay={withDay}
                />
              )}
            />
            {series.map((s) =>
              s.kind === "area" ? (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill={s.color}
                  fillOpacity={0.14}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 2, stroke: "var(--card)" }}
                />
              ) : (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={s.dashed ? 1.25 : 1.75}
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 2, stroke: "var(--card)" }}
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function Legend({ series, hasOutages, hasReboots }: { series: SeriesSpec[]; hasOutages: boolean; hasReboots: boolean }) {
  if (series.length < 2 && !hasOutages && !hasReboots) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
      {series.length > 1 &&
        series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="14" height="6" aria-hidden>
              <line x1="0" x2="14" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
            </svg>
            {s.label}
          </li>
        ))}
      {hasOutages && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2 rounded-[2px] bg-critical/40" />
          Outage
        </li>
      )}
      {hasReboots && (
        <li className="flex items-center gap-1.5">
          <svg width="6" height="10" aria-hidden>
            <line x1="3" x2="3" y1="0" y2="10" stroke="var(--foreground)" strokeOpacity="0.6" strokeDasharray="2 2" />
          </svg>
          Reboot
        </li>
      )}
    </ul>
  );
}

function ChartTooltip({
  active,
  label,
  rows,
  series,
  format,
  events,
  withDay,
}: {
  active: boolean;
  label: number | null;
  rows: ChartRow[];
  series: SeriesSpec[];
  format: (v: number) => string;
  events: DishEvent[];
  withDay: boolean;
}) {
  if (!active || label === null) return null;
  const row = rows.find((r) => r.t === label);
  if (!row) return null;
  const next = rows[rows.indexOf(row) + 1]?.t ?? row.t + 60_000;
  const hits = events.filter((e) => e.startMs < next && e.startMs + e.durationMs >= row.t);
  return (
    <div className="min-w-36 rounded-md bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-border">
      <p className="num mb-1 text-muted-foreground">{formatClock(row.t, withDay)}</p>
      <ul className="flex flex-col gap-0.5">
        {series.map((s) => {
          const v = row[s.key];
          return (
            <li key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
              <span className="num">{isNum(v) ? format(v) : EM_DASH}</span>
            </li>
          );
        })}
      </ul>
      {hits.length > 0 && (
        <p className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">
          {hits.map((e) => explainCause(e.cause)).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
        </p>
      )}
    </div>
  );
}
