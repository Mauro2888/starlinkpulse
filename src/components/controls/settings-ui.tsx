import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Grouped-list building blocks for the Controls tab: a Group is a titled card of Rows,
 * a Row is label + short description on the left and a control on the right.
 */
export function Group({
  title,
  footer,
  children,
  className,
  id,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={title ? titleId : undefined} id={id} className={cn("flex flex-col gap-1.5", className)}>
      {title && (
        <h3 id={titleId} className="px-1 text-xs font-medium text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-border">{children}</div>
      {footer && <div className="px-1 text-[0.6875rem] leading-relaxed text-muted-foreground">{footer}</div>}
    </div>
  );
}

export function Row({
  label,
  htmlFor,
  description,
  descId,
  tone,
  wide,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  descId?: string;
  tone?: "error";
  /** Stack label above the control on narrow widths and give the control a fixed width. */
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-x-6 gap-y-2 px-4 py-3",
        wide ? "flex-col sm:flex-row sm:items-start sm:justify-between" : "items-start justify-between",
      )}
    >
      <div className="min-w-0 flex-1">
        {label && (
          <Label htmlFor={htmlFor} className="text-sm">
            {label}
          </Label>
        )}
        {(description || descId) && (
          <p id={descId} className={cn("mt-0.5 text-xs", tone === "error" ? "text-critical" : "text-muted-foreground")}>
            {description}
          </p>
        )}
      </div>
      {children !== undefined && <div className={cn("shrink-0", wide && "w-full sm:w-56")}>{children}</div>}
    </div>
  );
}

export interface FieldA11y {
  id: string;
  "aria-describedby": string;
  "aria-invalid"?: true;
}

/** A labelled input row; the hint is replaced by the error message when there is one. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: FieldA11y) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <Row wide label={label} htmlFor={id} descId={descId} description={error ?? hint} tone={error ? "error" : undefined}>
      {children({ id, "aria-describedby": descId, ...(error ? { "aria-invalid": true as const } : {}) })}
    </Row>
  );
}
