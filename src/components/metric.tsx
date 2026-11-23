import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import { cn } from "@/lib/utils";
import { EM_DASH, type ValueParts } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const NOT_REPORTED = tk("Not reported by this dish or firmware");

/** Renders a value + unit. A missing value becomes a focusable dash with a tooltip. */
export function Reading({
  parts,
  size = "md",
  missingHint = NOT_REPORTED,
  className,
}: {
  parts: ValueParts;
  size?: "sm" | "md" | "lg";
  missingHint?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const valueCls = {
    sm: "text-sm",
    md: "text-xl",
    lg: "text-[2rem] leading-none tracking-tight",
  }[size];
  const unitCls = { sm: "text-xs", md: "text-xs", lg: "text-sm" }[size];

  if (parts.value === EM_DASH) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn("num cursor-help rounded-sm text-muted-foreground focus-visible:outline-2", valueCls, className)}
          >
            <span aria-hidden>{EM_DASH}</span>
            <span className="sr-only">
              {t("No data.")} {t(missingHint)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t(missingHint)}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span className={cn("num font-medium text-foreground", valueCls)}>{parts.value}</span>
      {parts.unit && <span className={cn("text-muted-foreground", unitCls)}>{parts.unit}</span>}
    </span>
  );
}

export type StatusTone = "good" | "warning" | "serious" | "critical" | "neutral";

const toneDot: Record<StatusTone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  serious: "bg-serious",
  critical: "bg-critical",
  neutral: "bg-muted-foreground/60",
};

const toneText: Record<StatusTone, string> = {
  good: "text-good",
  warning: "text-warning",
  serious: "text-serious",
  critical: "text-critical",
  neutral: "text-muted-foreground",
};

export function toneTextClass(tone: StatusTone): string {
  return toneText[tone];
}

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", toneDot[tone], className)} />;
}

interface MetricTileProps {
  label: string;
  icon?: ReactNode;
  parts: ValueParts;
  /** One short line under the value (text ink, never status color alone). */
  note?: ReactNode;
  tone?: StatusTone;
  spark?: ReactNode;
  missingHint?: string;
  className?: string;
}

/** Compact stat tile: label, value, optional status note and sparkline. */
export function MetricTile({ label, icon, parts, note, tone, spark, missingHint, className }: MetricTileProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg bg-card px-3 py-2.5 ring-1 ring-border", className)}
    >
      <div className="flex items-center gap-1.5">
        {icon && <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
        <span className="eyebrow truncate">{label}</span>
      </div>
      <Reading parts={parts} missingHint={missingHint} />
      {note && (
        <div className="flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground">
          {tone && <StatusDot tone={tone} />}
          <span className="truncate">{note}</span>
        </div>
      )}
      {spark}
    </div>
  );
}
