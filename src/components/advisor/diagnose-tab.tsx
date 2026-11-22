import { useCallback, useEffect, useRef, useState } from "react";
import { History, KeyRound, ListChecks, Loader2, RefreshCw, Settings2, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import type { AiProvider, AiReport, DiagnosticSummary, Settings } from "@/types/models";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { advisorErrorCopy, aiDestination, isInsufficientHistory, privacyNote, type AiDestination } from "@/lib/advisor";
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
}

type Phase = "idle" | "diagnosing" | "preparing" | "confirm" | "explaining";
/** Which action produced the current error, so "Try again" repeats it. */
type Origin = "rules" | "ai";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function DiagnoseTab({ ai, hasKey, onOpenApiKey, onOpenAiSettings }: Props) {
  const provider: AiProvider = ai?.aiProvider ?? "off";
  const destination = ai ? aiDestination(ai) : null;

  const [report, setReport] = useState<AiReport | null>(null);
  const [loadingLast, setLoadingLast] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<DiagnosticSummary | null>(null);
  const [error, setError] = useState<{ e: ApiError; origin: Origin } | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const runId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusBody = () => requestAnimationFrame(() => bodyRef.current?.focus());

  const fail = useCallback((e: ApiError, origin: Origin) => {
    if (e.kind === "insufficient_data") setInsufficient(true);
    else setError({ e, origin });
    setPhase("idle");
    focusBody();
  }, []);

  const reset = () => {
    setError(null);
    setNotice(null);
    setInsufficient(false);
  };

  /** Built-in rules: offline and fast, so no preview is needed. */
  const diagnose = useCallback(async () => {
    reset();
    setPhase("diagnosing");
    try {
      const r = await api.runDiagnostics();
      setReport(r);
      setPhase("idle");
    } catch (e) {
      fail(normalizeError(e), "rules");
    }
  }, [fail]);

  // On open: show the last report, or run the rules right away.
  useEffect(() => {
    let alive = true;
    api
      .getLastAiReport()
      .then(
        (r) => {
          if (!alive) return;
          if (r) setReport(r);
          else void diagnose();
        },
        () => alive && void diagnose(),
      )
      .finally(() => alive && setLoadingLast(false));
    return () => {
      alive = false;
    };
  }, [diagnose]);

  const explain = useCallback(async () => {
    reset();
    if (provider === "claude" && hasKey === false) {
      setError({ e: normalizeError({ kind: "no_api_key" }), origin: "ai" });
      return;
    }
    setPhase("preparing");
    try {
      const p = await api.previewAiPayload();
      if (isInsufficientHistory(p)) {
        setInsufficient(true);
        setPhase("idle");
        return;
      }
      setPreview(p);
      setPhase("confirm");
    } catch (e) {
      fail(normalizeError(e), "ai");
    }
  }, [provider, hasKey, fail]);

  const confirm = useCallback(async () => {
    const id = ++runId.current;
    setPreview(null);
    setStartedAt(Date.now());
    setPhase("explaining");
    try {
      const r = await api.analyzeNetworkWithAi();
      if (id !== runId.current) return;
      setReport(r);
      setPhase("idle");
      focusBody();
    } catch (e) {
      if (id !== runId.current) return;
      fail(normalizeError(e), "ai");
    }
  }, [fail]);

  const stopWaiting = () => {
    runId.current++;
    setPhase("idle");
    focusBody();
    setNotice("Stopped waiting. If the explanation still finishes, it will appear here next time you open this tab.");
  };

  const busy = phase !== "idle" && phase !== "confirm";
  const aiOn = provider !== "off";

  let body;
  if (phase === "explaining") {
    body = <Explaining provider={provider} startedAt={startedAt} onStop={stopWaiting} />;
  } else if (phase === "diagnosing" && !report) {
    body = (
      <StatePanel icon={<Loader2 className="animate-spin motion-reduce:animate-none" />} title="Checking the last 24 hours">
        Running the built-in checks on this computer.
      </StatePanel>
    );
  } else if (loadingLast) {
    body = <Skeleton className="h-48 rounded-xl" />;
  } else if (error) {
    body = (
      <ErrorPanel
        error={error.e}
        provider={error.origin === "rules" ? "off" : provider}
        hasReport={Boolean(report)}
        onRetry={error.origin === "rules" ? diagnose : explain}
        onOpenApiKey={onOpenApiKey}
        onOpenAiSettings={onOpenAiSettings}
        onShowReport={() => setError(null)}
      />
    );
  } else if (insufficient) {
    body = (
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
  } else if (report) {
    body = (
      <ReportView
        report={report}
        onRerun={report.source === "rules" ? diagnose : explain}
        rerunDisabled={busy}
      />
    );
  } else {
    body = (
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant={aiOn ? "outline" : "default"} onClick={diagnose} disabled={busy}>
          {phase === "diagnosing" ? <Loader2 className="animate-spin" aria-hidden /> : <ListChecks aria-hidden />}
          Run diagnostics
        </Button>
        {aiOn && (
          <Button size="sm" onClick={explain} disabled={busy || (provider === "claude" && hasKey === null)}>
            {phase === "preparing" ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
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
      {notice && (
        <p role="status" className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <div ref={bodyRef} tabIndex={-1} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {body}
      </div>
      <PreviewDialog
        payload={preview}
        destination={destination}
        onCancel={() => {
          setPreview(null);
          setPhase("idle");
        }}
        onConfirm={confirm}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusBody();
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
