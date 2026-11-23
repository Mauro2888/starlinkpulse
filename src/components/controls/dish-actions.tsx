import { useTranslation } from "react-i18next";
import { tr } from "@/i18n";
import { tk } from "@/i18n/keys";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Lock, Power, Snowflake } from "lucide-react";
import type { DishCapabilities, SnowMeltMode } from "@/types/models";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Section } from "@/components/state-panels";

export type DishAction =
  | { type: "reboot" }
  | { type: "stow" }
  | { type: "unstow" }
  | { type: "snow_melt"; mode: SnowMeltMode };

export const SNOW_MELT_LABELS: Record<SnowMeltMode, string> = {
  auto: tk("Automatic"),
  always_on: tk("Always on"),
  always_off: tk("Off"),
};

function confirmCopy(a: DishAction): { title: string; body: string; cta: string; destructive: boolean } {
  switch (a.type) {
    case "reboot":
      return {
        title: tr("Reboot the dish?"),
        body: tr("Your internet connection will drop for about 1 to 3 minutes while the dish restarts and finds satellites again."),
        cta: tr("Reboot"),
        destructive: true,
      };
    case "stow":
      return {
        title: tr("Stow the dish?"),
        body: tr("The dish will tilt flat into its storage position. Internet stops until you unstow it."),
        cta: tr("Stow"),
        destructive: true,
      };
    case "unstow":
      return {
        title: tr("Unstow the dish?"),
        body: tr("The dish will move back to its working position and reconnect. This takes a minute or two."),
        cta: tr("Unstow"),
        destructive: false,
      };
    case "snow_melt":
      return {
        title: tr("Set snow melt to {{mode}}?", { mode: tr(SNOW_MELT_LABELS[a.mode]) }),
        body:
          a.mode === "always_on"
            ? tr("The dish will heat continuously and draw noticeably more power, even when there is no snow.")
            : a.mode === "always_off"
              ? tr("The dish will never heat. Snow or ice can build up and interrupt service.")
              : tr("The dish will heat only when it detects snow or ice."),
        cta: tr("Apply"),
        destructive: a.mode === "always_on",
      };
  }
}

interface DishActionsProps {
  capabilities: DishCapabilities | null;
  readOnly: boolean;
  linkUp: boolean;
  onRun: (action: DishAction) => Promise<void>;
  onOpenSettings?: () => void;
}

