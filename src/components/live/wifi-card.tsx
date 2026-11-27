import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Lightbulb, Router, ShieldCheck, WifiOff } from "lucide-react";
import type { RouterStatus, WifiDevice, WifiDevices, WifiQuality } from "@/types/models";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { EM_DASH, fmtNum, formatAgo, formatBps, isNum } from "@/lib/format";
import { BAND_LABELS, isRepeater, weakSignalTip, wifiDeviceKey, wifiQuality } from "@/lib/wifi";
import { cn } from "@/lib/utils";
import { tk } from "@/i18n/keys";
import { Section, StatePanel } from "@/components/state-panels";
import { Skeleton } from "@/components/ui/skeleton";

const POLL_MS = 10_000;

const QUALITY: Record<WifiQuality, { label: string; cls: string; dot: string }> = {
  good: { label: tk("Good"), cls: "text-good", dot: "bg-good" },
  fair: { label: tk("Fair"), cls: "text-warning", dot: "bg-warning" },
  poor: { label: tk("Poor"), cls: "text-critical", dot: "bg-critical" },
};

/** Polls the router every 10 s while mounted and the window is visible. */
function useWifiDevices(): { data: WifiDevices | null; error: ApiError | null } {
  const [data, setData] = useState<WifiDevices | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api.getWifiDevices().then(
        (d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        },
        (e) => {
          if (alive) setError(normalizeError(e));
        },
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return { data, error };
}

export function WifiCard() {
  const { data, error } = useWifiDevices();
  return <WifiDevicesView data={data} error={error} />;
}

export function WifiDevicesView({ data, error }: { data: WifiDevices | null; error: ApiError | null }) {
  const { t } = useTranslation();
  const devices = data?.available ? data.devices : [];
  const weak = devices.filter((d) => wifiQuality(d) === "poor" && !isRepeater(d)).length;
  // A refresh failed after data was loaded: do not present the old list as live.
  const stale = !!error && !!data?.available;
  const tip = weakSignalTip(devices);

  let body;
  if (!data && !error) {
    body = <Skeleton className="h-24 rounded-lg" />;
  } else if (!data?.available) {
    body = (
      <StatePanel icon={<WifiOff />} title={t("Starlink router not reachable")} className="py-5">
        {error && error.kind !== "offline" && error.kind !== "unsupported"
          ? error.message
          : t("You may be using a third-party router or bypass mode.")}
      </StatePanel>
    );
  } else if (devices.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t("No devices connected right now.")}</p>;
  } else {
    let unnamed = 0;
    body = (
      <ul
        className={cn(
          "grid gap-1.5 md:grid-cols-2 dash3:grid-cols-3",
          devices.length > 6 && "max-h-[19rem] overflow-y-auto pr-1 md:max-h-[13rem]",
        )}
        // Scrollable region must be reachable by keyboard.
        tabIndex={devices.length > 6 ? 0 : undefined}
        aria-label={t("Wi-Fi devices")}
      >
        {devices.map((d, i) => {
          const label = d.name?.trim()
            ? d.name
            : isRepeater(d)
              ? t("Mesh repeater")
              : t("Device {{n}}", { n: ++unnamed });
          return <DeviceRow key={wifiDeviceKey(d, i, devices)} device={d} label={label} />;
        })}
      </ul>
    );
  }

  return (
    <Section
      title={t("Wi-Fi devices")}
      id="wifi"
      aside={
        devices.length > 0 ? (
          <span className="num text-xs text-muted-foreground">
            {t("{{count}} connected", { count: devices.length })}
            {weak > 0 && <span className="text-critical"> · {t("{{count}} weak signal", { count: weak })}</span>}
          </span>
        ) : undefined
      }
    >
      {stale && (
        <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-warning">
          <WifiOff className="size-3.5 shrink-0" aria-hidden />
          {isNum(data?.updatedMs)
            ? t("Not updated, last data {{ago}}", { ago: formatAgo(data.updatedMs) })
            : t("Not updated, showing the last data received")}
        </p>
      )}
      {data?.available && data.router && <RouterLine r={data.router} />}
      <div className={cn(stale && "opacity-60")}>{body}</div>
      {tip && (
        <p className="mt-2.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed ring-1 ring-warning/30">
          <Lightbulb className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>{t(tip)}</span>
        </p>
      )}
      {devices.length > 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <ShieldCheck className="size-3 shrink-0" aria-hidden />
          {t("Device names are shown only here and are never saved.")}
        </p>
      )}
    </Section>
  );
}

