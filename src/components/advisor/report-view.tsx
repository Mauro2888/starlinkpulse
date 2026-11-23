import { useTranslation } from "react-i18next";
import { tk } from "@/i18n/keys";
import { formatDateTime } from "@/lib/format";
import { useId, useState, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  Cpu,
  Info,
  ListChecks,
  OctagonAlert,
  PlugZap,
  RefreshCw,
  Satellite,
  Settings2,
  Sparkles,
  TreePine,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import type { AiFinding, AiFindingCategory, AiOverallHealth, AiReport, AiSeverity, ReportSource } from "@/types/models";
import { groupFindings, SEVERITY_LABELS, SOURCE_LABELS } from "@/lib/advisor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const CATEGORY: Record<AiFindingCategory, { label: string; icon: ReactNode }> = {
  wifi: { label: tk("Wi-Fi"), icon: <Wifi /> },
  obstruction: { label: tk("Obstructions"), icon: <TreePine /> },
  starlink_network: { label: tk("Starlink network"), icon: <Satellite /> },
  hardware: { label: tk("Hardware"), icon: <Cpu /> },
  power: { label: tk("Power"), icon: <PlugZap /> },
  configuration: { label: tk("Setup & alignment"), icon: <Settings2 /> },
};

const HEALTH: Record<AiOverallHealth, { label: string; icon: ReactNode; cls: string }> = {
  good: { label: tk("Healthy"), icon: <CircleCheck />, cls: "text-good ring-good/40 bg-good/10" },
  fair: { label: tk("Needs attention"), icon: <TriangleAlert />, cls: "text-warning ring-warning/40 bg-warning/10" },
  poor: { label: tk("Poor"), icon: <OctagonAlert />, cls: "text-critical ring-critical/40 bg-critical/10" },
};

const SEVERITY_ICON: Record<AiSeverity, { icon: ReactNode; cls: string }> = {
  critical: { icon: <OctagonAlert />, cls: "text-critical" },
  warning: { icon: <TriangleAlert />, cls: "text-warning" },
  info: { icon: <Info />, cls: "text-primary" },
};

export function HealthBadge({ health }: { health: AiOverallHealth }) {
  const { t } = useTranslation();
  const h = HEALTH[health] ?? HEALTH.fair;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 [&_svg]:size-3.5",
        h.cls,
      )}
    >
      <span aria-hidden>{h.icon}</span>
      <span className="text-foreground">{t("Overall: {{health}}", { health: t(h.label) })}</span>
    </span>
  );
}

const SOURCE_ICON: Record<ReportSource, ReactNode> = {
  rules: <ListChecks />,
  claude: <Sparkles />,
  local: <Cpu />,
};

export function SourceBadge({ source }: { source: ReportSource }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/70 px-2.5 text-xs text-muted-foreground ring-1 ring-border [&_svg]:size-3.5">
      <span aria-hidden>{SOURCE_ICON[source] ?? <Sparkles />}</span>
      <span>
        <span className="sr-only">{t("Source:")} </span>
        {SOURCE_LABELS[source] ? t(SOURCE_LABELS[source]) : source}
      </span>
    </span>
  );
}

interface Props {
  /** Full-width layout: findings flow into two columns from 1200 px. */
  wide?: boolean;
  /** Shows an "Open Sky view" link on obstruction findings. */
  onOpenSkyView?: () => void;
  report: AiReport;
  onRerun?: () => void;
  rerunDisabled?: boolean;
}

export function ReportView({ report, onRerun, rerunDisabled, onOpenSkyView, wide = false }: Props) {
  const groups = groupFindings(report.findings);
  const { t } = useTranslation();
  const generated = formatDateTime(report.generatedAtMs);

  return (
    <article className="flex flex-col gap-3" aria-labelledby="report-headline">
      <header className="rounded-xl bg-card p-4 ring-1 ring-border">
        <div className="flex flex-wrap items-center gap-2">
          <HealthBadge health={report.overallHealth} />
          <SourceBadge source={report.source} />
        </div>
        <h2 id="report-headline" className="mt-2.5 text-base leading-snug font-semibold text-balance">
          {report.headline}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {report.findings.length === 0
            ? t("No findings.")
            : t("{{count}} findings from the last {{hours}} hours.", {
                count: report.findings.length,
                hours: report.payload.windowHours,
              })}
        </p>
      </header>

      {groups.map((g) => (
        <section key={g.severity} aria-labelledby={`sev-${g.severity}`} data-testid={`group-${g.severity}`}>
          <h3 id={`sev-${g.severity}`} className="eyebrow mb-2 flex items-center gap-1.5 px-1">
            <span aria-hidden className={cn("[&_svg]:size-3.5", SEVERITY_ICON[g.severity].cls)}>
              {SEVERITY_ICON[g.severity].icon}
            </span>
            {t(SEVERITY_LABELS[g.severity])}
            <span className="num">· {g.findings.length}</span>
          </h3>
          <ul
            className={cn(
              "flex flex-col gap-2",
              // Two columns of equal-height cards; an odd last card spans both so the row is full.
              wide && "dash3:grid dash3:grid-cols-2 dash3:[&>li:last-child:nth-child(odd)]:col-span-2 [&>li>div]:h-full",
            )}
          >
            {g.findings.map((f, i) => (
              <li key={`${f.title}-${i}`}>
                <FindingCard finding={f} onOpenSkyView={onOpenSkyView} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <footer className="flex flex-wrap items-center justify-between gap-2 px-1 text-[0.6875rem] text-muted-foreground">
        <span>
          {report.source === "rules" ? (
            t("Generated {{date}} by the built-in rules, on this computer", { date: generated })
          ) : report.source === "local" ? (
            t("Generated {{date}} by {{model}} (local model)", { date: generated, model: report.model })
          ) : (
            t("Generated {{date}} by {{model}}", { date: generated, model: report.model })
          )}
        </span>
        {onRerun && (
          <Button size="sm" variant="outline" onClick={onRerun} disabled={rerunDisabled}>
            <RefreshCw aria-hidden /> {report.source === "rules" ? t("Run again") : t("Explain again")}
          </Button>
        )}
      </footer>
    </article>
  );
}

function FindingCard({ finding, onOpenSkyView }: { finding: AiFinding; onOpenSkyView?: () => void }) {
  const { t } = useTranslation();
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
        {t(cat.label)}
      </div>
      <h4 className="mt-1 text-sm font-medium">{finding.title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>
      {finding.actions.length > 0 && (
        <fieldset className="mt-2.5">
          <legend className="sr-only">{t("What to do")}</legend>
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
      {finding.category === "obstruction" && onOpenSkyView && (
        <Button size="xs" variant="ghost" className="mt-2 -ml-1.5 text-primary" onClick={onOpenSkyView}>
          <TreePine aria-hidden /> {t("Open Sky view")}
        </Button>
      )}
    </div>
  );
}