export function DishActions({ capabilities, readOnly, linkUp, onRun, onOpenSettings }: DishActionsProps) {
  const [pending, setPending] = useState<DishAction | null>(null);
  const [busy, setBusy] = useState<DishAction["type"] | null>(null);
  const currentSnow = capabilities?.snowMeltMode ?? null;
  const [snowMode, setSnowMode] = useState<SnowMeltMode>(currentSnow ?? "auto");
  // Follow the dish when its reported mode changes (e.g. after Apply).
  useEffect(() => {
    if (currentSnow) setSnowMode(currentSnow);
  }, [currentSnow]);
  const snowChanged = currentSnow === null || snowMode !== currentSnow;

  const caps = capabilities;
  const none = caps && !caps.canReboot && !caps.canStow && !caps.canSetSnowMelt;
  const { t } = useTranslation();
  const lockReason = readOnly ? t("Read-only mode is on") : !linkUp ? t("The dish is not connected") : null;
  const disabled = Boolean(lockReason) || busy !== null;

  const run = async (a: DishAction) => {
    setBusy(a.type);
    try {
      await onRun(a);
    } finally {
      setBusy(null);
    }
  };

  const copy = pending ? confirmCopy(pending) : null;

  return (
    <Section title={t("Dish controls")} id="dish-controls">
      {!caps ? (
        <p className="text-sm text-muted-foreground">{t("Controls appear once the dish reports what it supports.")}</p>
      ) : none ? (
        <p className="text-sm text-muted-foreground">{t("This dish does not expose any remote controls.")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {lockReason && (
            <div className="flex items-start gap-2.5 rounded-lg bg-muted/60 px-3 py-2 text-xs" role="note" id="controls-lock">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <p className="flex-1 leading-relaxed text-muted-foreground">
                {readOnly ? (
                  <>
                    <span className="font-medium text-foreground">{t("Read-only mode is on.")}</span>{" "}
                    {t("Controls are locked so nothing changes on the dish by accident.")}
                    {onOpenSettings && (
                      <>
                        {" "}
                        <button
                          type="button"
                          onClick={onOpenSettings}
                          className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2"
                        >
                          {t("Turn it off in Settings")}
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>{t("Controls are available when the dish is connected.")}</>
                )}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {caps.canReboot && (
              <ActionButton
                icon={<Power />}
                label={t("Reboot dish")}
                hint={t("Restart the dish. About 2 minutes offline.")}
                disabled={disabled}
                locked={Boolean(lockReason)}
                busy={busy === "reboot"}
                onClick={() => setPending({ type: "reboot" })}
              />
            )}
            {caps.canStow && (
              <>
                <ActionButton
                  icon={<ArrowDownToLine />}
                  label={t("Stow")}
                  hint={t("Lay the dish flat for transport or storms.")}
                  disabled={disabled}
                  locked={Boolean(lockReason)}
                  busy={busy === "stow"}
                  onClick={() => setPending({ type: "stow" })}
                />
                <ActionButton
                  icon={<ArrowUpFromLine />}
                  label={t("Unstow")}
                  hint={t("Return to working position.")}
                  disabled={disabled}
                  locked={Boolean(lockReason)}
                  busy={busy === "unstow"}
                  onClick={() => setPending({ type: "unstow" })}
                />
              </>
            )}
          </div>

          {caps.canSetSnowMelt && (
            <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5 ring-1 ring-border">
              <div className="flex items-center justify-between gap-2">
                <span id="snow-melt-label" className="flex items-center gap-1.5 text-xs font-medium">
                  <Snowflake className="size-3.5 text-muted-foreground" aria-hidden /> {t("Snow melt")}
                </span>
                <span id="snow-melt-current" className="text-xs text-muted-foreground">
                  {t("Current:")}{" "}
                  <span className="font-medium text-foreground">
                    {currentSnow ? t(SNOW_MELT_LABELS[currentSnow]) : t("unknown")}
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select value={snowMode} onValueChange={(v) => setSnowMode(v as SnowMeltMode)} disabled={disabled}>
                  <SelectTrigger
                    id="snow-melt-trigger"
                    size="sm"
                    aria-labelledby="snow-melt-new-label snow-melt-trigger"
                    className="min-w-0 flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SNOW_MELT_LABELS) as SnowMeltMode[]).map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(SNOW_MELT_LABELS[m])}
                        {m === currentSnow ? ` (${t("current")})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span id="snow-melt-new-label" className="sr-only">
                  {t("New snow melt mode")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || !snowChanged}
                  aria-describedby={lockReason ? "controls-lock" : "snow-melt-current"}
                  onClick={() => setPending({ type: "snow_melt", mode: snowMode })}
                >
                  {busy === "snow_melt" && <Loader2 className="animate-spin" aria-hidden />}
                  {t("Apply")}
                </Button>
              </div>
              {!lockReason && !snowChanged && (
                <p className="text-[0.6875rem] text-muted-foreground">{t("Pick a different mode to change it.")}</p>
              )}
            </div>
          )}
        </div>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent className="bg-popover">
          {copy && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.title}</AlertDialogTitle>
                <AlertDialogDescription>{copy.body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant={copy.destructive ? "destructive" : "default"}
                  onClick={() => {
                    const a = pending;
                    setPending(null);
                    if (a) void run(a);
                  }}
                >
                  {copy.cta}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

function ActionButton({
  icon,
  label,
  hint,
  disabled,
  locked,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  disabled: boolean;
  locked: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto justify-start gap-2.5 px-3 py-2 text-left whitespace-normal"
      disabled={disabled}
      aria-describedby={locked ? "controls-lock" : undefined}
      onClick={onClick}
    >
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-muted [&_svg]:size-3.5">
        {busy ? <Loader2 className="animate-spin" /> : icon}
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs font-normal text-muted-foreground">{hint}</span>
      </span>
    </Button>
  );
}
