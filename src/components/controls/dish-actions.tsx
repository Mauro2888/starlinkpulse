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
import { Group, Row } from "@/components/controls/settings-ui";

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
}

export function DishActions({ capabilities, readOnly, linkUp, onRun }: DishActionsProps) {
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
    <>
    <Group title={t("Dish controls")} id="dish-controls">
      {!caps ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("Controls appear once the dish reports what it supports.")}</p>
      ) : none ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("This dish does not expose any remote controls.")}</p>
      ) : (
        <>
          {lockReason && (
            <div className="flex items-start gap-2.5 bg-muted/40 px-4 py-3 text-xs" role="note" id="controls-lock">
              <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <p className="flex-1 leading-relaxed text-muted-foreground">
                {readOnly ? (
                  <>
                    <span className="font-medium text-foreground">{t("Read-only mode is on.")}</span>{" "}
                    {t("Controls are locked so nothing changes on the dish by accident.")}
                  </>
                ) : (
                  <>{t("Controls are available when the dish is connected.")}</>
                )}
              </p>
            </div>
          )}

          {caps.canStow && (
            <>
              <ActionRow
                label={t("Stow")}
                hint={t("Lay the dish flat for transport or storms.")}
                disabled={disabled}
                locked={Boolean(lockReason)}
                busy={busy === "stow"}
                icon={<ArrowDownToLine aria-hidden />}
                onClick={() => setPending({ type: "stow" })}
              />
              <ActionRow
                label={t("Unstow")}
                hint={t("Return to working position.")}
                disabled={disabled}
                locked={Boolean(lockReason)}
                busy={busy === "unstow"}
                icon={<ArrowUpFromLine aria-hidden />}
                onClick={() => setPending({ type: "unstow" })}
              />
            </>
          )}

          {caps.canSetSnowMelt && (
            <Row
              label={
                <span id="snow-melt-label" className="flex items-center gap-1.5">
                  <Snowflake className="size-3.5 text-muted-foreground" aria-hidden /> {t("Snow melt")}
                </span>
              }
              description={
                <>
                  <span id="snow-melt-current">
                    {t("Current:")}{" "}
                    <span className="font-medium text-foreground">
                      {currentSnow ? t(SNOW_MELT_LABELS[currentSnow]) : t("unknown")}
                    </span>
                  </span>
                  {!lockReason && !snowChanged && (
                    <>
                      {" · "}
                      {t("Pick a different mode to change it.")}
                    </>
                  )}
                </>
              }
            >
              <div className="flex items-center gap-2">
                <Select value={snowMode} onValueChange={(v) => setSnowMode(v as SnowMeltMode)} disabled={disabled}>
                  <SelectTrigger
                    id="snow-melt-trigger"
                    size="sm"
                    aria-labelledby="snow-melt-new-label snow-melt-trigger"
                    className="w-36"
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
            </Row>
          )}

          {caps.canReboot && (
            <ActionRow
              label={t("Reboot dish")}
              hint={t("Restart the dish. About 2 minutes offline.")}
              buttonText={t("Reboot")}
              destructive
              disabled={disabled}
              locked={Boolean(lockReason)}
              busy={busy === "reboot"}
              icon={<Power aria-hidden />}
              onClick={() => setPending({ type: "reboot" })}
            />
          )}
        </>
      )}
    </Group>

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
    </>
  );
}

function ActionRow({
  label,
  hint,
  buttonText,
  destructive,
  icon,
  disabled,
  locked,
  busy,
  onClick,
}: {
  label: string;
  hint: string;
  /** Visible button text; defaults to the label. The label stays the accessible name. */
  buttonText?: string;
  destructive?: boolean;
  icon: ReactNode;
  disabled: boolean;
  locked: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Row label={label} description={hint}>
      <Button
        variant="outline"
        size="sm"
        className={destructive ? "text-critical hover:text-critical" : undefined}
        disabled={disabled}
        aria-label={label}
        aria-describedby={locked ? "controls-lock" : undefined}
        onClick={onClick}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : icon}
        {buttonText ?? label}
      </Button>
    </Row>
  );
}
