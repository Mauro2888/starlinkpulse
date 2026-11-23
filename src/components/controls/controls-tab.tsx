import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { tr } from "@/i18n";
import { useTranslation } from "react-i18next";
import { api, isTauri } from "@/lib/api";
import { historyToCsv } from "@/lib/history";
import { isLinkUp } from "@/lib/dish";
import { toastError, toastSuccess } from "@/lib/notify";
import {
  useApiKey,
  useCapabilities,
  useConnection,
  useSettings,
} from "@/hooks/use-pulse";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePanel } from "@/components/state-panels";
import { Group, Row } from "@/components/controls/settings-ui";
import {
  DishActions,
  SNOW_MELT_LABELS,
  type DishAction,
} from "@/components/controls/dish-actions";
import { SettingsForm } from "@/components/controls/settings-form";
import { ApiKeyCard } from "@/components/controls/api-key-card";
import { AlertCircle } from "lucide-react";

const READ_ONLY_SWITCH_ID = "read-only-switch";

async function runAction(a: DishAction): Promise<void> {
  try {
    switch (a.type) {
      case "reboot":
        await api.rebootDish();
        toastSuccess(
          tr("Reboot sent"),
          tr("The dish will be offline for 1–2 minutes."),
        );
        break;
      case "stow":
        await api.stowDish();
        toastSuccess(tr("Stowing dish"));
        break;
      case "unstow":
        await api.unstowDish();
        toastSuccess(tr("Unstowing dish"));
        break;
      case "snow_melt":
        await api.setSnowMelt(a.mode);
        toastSuccess(tr("Snow melt set to {{mode}}", { mode: tr(SNOW_MELT_LABELS[a.mode]) }));
        break;
    }
  } catch (e) {
    toastError(e, tr("Action failed"));
  }
}

export function ControlsTab() {
  useTranslation();
  const caps = useCapabilities();
  const connection = useConnection();
  const { settings, error, save } = useSettings();
  const key = useApiKey();

  const dish = (
    <>
      <DishActions
        capabilities={caps}
        readOnly={settings?.readOnly ?? true}
        linkUp={isLinkUp(connection?.state)}
        onRun={runAction}
      />
      <ExportCard />
    </>
  );

  const aiExtra =
    settings?.aiProvider === "claude" ? (
      <ApiKeyCard
        hasKey={key.hasKey}
        error={key.error?.message ?? null}
        onSave={async (k) => {
          try {
            await key.save(k);
            toastSuccess(tr("API key saved"));
          } catch (e) {
            toastError(e, tr("Could not save key"));
            throw e;
          }
        }}
        onDelete={async () => {
          try {
            await key.remove();
            toastSuccess(tr("API key deleted"));
          } catch (e) {
            toastError(e, tr("Could not delete key"));
          }
        }}
      />
    ) : null;

  if (settings) {
    return (
      <SettingsForm
        settings={settings}
        readOnlySwitchId={READ_ONLY_SWITCH_ID}
        dish={dish}
        aiExtra={aiExtra}
        onSave={async (next) => {
          try {
            await save(next);
            toastSuccess(tr("Settings saved"));
          } catch (e) {
            toastError(e, tr("Settings not saved"));
          }
        }}
      />
    );
  }
  return (
    <div className="flex max-w-[680px] flex-col gap-3">
      {error ? (
        <StatePanel tone="critical" icon={<AlertCircle />} title={tr("Settings unavailable")}>
          {error.message}
        </StatePanel>
      ) : (
        <Skeleton className="h-96 rounded-xl" />
      )}
      {dish}
    </div>
  );
}

function downloadInBrowser(
  points: Awaited<ReturnType<typeof api.getHistory>>,
): void {
  const blob = new Blob([historyToCsv(points)], {
    type: "text/csv;charset=utf-8",
  });
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
  useTranslation();
  const [busy, setBusy] = useState(false);
  const exportCsv = async () => {
    setBusy(true);
    try {
      if (isTauri()) {
        // Native save dialog; null means the user cancelled, so say nothing.
        const path = await api.exportHistoryCsv(2880);
        if (path) toastSuccess(tr("History exported"), tr("Saved to {{path}}", { path }));
        return;
      }
      // Browser dev mode only: build the file client-side.
      const points = await api.getHistory(2880);
      if (points.length === 0) {
        toast.info(tr("No history to export yet"), {
          description: tr("History builds up while the app runs."),
        });
        return;
      }
      downloadInBrowser(points);
      toastSuccess(tr("CSV downloaded"), tr("{{count}} minutes of history.", { count: points.length }));
    } catch (e) {
      toastError(e, tr("Export failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title={tr("Data")}>
      <Row label={tr("Export history")} description={tr("Per-minute history of the last 48 hours as CSV.")}>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={busy}>
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          {tr("Export CSV")}
        </Button>
      </Row>
    </Group>
  );
}
