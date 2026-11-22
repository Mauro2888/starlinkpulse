import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, isTauri } from "@/lib/api";
import { historyToCsv } from "@/lib/history";
import { isLinkUp } from "@/lib/dish";
import { toastError, toastSuccess } from "@/lib/notify";
import { useApiKey, useCapabilities, useConnection, useSettings } from "@/hooks/use-pulse";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Section, StatePanel } from "@/components/state-panels";
import { DishActions, SNOW_MELT_LABELS, type DishAction } from "@/components/controls/dish-actions";
import { SettingsForm } from "@/components/controls/settings-form";
import { ApiKeyCard } from "@/components/controls/api-key-card";
import { AlertCircle } from "lucide-react";

const READ_ONLY_SWITCH_ID = "read-only-switch";

async function runAction(a: DishAction): Promise<void> {
  try {
    switch (a.type) {
      case "reboot":
        await api.rebootDish();
        toastSuccess("Reboot sent", "The dish will be offline for 1–2 minutes.");
        break;
      case "stow":
        await api.stowDish();
        toastSuccess("Stowing dish");
        break;
      case "unstow":
        await api.unstowDish();
        toastSuccess("Unstowing dish");
        break;
      case "snow_melt":
        await api.setSnowMelt(a.mode);
        toastSuccess(`Snow melt set to ${SNOW_MELT_LABELS[a.mode]}`);
        break;
    }
  } catch (e) {
    toastError(e, "Action failed");
  }
}

export function ControlsTab() {
  const caps = useCapabilities();
  const connection = useConnection();
  const { settings, error, save } = useSettings();
  const key = useApiKey();

  const focusReadOnly = () => {
    const el = document.getElementById(READ_ONLY_SWITCH_ID);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.focus();
  };

  return (
    <div className="grid gap-3 md:grid-cols-2 md:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <DishActions
          capabilities={caps}
          readOnly={settings?.readOnly ?? true}
          linkUp={isLinkUp(connection?.state)}
          onRun={runAction}
          onOpenSettings={focusReadOnly}
        />
        {settings?.aiProvider === "claude" && (
        <ApiKeyCard
          hasKey={key.hasKey}
          error={key.error?.message ?? null}
          onSave={async (k) => {
            try {
              await key.save(k);
              toastSuccess("API key saved");
            } catch (e) {
              toastError(e, "Could not save key");
              throw e;
            }
          }}
          onDelete={async () => {
            try {
              await key.remove();
              toastSuccess("API key deleted");
            } catch (e) {
              toastError(e, "Could not delete key");
            }
          }}
        />
        )}
        <ExportCard />
      </div>
      <div className="min-w-0">
        {settings ? (
          <SettingsForm
            settings={settings}
            readOnlySwitchId={READ_ONLY_SWITCH_ID}
            onSave={async (next) => {
              try {
                await save(next);
                toastSuccess("Settings saved");
              } catch (e) {
                toastError(e, "Settings not saved");
              }
            }}
          />
        ) : error ? (
          <StatePanel tone="critical" icon={<AlertCircle />} title="Settings unavailable">
            {error.message}
          </StatePanel>
        ) : (
          <Skeleton className="h-96 rounded-xl" />
        )}
      </div>
    </div>
  );
}

function downloadInBrowser(points: Awaited<ReturnType<typeof api.getHistory>>): void {
  const blob = new Blob([historyToCsv(points)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `starlinkpulse-history-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try {
      if (isTauri()) {
        // Native save dialog; null means the user cancelled, so say nothing.
        const path = await api.exportHistoryCsv(2880);
        if (path) toastSuccess("History exported", `Saved to ${path}`);
        return;
      }
      // Browser dev mode only: build the file client-side.
      const points = await api.getHistory(2880);
      if (points.length === 0) {
        toast.info("No history to export yet", { description: "History builds up while the app runs." });
        return;
      }
      downloadInBrowser(points);
      toastSuccess("CSV downloaded", `${points.length} minutes of history.`);
    } catch (e) {
      toastError(e, "Export failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Data">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Per-minute history of the last 48 hours as CSV.</p>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
          Export CSV
        </Button>
      </div>
    </Section>
  );
}
