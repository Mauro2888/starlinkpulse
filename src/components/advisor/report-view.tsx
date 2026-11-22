import { useId, useState, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  Cpu,
  Info,
  OctagonAlert,
  PlugZap,
  RefreshCw,
  Satellite,
  Settings2,
  TreePine,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import type { AiFinding, AiFindingCategory, AiOverallHealth, AiReport, AiSeverity } from "@/types/models";
import { groupFindings, SEVERITY_LABELS } from "@/lib/advisor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const CATEGORY: Record<AiFindingCategory, { label: string; icon: ReactNode }> = {
  wifi: { label: "Wi-Fi", icon: <Wifi /> },
  obstruction: { label: "Obstructions", icon: <TreePine /> },
  starlink_network: { label: "Starlink network", icon: <Satellite /> },
  hardware: { label: "Hardware", icon: <Cpu /> },
  power: { label: "Power", icon: <PlugZap /> },
  configuration: { label: "Setup & alignment", icon: <Settings2 /> },
};

const HEALTH: Record<AiOverallHealth, { label: string; icon: ReactNode; cls: string }> = {
  good: { label: "Healthy", icon: <CircleCheck />, cls: "text-good ring-good/40 bg-good/10" },
  fair: { label: "Needs attention", icon: <TriangleAlert />, cls: "text-warning ring-warning/40 bg-warning/10" },
  poor: { label: "Poor", icon: <OctagonAlert />, cls: "text-critical ring-critical/40 bg-critical/10" },
};

const SEVERITY_ICON: Record<AiSeverity, { icon: ReactNode; cls: string }> = {
  critical: { icon: <OctagonAlert />, cls: "text-critical" },
  warning: { icon: <TriangleAlert />, cls: "text-warning" },
  info: { icon: <Info />, cls: "text-primary" },
};

export function HealthBadge({ health }: { health: AiOverallHealth }) {
  const h = HEALTH[health] ?? HEALTH.fair;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 [&_svg]:size-3.5",
        h.cls,
      )}
    >
      <span aria-hidden>{h.icon}</span>
      <span className="text-foreground">Overall: {h.label}</span>
    </span>
  );
}

interface Props {
  report: AiReport;
  onRerun?: () => void;
  rerunDisabled?: boolean;
}

export function ReportView({ report, onRerun, rerunDisabled }: Props) {
  const groups = groupFindings(report.findings);
  const generated = new Date(report.generatedAtMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <article className="flex flex-col gap-3" aria-labelledby="report-headline">
      <header className="rounded-xl bg-card p-4 ring-1 ring-border">
        <HealthBadge health={report.overallHealth} />
        <h2 id="report-headline" className="mt-2.5 text-base leading-snug font-semibold text-balance">
          {report.headline}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {report.findings.length === 0
            ? "No findings."
            : `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} from the last ${report.payload.windowHours} hours.`}
        </p>
      </header>

      {groups.map((g) => (
        <section key={g.severity} aria-labelledby={`sev-${g.severity}`} data-testid={`group-${g.severity}`}>
          <h3 id={`sev-${g.severity}`} className="eyebrow mb-2 flex items-center gap-1.5 px-1">
            <span aria-hidden className={cn("[&_svg]:size-3.5", SEVERITY_ICON[g.severity].cls)}>
              {SEVERITY_ICON[g.severity].icon}
            </span>
            {SEVERITY_LABELS[g.severity]}
            <span className="num">· {g.findings.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {g.findings.map((f, i) => (
              <li key={`${f.title}-${i}`}>
                <FindingCard finding={f} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 text-[0.6875rem] text-muted-foreground">
        <span>
          Generated {generated} by <span className="num text-foreground/80">{report.model}</span>
        </span>
        {onRerun && (
          <Button size="sm" variant="outline" onClick={onRerun} disabled={rerunDisabled}>
            <RefreshCw aria-hidden /> Run again
          </Button>
        )}
      </footer>
    </article>
  );
}

function FindingCard({ finding }: { finding: AiFinding }) {
  const cat = CATEGORY[finding.category] ?? { label: finding.category, icon: <CircleAlert /> };
  const sev = SEVERITY_ICON[finding.severity] ?? SEVERITY_ICON.info;
  const [done, setDone] = useState<boolean[]>(() => finding.actions.map(() => false));
  const baseId = useId();

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-card p-3.5 ring-1 ring-border",
        "before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        finding.severity === "critical" ? "before:bg-critical" : finding.severity === "warning" ? "before:bg-warning" : "before:bg-primary/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("[&_svg]:size-3.5", sev.cls)}>
          {cat.icon}
        </span>
        {cat.label}
      </div>
      <h4 className="mt-1 text-sm font-medium">{finding.title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>
      {finding.actions.length > 0 && (
        <fieldset className="mt-2.5">
          <legend className="sr-only">What to do</legend>
          <ul className="flex flex-col gap-1.5">
            {finding.actions.map((a, i) => {
              const id = `${baseId}-a${i}`;
              return (
                <li key={id} className="flex items-start gap-2">
                  <input
                    id={id}
                    type="checkbox"
                    checked={done[i] ?? false}
                    onChange={(e) => setDone((d) => d.map((v, j) => (j === i ? e.target.checked : v)))}
                    className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
                  />
                  <label htmlFor={id} className={cn("text-xs leading-relaxed", done[i] && "text-muted-foreground line-through")}>
                    {a}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </div>
  );
}