/** Router's own link check: internet, IPv6 and latency split into home side vs satellite side. */
function RouterLine({ r }: { r: RouterStatus }) {
  const { t } = useTranslation();
  const ms = (v: number | null) => (isNum(v) ? `${fmtNum(v, v < 10 ? 1 : 0)} ms` : EM_DASH);
  return (
    <dl className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {r.online !== null && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">{t("Internet")}</dt>
          <dd className={cn("font-medium", r.online ? "text-good" : "text-critical")}>
            {r.online ? t("Online") : t("Offline")}
          </dd>
        </div>
      )}
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">IPv6</dt>
        <dd className="font-medium">{r.ipv6 ? t("Active") : t("Not active")}</dd>
      </div>
      <div className="flex gap-1.5" title={t("Cable between the Starlink router and the dish.")}>
        <dt className="text-muted-foreground">{t("Router → dish")}</dt>
        <dd className="num font-medium">{ms(r.dishPingMs)}</dd>
      </div>
      <div className="flex gap-1.5" title={t("Through the satellite to Starlink's network.")}>
        <dt className="text-muted-foreground">{t("Router → Starlink")}</dt>
        <dd className="num font-medium">{ms(r.popPingMs)}</dd>
      </div>
    </dl>
  );
}

function DeviceRow({ device: d, label }: { device: WifiDevice; label: string }) {
  const { t } = useTranslation();
  const q = wifiQuality(d);
  const quality = q ? QUALITY[q] : null;
  const mbps = (v: number | null) => (isNum(v) ? formatBps(v * 1e6) : EM_DASH);
  const link =
    isNum(d.linkDownMbps) || isNum(d.linkUpMbps)
      ? t("Link {{down}} / {{up}} Mbps", {
          down: isNum(d.linkDownMbps) ? fmtNum(d.linkDownMbps, 0) : EM_DASH,
          up: isNum(d.linkUpMbps) ? fmtNum(d.linkUpMbps, 0) : EM_DASH,
        })
      : null;
  return (
    <li className="flex min-w-0 items-center gap-2.5 rounded-lg bg-muted/40 px-2.5 py-1.5">
      <span aria-hidden className="text-muted-foreground [&_svg]:size-4">
        {isRepeater(d) ? <Router /> : <span className={cn("block size-2 rounded-full", quality?.dot ?? "bg-muted-foreground/40")} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm">
          <span className="truncate" title={label}>
            {label}
          </span>
          <span className="shrink-0 rounded-sm bg-background/60 px-1 text-[0.625rem] font-medium text-muted-foreground ring-1 ring-border">
            {t(BAND_LABELS[d.band])}
          </span>
        </p>
        {link && <p className="num truncate text-[0.6875rem] text-muted-foreground">{link}</p>}
      </div>
      <div className="shrink-0 text-right text-xs">
        {isNum(d.signalDbm) && (
          <p className={cn("num font-medium", quality?.cls)}>
            {fmtNum(d.signalDbm, 0)} dBm
            {quality && <span className="sr-only"> ({t(quality.label)})</span>}
          </p>
        )}
        <p className="num text-[0.6875rem] text-muted-foreground">
          <ArrowDown className="inline size-3 align-[-2px]" aria-hidden />
          <span className="sr-only">{t("Download")} </span>
          {mbps(d.downMbps)} <ArrowUp className="inline size-3 align-[-2px]" aria-hidden />
          <span className="sr-only">{t("Upload")} </span>
          {mbps(d.upMbps)}
        </p>
      </div>
    </li>
  );
}
