import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "critical";
  className?: string;
}

/** Centered empty / error / waiting state used inside cards and tabs. */
export function StatePanel({ icon, title, children, action, tone = "neutral", className }: PanelProps) {
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg px-6 py-8 text-center",
        "bg-card/60 ring-1 ring-border ring-inset",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1 grid size-9 place-items-center rounded-full bg-muted [&_svg]:size-4.5",
          tone === "critical" ? "text-critical" : "text-muted-foreground",
        )}
        aria-hidden
      >
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children && <div className="max-w-xs text-xs leading-relaxed text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Thin inline banner for page-level conditions (offline, mock, stale). */
export function Banner({
  icon,
  title,
  children,
  tone = "neutral",
  action,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: "neutral" | "warning" | "critical";
  action?: ReactNode;
}) {
  const bar = { neutral: "before:bg-primary/70", warning: "before:bg-warning", critical: "before:bg-critical" }[tone];
  const iconCls = { neutral: "text-primary", warning: "text-warning", critical: "text-critical" }[tone];
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      className={cn(
        "relative flex items-start gap-2.5 overflow-hidden rounded-lg bg-card py-2.5 pr-3 pl-4 ring-1 ring-border",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        bar,
      )}
    >
      <span aria-hidden className={cn("mt-0.5 [&_svg]:size-4", iconCls)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {children && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Card section with an eyebrow heading. */
export function Section({
  title,
  aside,
  children,
  className,
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("rounded-xl bg-card p-3.5 ring-1 ring-border", className)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={headingId} className="eyebrow">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
