import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  CloudOff,
  FlaskConical,
  Gamepad2,
  Gauge,
  Info,
  Loader2,
  PlugZap,
  Radio,
  TreePine,
  Tv,
  Unplug,
  Video,
  Waves,
} from "lucide-react";
import type {
  BatteryConfig,
  ConnectionStatus,
  DishCapabilities,
  MockMode,
  ReadinessLevel,
  TelemetrySnapshot,
} from "@/types/models";
import {
  EM_DASH,
  fmtNum,
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
import { mean, runtimeSeconds } from "@/lib/energy";
import type { ApiError } from "@/lib/errors";
import { tk } from "@/i18n/keys";
import { cn } from "@/lib/utils";
import { MetricTile, Reading, StatusDot, type StatusTone } from "@/components/metric";
import { Sparkline } from "@/components/sparkline";
import { Banner, Section, StatePanel } from "@/components/state-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlignmentHelper } from "@/components/sky/alignment-helper";

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
  /** Opens guided alignment (only offered for dishes without motors). */
  onStartGuidedAlignment?: () => void;
  /** Optional battery for the runtime estimate on the Power tile. */
  battery?: BatteryConfig | null;
}

type Note = [StatusTone, string] | null;

function latencyTone(ms: number | null): Note {
  if (!isNum(ms)) return null;
  if (ms < 60) return ["good", tk("Responsive")];
  if (ms < 100) return ["warning", tk("Elevated")];
  return ["serious", tk("High")];
}

function jitterTone(ms: number | null): Note {
  if (!isNum(ms)) return null;
  if (ms < 10) return ["good", tk("Steady")];
  if (ms < 30) return ["warning", tk("Some jitter")];
  return ["serious", tk("Unstable")];
}

function dropTone(rate: number | null): Note {
  if (!isNum(rate)) return null;
  if (rate < 0.01) return ["good", tk("Stable")];
  if (rate < 0.05) return ["warning", tk("Some loss")];
  return ["serious", tk("Heavy loss")];
}

function signalNote(s: TelemetrySnapshot): Note {
  if (isNum(s.signalQuality)) {
    if (s.signalQuality >= 0.7) return ["good", tk("Strong")];
    if (s.signalQuality >= 0.4) return ["warning", tk("Fair")];
    return ["serious", tk("Weak")];
  }
  if (s.snrAboveNoiseFloor === true) return ["good", tk("Above noise floor")];
  if (s.snrAboveNoiseFloor === false) return ["serious", tk("Below noise floor")];
  return null;
}

function obstructionNote(s: TelemetrySnapshot): Note {
  const o = s.obstruction;
  if (o.currentlyObstructed) return ["critical", tk("Blocked right now")];
  if (!isNum(o.fractionObstructed)) return null;
  if (o.fractionObstructed < 0.005) return ["good", tk("Clear sky")];
  if (o.fractionObstructed < 0.03) return ["warning", tk("Minor obstructions")];
  return ["serious", tk("Frequently blocked")];
}

const READINESS: { key: "videoCall" | "gaming" | "streaming"; label: string; icon: ReactNode }[] = [
  { key: "videoCall", label: tk("Video calls"), icon: <Video /> },
  { key: "gaming", label: tk("Gaming"), icon: <Gamepad2 /> },
  { key: "streaming", label: tk("Streaming"), icon: <Tv /> },
];

const LEVEL: Record<ReadinessLevel, { label: string; icon: ReactNode; cls: string; ring: string }> = {
  good: { label: tk("Good"), icon: <CircleCheck />, cls: "text-good", ring: "ring-good/35" },
  fair: { label: tk("Fair"), icon: <CircleMinus />, cls: "text-warning", ring: "ring-warning/35" },
  poor: { label: tk("Poor"), icon: <CircleX />, cls: "text-critical", ring: "ring-critical/40" },
};

/** One row of all tiles from 1200 px. */
const WIDE_COLS: Record<number, string> = {
  5: "dash3:grid-cols-5",
  6: "dash3:grid-cols-6",
  7: "dash3:grid-cols-7",
};

/**
 * Span for the last tile so the final row is full: 2 columns below 768 px and
 * 4 columns up to 1200 px (e.g. 7 tiles → 4 + 3 with the last spanning 2).
 */
export function lastTileSpan(i: number, n: number): string | undefined {
  if (i !== n - 1) return undefined;
  const narrow = n % 2 === 1 ? "col-span-2" : "";
  const r = n % 4;
  const md = r === 0 ? "md:col-span-1" : ({ 1: "md:col-span-4", 2: "md:col-span-3", 3: "md:col-span-2" } as const)[r];
  return cn(narrow, md, "dash3:col-span-1");
}

