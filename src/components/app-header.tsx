import { Lock } from "lucide-react";
import type { ConnectionStatus, DishCapabilities } from "@/types/models";
import { cn } from "@/lib/utils";
import { dishModelName } from "@/lib/dish";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATE_META = {
  connected: { label: "Connected", dot: "bg-good", text: "text-foreground", pulse: true },
  mock: { label: "Mock data", dot: "bg-primary", text: "text-foreground", pulse: true },
  connecting: { label: "Connecting", dot: "bg-warning", text: "text-foreground", pulse: true },
  offline: { label: "Offline", dot: "bg-critical", text: "text-foreground", pulse: false },
} as const;

export function ConnectionBadge({ status }: { status: ConnectionStatus | null }) {
  const meta = status ? STATE_META[status.state] : STATE_META.connecting;
  const detail = !status
    ? "Starting up"
    : status.state === "mock"
      ? "Showing simulated data, not your dish"
      : status.state === "offline"
        ? (status.lastError ?? `No answer from ${status.dishAddress}`)
        : status.state === "connecting"
          ? `Contacting ${status.dishAddress}`
          : `Live from ${status.dishAddress}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="status"
          aria-label={`Connection: ${meta.label}. ${detail}`}
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
          {meta.label}
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

export function AppHeader({
  connection,
  capabilities,
  readOnly,
}: {
  connection: ConnectionStatus | null;
  capabilities: DishCapabilities | null;
  readOnly: boolean | null;
}) {
  const model = dishModelName(capabilities);
  return (
    <header className="flex items-center gap-2.5 px-1">
      <LogoMark />
      <div className="min-w-0 flex-1">
        <h1 className="text-sm leading-tight font-semibold tracking-tight">StarlinkPulse</h1>
        <p className="truncate text-xs leading-tight text-muted-foreground">
          {model ?? "Dish model unknown"}
          {capabilities?.softwareVersion && (
            <span className="hidden sm:inline"> · fw {capabilities.softwareVersion}</span>
          )}
        </p>
      </div>
      {readOnly && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="img"
              aria-label="Read-only mode is on"
              className="grid size-6 place-items-center rounded-full text-muted-foreground ring-1 ring-border focus-visible:outline-2"
            >
              <Lock className="size-3" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>Read-only: dish controls are locked</TooltipContent>
        </Tooltip>
      )}
      <ConnectionBadge status={connection} />
    </header>
  );
}
