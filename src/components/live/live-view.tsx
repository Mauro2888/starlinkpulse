import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  Clock,
  CloudOff,
  FlaskConical,
  Gauge,
  Loader2,
  PlugZap,
  Radio,
  TreePine,
  Unplug,
  Waves,
} from "lucide-react";
import type { ConnectionStatus, DishCapabilities, MockMode, TelemetrySnapshot } from "@/types/models";
import {
  EM_DASH,
  formatAgo,
  formatBpsParts,
  formatDuration,
  formatMsParts,
  formatPercentParts,
  formatWattsParts,
  humanizeEnum,
  isNum,
} from "@/lib/format";
import { explainAlert, explainDisablement, explainRestriction } from "@/lib/explain";
import { dishModelName } from "@/lib/dish";
import { alignmentGuidance } from "@/lib/sky";
import { AlignmentHelper } from "@/components/sky/alignment-helper";
import type { ApiError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { MetricTile, Reading, StatusDot, type StatusTone } from "@/components/metric";
import { Sparkline } from "@/components/sparkline";
import { Banner, Section, StatePanel } from "@/components/state-panels";
import { Skeleton } from "@/components/ui/skeleton";

export interface LiveViewProps {
  snapshot: TelemetrySnapshot | null;
  buffer: TelemetrySnapshot[];
  capabilities: DishCapabilities | null;
  connection: ConnectionStatus | null;
  error: ApiError | null;
  now: number;
  pollIntervalS: number;
  /** Settings mock mode: tells a deliberate demo apart from an automatic fallback. */
  mockMode?: MockMode | null;
  /** Obstruction map section, rendered by the container (it fetches its own data). */
  skySlot?: ReactNode;
}

function latencyTone(ms: number | null): [StatusTone, string] | null {
  if (!isNum(ms)) return null;
  if (ms < 60) return ["good", "Responsive"];
  if (ms < 100) return ["warning", "Elevated"];
  return ["serious", "High"];
}

function dropTone(rate: number | null): [StatusTone, string] | null {
  if (!isNum(rate)) return null;
  if (rate < 0.01) return ["good", "Stable"];
  if (rate < 0.05) return ["warning", "Some loss"];
  return ["serious", "Heavy loss"];
}

function signalNote(s: TelemetrySnapshot): [StatusTone, string] | null {
  if (isNum(s.signalQuality)) {
    if (s.signalQuality >= 0.7) return ["good", "Strong"];
    if (s.signalQuality >= 0.4) return ["warning", "Fair"];
    return ["serious", "Weak"];
  }
  if (s.snrAboveNoiseFloor === true) return ["good", "Above noise floor"];
  if (s.snrAboveNoiseFloor === false) return ["serious", "Below noise floor"];
  return null;
}

function obstructionNote(s: TelemetrySnapshot): [StatusTone, string] | null {
  const o = s.obstruction;
  if (o.currentlyObstructed) return ["critical", "Blocked right now"];
  if (!isNum(o.fractionObstructed)) return null;
  if (o.fractionObstructed < 0.005) return ["good", "Clear sky"];
  if (o.fractionObstructed < 0.03) return ["warning", "Minor obstructions"];
  return ["serious", "Frequently blocked"];
}

function tile(note: [StatusTone, string] | null) {
  return note ? { tone: note[0], note: note[1] } : { note: undefined, tone: undefined };
}

export function LiveView({ snapshot, buffer, capabilities, connection, error, now, pollIntervalS, mockMode, skySlot }: LiveViewProps) {
  const state = connection?.state ?? null;

  if (!snapshot) {
    if (state === "offline" || (error && error.kind === "offline")) {
      return (
        <StatePanel
          tone="critical"
          icon={<Unplug />}
          title="Dish not reachable"
        >
          {connection?.lastError ?? error?.message ?? "No answer from the dish."}
          <br />
          Check that this computer is on the Starlink network. With a third-party router or bypass mode you may need a
          static route to 192.168.100.1.
        </StatePanel>
      );
    }
    if (state === "connecting" || state === null) {
      return (
        <div className="flex flex-col gap-3" aria-busy="true">
          <StatePanel icon={<Loader2 className="animate-spin motion-reduce:animate-none" />} title="Connecting to the dish">
            Reading the dish schema. The first launch can take a few seconds.
          </StatePanel>
          <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        </div>
      );
    }
    return (
      <StatePanel icon={<Radio />} title="Waiting for telemetry">
        {error ? error.message : "The first reading arrives within a few seconds."}
      </StatePanel>
    );
  }

  const s = snapshot;
  const ageMs = now - s.timestampMs;
  const stale = ageMs > Math.max(3, pollIntervalS) * 3000;
  const dl = explainRestriction(s.dlBandwidthRestrictedReason);
  const ul = explainRestriction(s.ulBandwidthRestrictedReason);
  const restricted = dl.restricted ? dl : ul.restricted ? ul : null;
  const disabled = explainDisablement(s.disablementCode);
  const series = (pick: (x: TelemetrySnapshot) => number | null) => buffer.map(pick);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 empty:hidden">
        {state === "mock" &&
          (mockMode === "on" ? (
            <Banner icon={<FlaskConical />} title="Demo mode: showing simulated data">
              Mock mode is set to Always in Settings. Nothing here comes from your dish.
            </Banner>
          ) : (
            <Banner icon={<FlaskConical />} tone="warning" title="Dish not reachable — showing simulated data">
              {connection?.lastError ? `${connection.lastError} ` : ""}Real data returns as soon as the dish answers.
            </Banner>
          ))}
        {state === "offline" && (
          <Banner icon={<CloudOff />} tone="critical" title="Connection lost">
            Showing the last reading from {formatAgo(s.timestampMs, now)}.{" "}
            {connection?.lastError}
          </Banner>
        )}
        {state !== "offline" && stale && (
          <Banner icon={<Clock />} tone="warning" title="Data is stale">
            Last reading {formatAgo(s.timestampMs, now)}.
          </Banner>
        )}
        {disabled && (
          <Banner icon={<AlertTriangle />} tone="critical" title={`Service disabled: ${disabled}`}>
            Starlink reports that service is not active on this dish.
          </Banner>
        )}
      </div>

      <div className={cn("grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]", stale && "opacity-80")}>
        <div className="flex min-w-0 flex-col gap-3">
          <Section title="Throughput" aside={<span className="text-xs text-muted-foreground">last 5 min</span>}>
            <div className="grid grid-cols-2 gap-4">
              <ThroughputReading
                label="Download"
                icon={<ArrowDown />}
                bps={s.downlinkBps}
                values={series((x) => x.downlinkBps)}
                colorClass="text-chart-1"
              />
              <ThroughputReading
                label="Upload"
                icon={<ArrowUp />}
                bps={s.uplinkBps}
                values={series((x) => x.uplinkBps)}
                colorClass="text-chart-2"
              />
            </div>
          </Section>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <MetricTile
              label="Latency"
              icon={<Gauge />}
              parts={formatMsParts(s.popPingLatencyMs)}
              {...tile(latencyTone(s.popPingLatencyMs))}
              spark={<Sparkline values={series((x) => x.popPingLatencyMs)} height={18} className="text-chart-1" />}
            />
            <MetricTile
              label="Drop rate"
              icon={<Waves />}
              parts={formatPercentParts(s.popPingDropRate)}
              {...tile(dropTone(s.popPingDropRate))}
              spark={<Sparkline values={series((x) => x.popPingDropRate)} height={18} zeroBased className="text-chart-1" />}
            />
            <MetricTile
              label="Signal"
              icon={<Radio />}
              parts={formatPercentParts(s.signalQuality, 0)}
              {...tile(signalNote(s))}
              missingHint="This firmware does not report a numeric signal quality"
            />
            <MetricTile
              label="Obstruction"
              icon={<TreePine />}
              parts={formatPercentParts(s.obstruction.fractionObstructed)}
              {...tile(obstructionNote(s))}
            />
            <MetricTile
              label="Uptime"
              icon={<Clock />}
              parts={{ value: formatDuration(s.uptimeS), unit: "" }}
              note={isNum(s.uptimeS) ? "Since last reboot" : undefined}
            />
            {(capabilities?.hasPowerTelemetry || isNum(s.powerW)) && (
              <MetricTile
                label="Power"
                icon={<PlugZap />}
                parts={formatWattsParts(s.powerW)}
                note={isNum(s.powerW) ? "Dish power draw" : undefined}
                missingHint="No power reading from the dish yet"
                spark={<Sparkline values={series((x) => x.powerW)} height={18} className="text-chart-1" />}
              />
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Section title="Bandwidth">
            {restricted ? (
              <div className="flex gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div>
                  <p className="text-sm font-medium">{restricted.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{restricted.detail}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Download: {dl.title} · Upload: {ul.title}
                  </p>
                </div>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm">
                <CircleCheck className="size-4 text-good" aria-hidden />
                No speed limit from your plan
              </p>
            )}
          </Section>

          <Section
            title="Alerts"
            aside={
              s.alerts.length > 0 ? (
                <span className="num text-xs text-muted-foreground">{s.alerts.length} active</span>
              ) : undefined
            }
          >
            {s.alerts.length === 0 ? (
              <p className="flex items-center gap-2 text-sm">
                <CircleCheck className="size-4 text-good" aria-hidden />
                No active alerts
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {s.alerts.map((a) => {
                  const info = explainAlert(a);
                  return (
                    <li key={a} className="flex gap-2.5">
                      <StatusDot tone={info.tone} className="mt-1.5 size-2" />
                      <div>
                        <p className="text-sm font-medium">{info.title}</p>
                        <p className="text-xs text-muted-foreground">{info.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {skySlot}

          {capabilities?.actuators !== "yes" && alignmentGuidance(s.alignment) && (
            <Section title="Alignment" id="alignment">
              <AlignmentHelper alignment={s.alignment} />
            </Section>
          )}

          <Section title="Dish">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
              <Row label="Model" value={dishModelName(capabilities)} />
              <Row label="Firmware" value={capabilities?.softwareVersion} mono />
              <Row
                label="GPS"
                value={
                  s.gpsValid == null
                    ? null
                    : s.gpsValid
                      ? `Valid${isNum(s.gpsSats) ? `, ${s.gpsSats} satellites` : ""}`
                      : "No fix"
                }
              />
              <Row label="Software update" value={s.softwareUpdateState ? humanizeEnum(s.softwareUpdateState) : null} />
              <Row label="Snow melt" value={s.isHeating == null ? null : s.isHeating ? "Heating now" : "Idle"} />
              <Row
                label="Wi-Fi router"
                value={capabilities ? (capabilities.hasRouter ? "Starlink router" : "Not detected") : null}
              />
            </dl>
          </Section>
        </div>
      </div>

      <p className="text-right text-[0.6875rem] text-muted-foreground" aria-live="off">
        Updated <span className="num">{formatAgo(s.timestampMs, now)}</span>
      </p>
    </div>
  );
}

function ThroughputReading({
  label,
  icon,
  bps,
  values,
  colorClass,
}: {
  label: string;
  icon: ReactNode;
  bps: number | null;
  values: (number | null)[];
  colorClass: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={cn("[&_svg]:size-3.5", colorClass)}>
          {icon}
        </span>
        <span className="eyebrow">{label}</span>
      </div>
      <Reading parts={formatBpsParts(bps)} size="lg" />
      <Sparkline values={values} height={32} zeroBased area className={colorClass} />
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-right text-foreground", mono && "num")} title={value ?? undefined}>
        {value ?? <span className="text-muted-foreground">{EM_DASH}</span>}
      </dd>
    </>
  );
}
