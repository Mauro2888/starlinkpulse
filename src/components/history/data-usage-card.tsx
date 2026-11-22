import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DataUsage } from "@/types/models";
import { cycleBars, cycleProgress, formatBytes, type CapState } from "@/lib/usage";
import type { ApiError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/state-panels";

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" };
const C_DOWN = "var(--chart-1)";
const C_UP = "var(--chart-2)";

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const CAP_COPY: Record<Exclude<CapState, "none">, { bar: string; text: (pct: number) => string }> = {
  ok: { bar: "bg-primary", text: (p) => `${p} % of your data cap` },
  warning: { bar: "bg-warning", text: (p) => `${p} % of your data cap. You're getting close.` },
  over: { bar: "bg-critical", text: (p) => `${p} % of your data cap. Over the limit.` },
};

export function DataUsageCard({ data, error }: { data: DataUsage | null; error: ApiError | null }) {
  return (
    <Section title="Data usage" id="data-usage">
      {!data && !error && <Skeleton className="h-40 rounded-lg" />}
      {!data && error && <p className="text-xs text-muted-foreground">Couldn't load data usage. {error.message}</p>}
      {data && <UsageBody data={data} />}
    </Section>
  );
}

function UsageBody({ data }: { data: DataUsage }) {
  const progress = cycleProgress(data);
  const bars = cycleBars(data);
  const pct = progress.fraction === null ? 0 : Math.round(progress.fraction * 100);
  const since = new Date(data.cycleStartMs).toLocaleDateString(undefined, { day: "numeric", month: "long" });

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs text-muted-foreground">This cycle, since {since}</p>
        <p className="num mt-0.5 text-2xl font-medium tracking-tight">{formatBytes(progress.totalBytes)}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>
            <span aria-hidden className="mr-1 inline-block size-2 rounded-full" style={{ background: C_DOWN }} />
            Download <span className="num text-foreground">{formatBytes(data.cycleDownloadBytes)}</span>
          </span>
          <span>
            <span aria-hidden className="mr-1 inline-block size-2 rounded-full" style={{ background: C_UP }} />
            Upload <span className="num text-foreground">{formatBytes(data.cycleUploadBytes)}</span>
          </span>
        </p>
      </div>

      {progress.state === "none" ? (
        <p className="text-xs text-muted-foreground">No data cap set. Add one in Controls → Settings to get alerts.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Data cap used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, pct)}
            aria-valuetext={`${formatBytes(progress.totalBytes)} of ${formatBytes(progress.capBytes)}`}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className={cn("h-full rounded-full", CAP_COPY[progress.state].bar)} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <p className="flex items-center gap-1.5 text-xs">
            {progress.state === "over" ? (
              <OctagonAlert className="size-3.5 shrink-0 text-critical" aria-hidden />
            ) : progress.state === "warning" ? (
              <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
            ) : null}
            <span>
              {CAP_COPY[progress.state].text(pct)}{" "}
              <span className="num text-muted-foreground">
                ({formatBytes(progress.totalBytes)} / {formatBytes(progress.capBytes)})
              </span>
            </span>
          </p>
        </div>
      )}

      {bars.length > 0 ? (
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex items-center justify-between text-[0.6875rem] text-muted-foreground">
            <span>Per day, GB</span>
            <span className="flex gap-3">
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-[2px]" style={{ background: C_DOWN }} /> Download
              </span>
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-[2px]" style={{ background: C_UP }} /> Upload
              </span>
            </span>
          </figcaption>
          <table className="sr-only">
            <caption>Estimated data usage per day this cycle</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Download</th>
                <th scope="col">Upload</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.dayMs}>
                  <th scope="row">{dayLabel(b.dayMs)}</th>
                  <td>{formatBytes(b.down * 1e9)}</td>
                  <td>{formatBytes(b.up * 1e9)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="-ml-1 h-28" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barCategoryGap="18%">
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis
                  dataKey="dayMs"
                  tickFormatter={dayLabel}
                  tick={AXIS_TICK}
                  tickLine={false}
                  axisLine={{ stroke: "var(--chart-axis)" }}
                  minTickGap={24}
                />
                <YAxis width={32} tick={AXIS_TICK} tickLine={false} axisLine={false} tickCount={4} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: "var(--foreground)", fillOpacity: 0.06 }}
                  isAnimationActive={false}
                  content={(p) => {
                    const row = bars.find((b) => b.dayMs === p.label);
                    if (!p.active || !row) return null;
                    return (
                      <div className="rounded-md bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-border">
                        <p className="mb-1 text-muted-foreground">{dayLabel(row.dayMs)}</p>
                        <p className="flex justify-between gap-3">
                          Download <span className="num">{formatBytes(row.down * 1e9)}</span>
                        </p>
                        <p className="flex justify-between gap-3">
                          Upload <span className="num">{formatBytes(row.up * 1e9)}</span>
                        </p>
                      </div>
                    );
                  }}
                />
                {/* Stacked: download at the baseline, upload on top, 2px surface gap between. */}
                <Bar dataKey="down" stackId="u" fill={C_DOWN} stroke="var(--card)" strokeWidth={1} isAnimationActive={false} />
                <Bar dataKey="up" stackId="u" fill={C_UP} stroke="var(--card)" strokeWidth={1} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ) : (
        <p className="text-xs text-muted-foreground">No usage recorded in this cycle yet.</p>
      )}

      <p className="flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
        <Info className="mt-px size-3 shrink-0" aria-hidden />
        Estimate based on dish throughput, not your Starlink bill. Usage while StarlinkPulse wasn't running is missing.
      </p>
    </div>
  );
}
