import { useState } from "react";
import { Lock, MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionStatus, DishCapabilities } from "@/types/models";
import { cn } from "@/lib/utils";
import { dishModelName } from "@/lib/dish";
import { tk } from "@/i18n/keys";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LocationDialog } from "@/components/locations/location-dialog";

const STATE_META = {
  connected: { label: tk("Connected"), dot: "bg-good", text: "text-foreground", pulse: true },
  mock: { label: tk("Mock data"), dot: "bg-primary", text: "text-foreground", pulse: true },
  connecting: { label: tk("Connecting"), dot: "bg-warning", text: "text-foreground", pulse: true },
  offline: { label: tk("Offline"), dot: "bg-critical", text: "text-foreground", pulse: false },
} as const;

export function ConnectionBadge({ status }: { status: ConnectionStatus | null }) {
  const { t } = useTranslation();
  const meta = status ? STATE_META[status.state] : STATE_META.connecting;
  const label = t(meta.label);
  const detail = !status
    ? t("Starting up")
    : status.state === "mock"
      ? t("Showing simulated data, not your dish")
      : status.state === "offline"
        ? (status.lastError ?? t("No answer from {{address}}", { address: status.dishAddress }))
        : status.state === "connecting"
          ? t("Contacting {{address}}", { address: status.dishAddress })
          : t("Live from {{address}}", { address: status.dishAddress });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="status"
          aria-label={t("Connection: {{state}}. {{detail}}", { state: label, detail })}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/70 px-2.5 text-xs font-medium ring-1 ring-border",
            "focus-visible:outline-2 focus-visible:outline-offset-2",
            meta.text,
          )}
        >
          <span className="relative grid size-2 place-items-center" aria-hidden>
            {meta.pulse && <span className={cn("pulse-ring absolute inset-0 rounded-full", meta.dot)} />}
            <span className={cn("relative size-2 rounded-full", meta.dot)} />
          </span>
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

/** Small orbit mark: a dish arc and a satellite on its path. */
function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 text-primary" aria-hidden fill="none">
      <path d="M3 17a12 12 0 0 1 18 0" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 17a7 7 0 0 1 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="18.5" cy="8" r="1.75" fill="currentColor" />
      <path d="M12 17v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Header chip showing the current location tag; opens the location manager. */
function LocationChip({ location }: { location: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={location ? t("Location: {{name}}. Change location", { name: location }) : t("Set location")}
        className={cn(
          "inline-flex h-6 max-w-32 items-center gap-1 rounded-full px-2 text-xs ring-1 ring-border hover:bg-muted/60 focus-visible:outline-2 sm:max-w-48",
          location ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <MapPin className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{location ?? t("No location")}</span>
      </button>
      {open && <LocationDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

export function AppHeader({
  connection,
  capabilities,
  readOnly,
  location,
}: {
  connection: ConnectionStatus | null;
  capabilities: DishCapabilities | null;
  readOnly: boolean | null;
  /** Active location tag; undefined hides the chip (settings not loaded). */
  location?: string | null;
}) {
  const { t } = useTranslation();
  const model = dishModelName(capabilities);
  return (
    <header className="flex items-center gap-2 px-1">
      <LogoMark />
      <div className="min-w-0 flex-1">
        <h1 className="text-sm leading-tight font-semibold tracking-tight">StarlinkPulse</h1>
        <p className="truncate text-xs leading-tight text-muted-foreground">
          {model ?? t("Dish model unknown")}
          {capabilities?.softwareVersion && (
            <span className="hidden sm:inline"> · fw {capabilities.softwareVersion}</span>
          )}
        </p>
      </div>
      {location !== undefined && <LocationChip location={location} />}
      {readOnly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="img"
              aria-label={t("Read-only mode is on")}
              className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground ring-1 ring-border focus-visible:outline-2"
            >
              <Lock className="size-3" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("Read-only: dish controls are locked")}</TooltipContent>
        </Tooltip>
      )}
      <ConnectionBadge status={connection} />
    </header>
  );
}