/** Grid classes for the bottom band, depending on which optional cards exist. */
export function bandThree(hasSky: boolean, hasAlign: boolean) {
  // Status stack: vertical column next to other cards, or a row of three when it spans the width.
  const stackCol = "flex flex-col gap-3";
  const stackRow = "grid gap-3 md:grid-cols-3 [&>section]:h-full";
  if (hasSky && hasAlign) {
    return {
      grid: "md:grid-cols-2 dash3:grid-cols-3 dash4:grid-cols-4",
      sky: "dash4:col-span-2",
      align: "",
      // md: own full-width row of three; from 1200 px a vertical column.
      status: cn(stackRow, "md:col-span-2 dash3:col-span-1 dash3:flex dash3:flex-col"),
    };
  }
  if (hasSky || hasAlign) {
    return {
      grid: "md:grid-cols-2 dash3:grid-cols-3 dash4:grid-cols-4",
      sky: "dash3:col-span-2 dash4:col-span-3",
      align: "dash3:col-span-2 dash4:col-span-3",
      status: stackCol,
    };
  }
  return { grid: "", sky: "", align: "", status: stackRow };
}

export const GPS_SATS_HINT = tk(
  "Used for location/timing. The dish does not report how many Starlink satellites it is connected to.",
);

export function LiveView({
  snapshot,
  buffer,
  capabilities,
  connection,
  error,
  now,
  pollIntervalS,
  mockMode,
  skySlot,
  onStartGuidedAlignment,
  battery,
}: LiveViewProps) {
  const { t } = useTranslation();
  const state = connection?.state ?? null;
  const tile = (note: Note) => (note ? { tone: note[0], note: t(note[1]) } : { note: undefined, tone: undefined });

  if (!snapshot) {
    if (state === "offline" || (error && error.kind === "offline")) {
      return (
        <StatePanel tone="critical" icon={<Unplug />} title={t("Dish not reachable")}>
          {connection?.lastError ?? error?.message ?? t("No answer from the dish.")}
          <br />
          {t(
            "Check that this computer is on the Starlink network. With a third-party router or bypass mode you may need a static route to 192.168.100.1.",
          )}
        </StatePanel>
      );
    }
    if (state === "connecting" || state === null) {
      return (
        <div className="flex flex-col gap-3" aria-busy="true">
          <StatePanel
            icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}
            title={t("Connecting to the dish")}
          >
            {t("Reading the dish schema. The first launch can take a few seconds.")}
          </StatePanel>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        </div>
      );
    }
    return (
      <StatePanel icon={<Radio />} title={t("Waiting for telemetry")}>
        {error ? error.message : t("The first reading arrives within a few seconds.")}
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
  const showPower = Boolean(capabilities?.hasPowerTelemetry) || isNum(s.powerW);
  const recentW = mean(series((x) => x.powerW)) ?? s.powerW;
  const runtime = runtimeSeconds(battery, recentW);

  const tiles: { key: string; props: Parameters<typeof MetricTile>[0] }[] = [
    {
      key: "latency",
      props: {
        label: t("Latency"),
        icon: <Gauge />,
        parts: formatMsParts(s.popPingLatencyMs),
        ...tile(latencyTone(s.popPingLatencyMs)),
        spark: <Sparkline values={series((x) => x.popPingLatencyMs)} height={18} className="text-chart-1" />,
      },
    },
    {
      key: "jitter",
      props: {
        label: t("Jitter"),
        icon: <Activity />,
        parts: formatMsParts(s.jitterMs),
        ...tile(jitterTone(s.jitterMs)),
        missingHint: tk("Jitter appears after a few readings"),
        spark: <Sparkline values={series((x) => x.jitterMs)} height={18} className="text-chart-1" />,
      },
    },
    {
      key: "drop",
      props: {
        label: t("Drop rate"),
        icon: <Waves />,
        parts: formatPercentParts(s.popPingDropRate),
        ...tile(dropTone(s.popPingDropRate)),
        spark: <Sparkline values={series((x) => x.popPingDropRate)} height={18} zeroBased className="text-chart-1" />,
      },
    },
    {
      key: "signal",
      props: {
        label: t("Signal"),
        icon: <Radio />,
        parts: formatPercentParts(s.signalQuality, 0),
        ...tile(signalNote(s)),
        missingHint: tk("This firmware does not report a numeric signal quality"),
      },
    },
    {
      key: "obstruction",
      props: {
        label: t("Obstruction"),
        icon: <TreePine />,
        parts: formatPercentParts(s.obstruction.fractionObstructed),
        ...tile(obstructionNote(s)),
      },
    },
    {
      key: "uptime",
      props: {
        label: t("Uptime"),
        icon: <Clock />,
        parts: { value: formatDuration(s.uptimeS), unit: "" },
        note: isNum(s.uptimeS) ? t("Since last reboot") : undefined,
      },
    },
  ];
  if (showPower) {
    tiles.push({
      key: "power",
      props: {
        label: t("Power"),
        icon: <PlugZap />,
        parts: formatWattsParts(s.powerW),
        note:
          runtime !== null
            ? t("≈ {{runtime}} on battery", { runtime: formatDuration(runtime) })
            : isNum(s.powerW)
              ? t("Dish power draw")
              : undefined,
        missingHint: tk("No power reading from the dish yet"),
        spark: <Sparkline values={series((x) => x.powerW)} height={18} className="text-chart-1" />,
      },
    });
  }
  const tileCount = tiles.length;

  const hasSky = Boolean(skySlot);
  // Only for dishes known to have no motors: "unknown" may be motorized and must not be told to rotate.
  const hasAlign = capabilities?.actuators === "no" && alignmentGuidance(s.alignment) !== null;
  const band3 = bandThree(hasSky, hasAlign);
  // Status cards stack vertically next to the sky/alignment cards, or sit in a row when they span the width.
  const statusItem = "min-w-0";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 empty:hidden">
        {state === "mock" &&
          (mockMode === "on" ? (
            <Banner icon={<FlaskConical />} title={t("Demo mode: showing simulated data")}>
              {t("Mock mode is set to Always in Settings. Nothing here comes from your dish.")}
            </Banner>
          ) : (
            <Banner icon={<FlaskConical />} tone="warning" title={t("Dish not reachable — showing simulated data")}>
              {connection?.lastError ? `${connection.lastError} ` : ""}
              {t("Real data returns as soon as the dish answers.")}
            </Banner>
          ))}
        {state === "offline" && (
          <Banner icon={<CloudOff />} tone="critical" title={t("Connection lost")}>
            {t("Showing the last reading from {{ago}}.", { ago: formatAgo(s.timestampMs, now) })} {connection?.lastError}
          </Banner>
        )}
        {state !== "offline" && stale && (
          <Banner icon={<Clock />} tone="warning" title={t("Data is stale")}>
            {t("Last reading {{ago}}.", { ago: formatAgo(s.timestampMs, now) })}
          </Banner>
        )}
        {disabled && (
          <Banner icon={<AlertTriangle />} tone="critical" title={t("Service disabled: {{code}}", { code: disabled })}>
            {t("Starlink reports that service is not active on this dish.")}
          </Banner>
        )}
      </div>

      {/*
        Dashboard bands. Every row is filled at 1 / 2 / 3 / 4 columns (≥ 768 / 1200 / 1600 px);
        cards in a row stretch to the same height. DOM order = reading order (no CSS reordering).
      */}
      <div className={cn("flex flex-col gap-3", stale && "opacity-80")}>
        {/* Band 1: throughput hero + readiness. */}
        <div className="grid gap-3 md:grid-cols-[3fr_2fr] dash3:grid-cols-[2fr_1fr]">
        <Section
          title={t("Throughput")}
          aside={<span className="text-xs text-muted-foreground">{t("last 5 min")}</span>}
          className="flex h-full flex-col"
        >
          <div className="grid flex-1 grid-cols-2 gap-4">
            <ThroughputReading
              label={t("Download")}
              icon={<ArrowDown />}
              bps={s.downlinkBps}
              values={series((x) => x.downlinkBps)}
              colorClass="text-chart-1"
            />
            <ThroughputReading
              label={t("Upload")}
              icon={<ArrowUp />}
              bps={s.uplinkBps}
              values={series((x) => x.uplinkBps)}
              colorClass="text-chart-2"
            />
          </div>
        </Section>
        <Section title={t("Ready for")} id="readiness" className="h-full">
          {s.readiness ? (
            <ul className="grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-3 md:grid-cols-1">
              {READINESS.map((r) => {
                const level = LEVEL[s.readiness![r.key]];
                return (
                  <li
                    key={r.key}
                    className={cn(
                      "flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 ring-1 [&_svg]:size-4",
                      level.ring,
                    )}
                  >
                    <span aria-hidden className="text-muted-foreground">
                      {r.icon}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{t(r.label)}</span>
                    <span className={cn("flex items-center gap-1 text-xs font-medium", level.cls)}>
                      <span aria-hidden>{level.icon}</span>
                      <span className="text-foreground">{t(level.label)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("Appears after a few readings.")}</p>
          )}
        </Section>
        </div>

        {/* Band 2: metric tiles, spans chosen so the last row is always full. */}
        <div
          className={cn("grid grid-cols-2 gap-2 md:grid-cols-4", WIDE_COLS[tileCount])}
          role="group"
          aria-label={t("Connection quality")}
        >
          {tiles.map((tile, i) => (
            <MetricTile key={tile.key} {...tile.props} className={cn("h-full", lastTileSpan(i, tileCount))} />
          ))}
        </div>

        {/* Band 3: sky + alignment + a stacked column of small status cards. */}
        <div className={cn("grid gap-3", band3.grid)}>
          {skySlot && <div className={cn("min-w-0 [&>section]:h-full", band3.sky)}>{skySlot}</div>}
          {hasAlign && (
            <div className={cn("min-w-0", band3.align)}>
          <Section title={t("Alignment")} id="alignment" className="h-full">
            <AlignmentHelper alignment={s.alignment} onStartGuided={onStartGuidedAlignment} />
          </Section>
            </div>
          )}
          <div className={cn("min-w-0", band3.status)}>
        <Section title={t("Bandwidth")} className={statusItem}>
          {restricted ? (
            <div className="flex gap-2.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-sm font-medium">{restricted.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{restricted.detail}</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t("Download: {{dl}} · Upload: {{ul}}", { dl: dl.title, ul: ul.title })}
                </p>
              </div>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-4 text-good" aria-hidden />
              {t("No speed limit from your plan")}
            </p>
          )}
        </Section>
        <Section
          className={statusItem}
          title={t("Alerts")}
          aside={
            s.alerts.length > 0 ? (
              <span className="num text-xs text-muted-foreground">
                {t("{{count}} active", { count: s.alerts.length })}
              </span>
            ) : undefined
          }
        >
          {s.alerts.length === 0 ? (
            <p className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-4 text-good" aria-hidden />
              {t("No active alerts")}
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
        <Section title={t("Dish")} className={cn(statusItem, "flex-1")}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <Row label={t("Model")} value={dishModelName(capabilities)} />
            <Row label={t("Firmware")} value={capabilities?.softwareVersion} mono />
            <Row label={t("GPS fix")} value={s.gpsValid == null ? null : s.gpsValid ? t("Valid") : t("No fix")} />
            <Row
              label={t("GPS satellites")}
              value={isNum(s.gpsSats) ? fmtNum(s.gpsSats, 0) : null}
              mono
              hint={t(GPS_SATS_HINT)}
            />
            <Row
              label={t("Software update")}
              value={s.softwareUpdateState ? humanizeEnum(s.softwareUpdateState) : null}
            />
            <Row
              label={t("Snow melt")}
              value={s.isHeating == null ? null : s.isHeating ? t("Heating now") : t("Idle")}
            />
            <Row
              label={t("Wi-Fi router")}
              value={capabilities ? (capabilities.hasRouter ? t("Starlink router") : t("Not detected")) : null}
            />
          </dl>
        </Section>
          </div>
        </div>
      </div>

      <p className="text-right text-[0.6875rem] text-muted-foreground" aria-live="off">
        {t("Updated")} <span className="num">{formatAgo(s.timestampMs, now)}</span>
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
    <div role="group" aria-label={label} className="flex h-full min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className={cn("[&_svg]:size-3.5", colorClass)}>
          {icon}
        </span>
        <span className="eyebrow">{label}</span>
      </div>
      <Reading parts={formatBpsParts(bps)} size="lg" />
      <Sparkline values={values} height={32} zeroBased area stretch className={colorClass} />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /** Explanation shown in a tooltip next to the label (already translated). */
  hint?: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <dt className="flex items-center gap-1 text-muted-foreground">
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="grid size-4 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2"
              >
                <Info className="size-3" aria-hidden />
                <span className="sr-only">{t("About {{label}}", { label })}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">{hint}</TooltipContent>
          </Tooltip>
        )}
        {hint && <span className="sr-only">{hint}</span>}
      </dt>
      <dd className={cn("truncate text-right text-foreground", mono && "num")} title={value ?? undefined}>
        {value ?? <span className="text-muted-foreground">{EM_DASH}</span>}
      </dd>
    </>
  );
}
