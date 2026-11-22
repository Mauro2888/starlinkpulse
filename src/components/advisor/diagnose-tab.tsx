import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, FlaskConical, History, KeyRound, ListChecks, Loader2, RefreshCw, Settings2, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import type { AiProvider, AiReport, DiagnosticSummary, Settings } from "@/types/models";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { advisorErrorCopy, aiDestination, isInsufficientHistory, privacyNote, SOURCE_LABELS, type AiDestination } from "@/lib/advisor";
import { cn } from "@/lib/utils";
import { formatDurationMs, formatMs, formatPercent } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { useApiKey, useSettings } from "@/hooks/use-pulse";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
import { StatePanel } from "@/components/state-panels";
import { ReportView } from "@/components/advisor/report-view";

interface Props {
  /** AI settings; null while loading. */
  ai: Pick<Settings, "aiProvider" | "localAiUrl"> | null;
  /** Whether a Claude API key is saved (null while checking). Only relevant for Claude. */
  hasKey: boolean | null;
  onOpenApiKey: () => void;
  onOpenAiSettings: () => void;
  onOpenSkyView?: () => void;
}


function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function DiagnoseTab({ ai, hasKey, onOpenApiKey, onOpenAiSettings, onOpenSkyView }: Props) {
  const provider: AiProvider = ai?.aiProvider ?? "off";
  const destination = ai ? aiDestination(ai) : null;
  const aiOn = provider !== "off";

  // Built-in rules report (main content).
  const [rules, setRules] = useState<AiReport | null>(null);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesError, setRulesError] = useState<ApiError | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  // Optional AI explanation (separate section under the rules report).
  const [aiReport, setAiReport] = useState<AiReport | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPhase, setAiPhase] = useState<"idle" | "preparing" | "confirm" | "explaining">("idle");
  const [aiError, setAiError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<DiagnosticSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  const runId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const focus = (el: React.RefObject<HTMLDivElement | null>) => requestAnimationFrame(() => el.current?.focus());

  /** Built-in rules: offline and fast, so no preview is needed. */
  const diagnose = useCallback(async () => {
    setRulesError(null);
    setInsufficient(false);
    setDiagnosing(true);
    try {
      setRules(await api.runDiagnostics());
    } catch (e) {
      const err = normalizeError(e);
      if (err.kind === "insufficient_data") setInsufficient(true);
      else setRulesError(err);
      focus(bodyRef);
    } finally {
      setDiagnosing(false);
    }
  }, []);

  // On open: last rules report (or run the rules now) plus the last AI explanation, if any.
  useEffect(() => {
    let alive = true;
    api
      .getLastRulesReport()
      .then(
        (r) => {
          if (!alive) return;
          if (r) setRules(r);
          else void diagnose();
        },
        () => alive && void diagnose(),
      )
      .finally(() => alive && setRulesLoading(false));
    api.getLastAiReport().then(
      (r) => alive && r && r.source !== "rules" && setAiReport(r),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [diagnose]);

  const failAi = useCallback((e: ApiError) => {
    if (e.kind === "insufficient_data") setInsufficient(true);
    else setAiError(e);
    setAiPhase("idle");
    focus(aiRef);
  }, []);

  const explain = useCallback(async () => {
    setAiError(null);
    setNotice(null);
    if (provider === "claude" && hasKey === false) {
      setAiError(normalizeError({ kind: "no_api_key" }));
      focus(aiRef);
      return;
    }
    setAiPhase("preparing");
    try {
      const p = await api.previewAiPayload();
      if (isInsufficientHistory(p)) {
        setInsufficient(true);
        setAiPhase("idle");
        return;
      }
      setPreview(p);
      setAiPhase("confirm");
    } catch (e) {
      failAi(normalizeError(e));
    }
  }, [provider, hasKey, failAi]);

  const confirm = useCallback(async () => {
    const payload = preview;
    if (!payload) return;
    const id = ++runId.current;
    setPreview(null);
    setStartedAt(Date.now());
    setAiPhase("explaining");
    try {
      // Send exactly what the user saw in the preview.
      const r = await api.analyzeNetworkWithAi(payload);
      if (id !== runId.current) return;
      setAiReport(r);
      setAiOpen(true);
      setAiPhase("idle");
      focus(aiRef);
    } catch (e) {
      if (id !== runId.current) return;
      failAi(normalizeError(e));
    }
  }, [failAi, preview]);

  const stopWaiting = () => {
    runId.current++;
    setAiPhase("idle");
    focus(aiRef);
    setNotice("Stopped waiting. If the explanation still finishes, it will appear here next time you open this tab.");
  };

  const aiBusy = aiPhase === "preparing" || aiPhase === "explaining";

  let main;
  if (diagnosing && !rules) {
    main = (
      <StatePanel icon={<Loader2 className="animate-spin motion-reduce:animate-none" />} title="Checking the last 24 hours">
        Running the built-in checks on this computer.
      </StatePanel>
    );
  } else if (rulesLoading && !rules) {
    main = <Skeleton className="h-48 rounded-xl" />;
  } else if (insufficient) {
    main = (
      <StatePanel
        icon={<History />}
        title="Not enough history yet"
        action={
          <Button size="sm" variant="outline" onClick={diagnose}>
            <RefreshCw aria-hidden /> Check again
          </Button>
        }
      >
        Diagnose needs at least an hour of measurements to find patterns. Keep StarlinkPulse running, then try again.
      </StatePanel>
    );
  } else if (rulesError) {
    main = (
      <ErrorPanel
        error={rulesError}
        provider="off"
        hasReport={Boolean(rules)}
        onRetry={diagnose}
        onOpenApiKey={onOpenApiKey}
        onOpenAiSettings={onOpenAiSettings}
        onShowReport={() => setRulesError(null)}
      />
    );
  } else if (rules) {
    main = <ReportView report={rules} onRerun={diagnose} rerunDisabled={diagnosing} onOpenSkyView={onOpenSkyView} />;
  } else {
    main = (
      <StatePanel
        icon={<ListChecks />}
        title="Find out what's slowing you down"
        action={
          <Button size="sm" onClick={diagnose}>
            <ListChecks aria-hidden /> Run diagnostics
          </Button>
        }
      >
        Built-in checks review obstructions, alignment, plan limits, outages, Wi-Fi and hardware. They run on this
        computer, for free.
      </StatePanel>
    );
  }

  const showAiSection = aiOn || aiReport !== null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant={aiOn ? "outline" : "default"} onClick={diagnose} disabled={diagnosing}>
          {diagnosing ? <Loader2 className="animate-spin" aria-hidden /> : <ListChecks aria-hidden />}
          Run diagnostics
        </Button>
        {aiOn && (
          <Button size="sm" onClick={explain} disabled={aiBusy || (provider === "claude" && hasKey === null)}>
            {aiPhase === "preparing" ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            Explain with AI
          </Button>
        )}
      </div>
      {!aiOn && ai && (
        <p className="text-right text-[0.6875rem] text-muted-foreground">
          Want a plain-language explanation?{" "}
          <button
            type="button"
            onClick={onOpenAiSettings}
            className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2"
          >
            Turn on AI explanations
          </button>
        </p>
      )}

      <div ref={bodyRef} tabIndex={-1} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {main}
      </div>

      {showAiSection && (
        <section
          ref={aiRef}
          tabIndex={-1}
          aria-labelledby="ai-explanation-title"
          className="flex flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <h2 id="ai-explanation-title" className="sr-only">
            AI explanation
          </h2>
          {notice && (
            <p role="status" className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {notice}
            </p>
          )}
          {aiPhase === "explaining" ? (
            <Explaining provider={provider} startedAt={startedAt} onStop={stopWaiting} />
          ) : aiError ? (
            <ErrorPanel
              error={aiError}
              provider={provider}
              hasReport={false}
              onRetry={explain}
              onOpenApiKey={onOpenApiKey}
              onOpenAiSettings={onOpenAiSettings}
              onShowReport={() => setAiError(null)}
            />
          ) : aiReport ? (
            <>
              <button
                type="button"
                aria-expanded={aiOpen}
                aria-controls="ai-explanation-body"
                onClick={() => setAiOpen((o) => !o)}
                className="flex items-center justify-between gap-2 rounded-xl bg-card px-3.5 py-2.5 text-left ring-1 ring-border hover:bg-muted/40 focus-visible:outline-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">AI explanation</span>
                    <span className="block truncate text-[0.6875rem] text-muted-foreground">
                      {SOURCE_LABELS[aiReport.source]} · {new Date(aiReport.generatedAtMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </span>
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", aiOpen && "rotate-180")} aria-hidden />
              </button>
              {aiOpen && (
                <div id="ai-explanation-body">
                  <ReportView
                    report={aiReport}
                    onRerun={aiOn ? explain : undefined}
                    rerunDisabled={aiBusy}
                    onOpenSkyView={onOpenSkyView}
                  />
                </div>
              )}
            </>
          ) : (
            <p className="rounded-xl px-1 text-xs text-muted-foreground">
              <Sparkles className="mr-1 inline size-3.5 align-[-2px] text-primary" aria-hidden />
              Use <span className="font-medium text-foreground">Explain with AI</span> for a plain-language explanation of
              these findings. You'll see exactly what is sent first.
            </p>
          )}
        </section>
      )}

      <PreviewDialog
        payload={preview}
        destination={destination}
        onCancel={() => {
          setPreview(null);
          setAiPhase("idle");
        }}
        onConfirm={confirm}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focus(aiRef);
        }}
      />
    </div>
  );
}

function ErrorPanel({
  error,
  provider,
  hasReport,
  onRetry,
  onOpenApiKey,
  onOpenAiSettings,
  onShowReport,
}: {
  error: ApiError;
  provider: AiProvider;
  hasReport: boolean;
  onRetry: () => void;
  onOpenApiKey: () => void;
  onOpenAiSettings: () => void;
  onShowReport: () => void;
}) {
  const c = advisorErrorCopy(error.kind, provider === "local" ? "local" : "claude");
  const isKey = error.kind === "no_api_key";
  const keyRelated = isKey || error.kind === "ai_auth" || error.kind === "keyring";
  return (
    <StatePanel
      tone={isKey ? "neutral" : "critical"}
      icon={isKey ? <KeyRound /> : <Sparkles />}
      title={c.title}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {c.action === "settings" && (
            <Button size="sm" onClick={keyRelated ? onOpenApiKey : onOpenAiSettings}>
              {keyRelated ? <KeyRound aria-hidden /> : <Settings2 aria-hidden />}
              {isKey ? "Add API key" : keyRelated ? "Open API key settings" : "Open AI settings"}
            </Button>
          )}
          {c.action === "retry" && (
            <Button size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden /> Try again
            </Button>
          )}
          {hasReport && (
            <Button size="sm" variant="ghost" onClick={onShowReport}>
              Show last report
            </Button>
          )}
        </div>
      }
    >
      {c.body}
      {error.message && !isKey && <span className="mt-1.5 block opacity-80">Details: {error.message}</span>}
    </StatePanel>
  );
}

function Explaining({ provider, startedAt, onStop }: { provider: AiProvider; startedAt: number; onStop: () => void }) {
  const now = useNow(1000);
  const local = provider === "local";
  return (
    <StatePanel
      icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}
      title={local ? "Your local model is reviewing the findings" : "Claude is reviewing the findings"}
      action={
        <Button size="sm" variant="outline" onClick={onStop}>
          Stop waiting
        </Button>
      }
    >
      {local
        ? "This depends on your hardware and model size, and can take a few minutes."
        : "This usually takes 10 to 60 seconds."}
      <span className="mt-2 block">
        Elapsed{" "}
        <span className="num text-foreground" aria-live="off">
          {formatElapsed(now - startedAt)}
        </span>
      </span>
    </StatePanel>
  );
}

