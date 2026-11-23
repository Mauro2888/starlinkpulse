import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, RefreshCw, TriangleAlert, Tv } from "lucide-react";
import type { LanDashboardInfo, LanDashboardSettings } from "@/types/models";
import { api } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/notify";
import { Button } from "@/components/ui/button";

/** Status of the running LAN dashboard: URLs, QR, access code. */
export function LanDashboardStatus({
  saved,
  onTokenChanged,
}: {
  /** Saved (not draft) settings: the server runs with these. */
  saved: LanDashboardSettings;
  /** Called after a new code is saved, to reload settings. */
  onTokenChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<LanDashboardInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.getLanDashboardInfo().then(
        (i) => alive && setInfo(i),
        () => undefined,
      );
    load();
    // The server starts asynchronously after saving: refresh a few times.
    const timer = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [saved.enabled, saved.port, saved.token]);

  const regenerate = async () => {
    setBusy(true);
    try {
      await api.regenerateLanToken();
      onTokenChanged?.();
      toastSuccess(t("New access code created"), t("Devices using the old address need the new one."));
    } catch (e) {
      toastError(e, t("Could not create a new code"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toastSuccess(t("Address copied"));
    } catch (e) {
      toastError(e, t("Could not copy"));
    }
  };

  if (!info) return <p className="text-xs text-muted-foreground">{t("Starting…")}</p>;
  if (info.error) {
    return (
      <p role="alert" className="flex items-start gap-2 text-xs text-critical">
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {t("The dashboard could not start: {{error}}", { error: info.error })} {t("Try another port.")}
        </span>
      </p>
    );
  }
  if (!info.running) return <p className="text-xs text-muted-foreground">{t("Starting…")}</p>;

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3 ring-1 ring-border sm:flex-row">
      {info.qrSvg && (
        <img
          src={`data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}`}
          alt={t("QR code of the dashboard address")}
          className="size-28 shrink-0 self-center rounded-md bg-white p-1.5"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="eyebrow">{t("Access code")}</p>
          <div className="flex items-center gap-2">
            <span className="num text-2xl font-semibold tracking-[0.2em] select-all">{saved.token}</span>
            <Button type="button" size="sm" variant="ghost" onClick={regenerate} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
              {t("New code")}
            </Button>
          </div>
        </div>
        <ul className="flex flex-col gap-1" aria-label={t("Dashboard addresses")}>
          {info.urls.map((u) => (
            <li key={u} className="flex min-w-0 items-center gap-1">
              <code className="num min-w-0 flex-1 truncate text-xs select-all" title={u}>
                {u}
              </code>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => copy(u)} aria-label={t("Copy address")}>
                <Copy aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground">
          <Tv className="mt-px size-3 shrink-0" aria-hidden />
          {t("On a TV: open the browser (built-in on webOS; on Android TV e.g. TV Bro) and type the address.")}
        </p>
      </div>
    </div>
  );
}
