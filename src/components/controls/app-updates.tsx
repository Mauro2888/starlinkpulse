import { useState } from "react";
import { CircleCheck, Download, Loader2, RefreshCw } from "lucide-react";
import type { UpdateInfo } from "@/types/models";
import { api } from "@/lib/api";
import { toastError, toastSuccess } from "@/lib/notify";
import { normalizeError } from "@/lib/errors";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Current version, manual update check and install (with confirmation). */
export function AppUpdates() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      setInfo(await api.checkForUpdate());
    } catch (e) {
      toastError(e, tr("Couldn't check for updates"));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await api.installUpdate();
      // In the desktop app the process restarts; this toast is only seen if it doesn't.
      toastSuccess(tr("Update installed"), tr("StarlinkPulse is restarting."));
    } catch (e) {
      toastError(e, tr("Update failed"));
    } finally {
      setInstalling(false);
    }
  };

  const openReleases = async () => {
    try {
      await api.openReleasesPage();
    } catch (e) {
      const err = normalizeError(e);
      if (err.kind === "invalid_input") toast.info(tr("Releases page not configured in this build"));
      else toastError(err, tr("Couldn't open the releases page"));
    }
  };

  const version = info?.currentVersion ?? __APP_VERSION__;


  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3 ring-1 ring-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {t("Version")} <span className="num">{version}</span>
        </p>
        {info?.updaterConfigured !== false && (
          <Button type="button" size="sm" variant="outline" onClick={check} disabled={checking || installing}>
            {checking ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {t("Check for updates")}
          </Button>
        )}
      </div>

      {info && !info.updaterConfigured && (
        <p className="text-xs text-muted-foreground">
          {t("Updates: download new versions from")}{" "}
          <button
            type="button"
            onClick={() => void openReleases()}
            className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2"
          >
            {t("GitHub Releases")}
          </button>
          .
        </p>
      )}

      {/* The only live region: a single status line, always mounted so changes are announced. */}
      <p role="status" aria-live="polite" className={cn("flex items-center gap-1.5 empty:hidden", info?.available ? "text-sm font-medium" : "text-xs text-muted-foreground")}>
        {checking && !info ? t("Checking for updates…") : null}
        {installing ? t("Installing update…") : null}
        {info && !info.updaterConfigured ? t("This build can't update itself.") : null}
        {!installing && info?.updaterConfigured && !info.available && (
          <>
            <CircleCheck className="size-3.5 text-good" aria-hidden /> {t("You're up to date.")}
          </>
        )}
        {!installing && info?.updaterConfigured && info.available && (
          <>
            {t("Version {{version}} is available", { version: info.latestVersion })}
          </>
        )}
      </p>

      {info?.updaterConfigured && info.available && (
        <div className="flex flex-col gap-2">
          {info.notes && (
            <div className="max-h-32 overflow-y-auto rounded-md bg-background/50 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
              {info.notes}
            </div>
          )}
          <div>
            <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={installing}>
              {installing ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              {installing ? t("Installing…") : t("Install and restart")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Install version {{version}} and restart?", { version: info?.latestVersion })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("StarlinkPulse downloads the update, checks its signature, installs it and restarts. Monitoring pauses for a few seconds. Your settings and history are kept.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Not now")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void install()}>{t("Install and restart")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
