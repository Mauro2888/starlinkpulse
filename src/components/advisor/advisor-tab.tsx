import { useCallback, useEffect, useRef, useState } from "react";
import { History, KeyRound, Loader2, RefreshCw, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import type { AiReport, DiagnosticSummary } from "@/types/models";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { advisorErrorCopy, isInsufficientHistory } from "@/lib/advisor";
import { formatDurationMs, formatMs, formatPercent } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { useApiKey } from "@/hooks/use-pulse";
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

export const PRIVACY_NOTE =
  "Only these aggregated numbers are sent to Anthropic using your API key. No device IDs, MAC addresses, names or location.";

interface Props {
  /** Whether an API key is saved (null while checking). */
  hasKey: boolean | null;
  onOpenApiKey: () => void;
  onOpenModelSettings: () => void;
}

type Phase = "idle" | "preparing" | "confirm" | "running";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AdvisorTab({ hasKey, onOpenApiKey, onOpenModelSettings }: Props) {
  const [report, setReport] = useState<AiReport | null>(null);
  const [loadingLast, setLoadingLast] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<DiagnosticSummary | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const runId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusBody = () => requestAnimationFrame(() => bodyRef.current?.focus());

  useEffect(() => {
    let alive = true;
    api.getLastAiReport().then(
      (r) => alive && setReport(r),
      () => undefined,
    ).finally(() => alive && setLoadingLast(false));
    return () => {
      alive = false;
    };
  }, []);

  const fail = useCallback((e: ApiError) => {
    if (e.kind === "insufficient_data") setInsufficient(true);
    else setError(e);
    setPhase("idle");
    focusBody();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    setInsufficient(false);
    if (hasKey === false) {
      setError(normalizeError({ kind: "no_api_key" }));
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
      fail(normalizeError(e));
    }
  }, [hasKey, fail]);

  const confirm = useCallback(async () => {
    const id = ++runId.current;
    setPreview(null);
    setStartedAt(Date.now());
    setPhase("running");
    try {
      const r = await api.analyzeNetworkWithAi();
      if (id !== runId.current) return;
      setReport(r);
      setPhase("idle");
      focusBody();
    } catch (e) {
      if (id !== runId.current) return;
      fail(normalizeError(e));
    }
  }, [fail]);

  const stopWaiting = () => {
    runId.current++;
    setPhase("idle");
    focusBody();
    setNotice("Stopped waiting. If the analysis still finishes, the report will appear here next time you open this tab.");
  };

  const busy = phase !== "idle" && phase !== "confirm";

  let body;
  if (phase === "running") {
    body = <Running startedAt={startedAt} onStop={stopWaiting} />;
  } else if (loadingLast) {
    body = <Skeleton className="h-48 rounded-xl" />;
  } else if (error) {
    const c = advisorErrorCopy(error.kind);
    const isKey = error.kind === "no_api_key";
    body = (
      <StatePanel
        tone={isKey ? "neutral" : "critical"}
        icon={isKey ? <KeyRound /> : <Sparkles />}
        title={c.title}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {c.action === "settings" && (
              <Button size="sm" onClick={error.kind === "invalid_input" ? onOpenModelSettings : onOpenApiKey}>
                {error.kind === "invalid_input" ? <Settings2 aria-hidden /> : <KeyRound aria-hidden />}
                {isKey ? "Add API key" : error.kind === "invalid_input" ? "Choose a model" : "Open API key settings"}
              </Button>
            )}
            {c.action === "retry" && (
              <Button size="sm" onClick={start}>
                <RefreshCw aria-hidden /> Try again
              </Button>
            )}
            {report && (
              <Button size="sm" variant="ghost" onClick={() => setError(null)}>
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
  } else if (insufficient) {
    body = (
      <StatePanel
        icon={<History />}
        title="Not enough history yet"
        action={
          <Button size="sm" variant="outline" onClick={start}>
            <RefreshCw aria-hidden /> Check again
          </Button>
        }
      >
        The Advisor needs at least an hour of measurements to find patterns. Keep StarlinkPulse running, then try
        again.
      </StatePanel>
    );
  } else if (report) {
    body = <ReportView report={report} onRerun={start} rerunDisabled={busy} />;
  } else if (hasKey === false) {
    body = (
      <StatePanel
        icon={<KeyRound />}
        title="Add your API key to get started"
        action={
          <Button size="sm" onClick={onOpenApiKey}>
            <KeyRound aria-hidden /> Add API key
          </Button>
        }
      >
        The Advisor asks Claude to review your last 24 hours and explain what's slowing you down: Wi-Fi, obstructions,
        the Starlink network or hardware. It uses your own Anthropic API key.
      </StatePanel>
    );
  } else {
    body = (
      <StatePanel
        icon={<Sparkles />}
        title="Get advice on your connection"
        action={
          <Button size="sm" onClick={start} disabled={busy || hasKey === null}>
            {phase === "preparing" ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
            Analyze last 24 hours
          </Button>
        }
      >
        Claude reviews latency, packet loss, outages, obstructions and throttling, then tells you what to fix first.
        You'll see exactly what is sent before anything leaves this computer.
      </StatePanel>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      {report && phase === "idle" && !error && !insufficient && (
        <div className="flex justify-end">
          <Button size="sm" onClick={start} disabled={busy}>
            <Sparkles aria-hidden /> Analyze last 24 hours
          </Button>
        </div>
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
        onCancel={() => {
          setPreview(null);
          setPhase("idle");
        }}
        onConfirm={confirm}
        onCloseAutoFocus={(e) => {
          // The Analyze button may be replaced by the progress view: focus the content area instead.
          e.preventDefault();
          focusBody();
        }}
      />
    </div>
  );
}

function Running({ startedAt, onStop }: { startedAt: number; onStop: () => void }) {
  const now = useNow(1000);
  return (
    <StatePanel
      icon={<Loader2 className="animate-spin motion-reduce:animate-none" />}
      title="Claude is reviewing your last 24 hours"
      action={
        <Button size="sm" variant="outline" onClick={onStop}>
          Stop waiting
        </Button>
      }
    >
      This usually takes 10 to 60 seconds.
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
  onCancel,
  onConfirm,
  onCloseAutoFocus,
}: {
  payload: DiagnosticSummary | null;
  onCancel: () => void;
  onConfirm: () => void;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <AlertDialog open={payload !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus} className="max-h-[90vh] overflow-y-auto data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-lg">
        {payload && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Send this summary to Claude?</AlertDialogTitle>
              <AlertDialogDescription>{PRIVACY_NOTE}</AlertDialogDescription>
            </AlertDialogHeader>
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

/** Container: reads API key status fresh each time the tab mounts. */
export function AdvisorPanel(props: Omit<Props, "hasKey">) {
  const { hasKey } = useApiKey();
  return <AdvisorTab hasKey={hasKey} {...props} />;
}