export function PreviewDialog({
  payload,
  destination,
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  payload: DiagnosticSummary | null;
  destination: AiDestination | null;
  onCancel: () => void;
  onConfirm: () => void;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const d = destination ?? { name: "the AI provider", target: "the AI provider", leavesComputer: true, remoteLocal: false };
  return (
    <AlertDialog open={payload !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="max-h-[90vh] overflow-y-auto data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-lg"
      >
        {payload && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Send this summary to {d.name}?</AlertDialogTitle>
              <AlertDialogDescription>{privacyNote(d)}</AlertDialogDescription>
            </AlertDialogHeader>
            {payload.isSimulated && (
              <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs ring-1 ring-warning/40">
                <FlaskConical className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-medium">Simulated data.</span> These numbers come from demo mode, not your dish, so
                  the explanation won't tell you anything about your connection.
                  {d.name === "Claude" && " Analyzing it with Claude still costs money on your Anthropic account."}
                </span>
              </p>
            )}
            {d.remoteLocal && (
              <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs ring-1 ring-warning/40">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                <span>
                  <span className="font-medium">This address is not this computer.</span> The data will travel over your
                  network to <span className="num">{d.target}</span>.
                </span>
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <dt className="text-muted-foreground">Period</dt>
              <dd className="num text-right">{payload.windowHours} h</dd>
              <dt className="text-muted-foreground">Avg latency</dt>
              <dd className="num text-right">{formatMs(payload.latencyAvgMs)}</dd>
              <dt className="text-muted-foreground">Avg packet loss</dt>
              <dd className="num text-right">{formatPercent(payload.dropRateAvg, 2)}</dd>
              <dt className="text-muted-foreground">Outages</dt>
              <dd className="num text-right">
                {payload.outageCount} ({formatDurationMs(payload.outageTotalS * 1000)})
              </dd>
              <dt className="text-muted-foreground">Built-in findings</dt>
              <dd className="num text-right">{payload.ruleFindings.length}</dd>
            </dl>
            <details open className="group rounded-lg ring-1 ring-border">
              <summary className="flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring">
                <ShieldCheck className="size-3.5 text-good" aria-hidden />
                Exact data to be sent (JSON)
              </summary>
              <pre
                tabIndex={0}
                aria-label="Payload JSON"
                className="num max-h-56 overflow-auto border-t border-border px-3 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground"
              >
                {JSON.stringify(payload, null, 2)}
              </pre>
            </details>
            <AlertDialogFooter>
              <AlertDialogCancel>Don't send</AlertDialogCancel>
              <AlertDialogAction onClick={onConfirm}>Send and analyze</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Container: reads settings and API key status fresh each time the tab mounts. */
export function DiagnosePanel(props: Omit<Props, "hasKey" | "ai">) {
  const { hasKey } = useApiKey();
  const { settings } = useSettings();
  return <DiagnoseTab hasKey={hasKey} ai={settings} {...props} />;
}
