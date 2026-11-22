import type { AiFinding, AiProvider, AiSeverity, CommandErrorKind, DiagnosticSummary, ReportSource, Settings } from "@/types/models";
import { isNum } from "@/lib/format";

export const SEVERITY_ORDER: readonly AiSeverity[] = ["critical", "warning", "info"];

export const SEVERITY_LABELS: Record<AiSeverity, string> = {
  critical: "Critical",
  warning: "Worth fixing",
  info: "For your information",
};

/** Groups findings by severity, critical first; empty groups are omitted. Order inside a group is kept. */
export function groupFindings(findings: AiFinding[]): { severity: AiSeverity; findings: AiFinding[] }[] {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.findings.length > 0);
}

/**
 * Local hint that the summary has no measurements yet. The backend is
 * authoritative and answers `insufficient_data` when there is < 1 h of history.
 */
export function isInsufficientHistory(s: DiagnosticSummary): boolean {
  return !isNum(s.historyMinutes) || s.historyMinutes < 60;
}

export type ErrorAction = "settings" | "retry" | null;

export interface ErrorCopy {
  title: string;
  body: string;
  action: ErrorAction;
}

/** User-facing copy for analysis errors: what happened + how to fix it. */
export function advisorErrorCopy(kind: CommandErrorKind, provider: AiProvider = "claude"): ErrorCopy {
  if (provider === "local") {
    switch (kind) {
      case "ai_unavailable":
      case "offline":
      case "timeout":
        return {
          title: "Can't reach your local model",
          body:
            kind === "timeout"
              ? "The local model didn't answer in time. Try a smaller model, or make sure the server isn't busy."
              : "Make sure Ollama or your OpenAI-compatible server is running at the address in Settings, then try again.",
          action: "retry",
        };
      case "invalid_input":
        return {
          title: "Choose a local model",
          body: "Pick a model that is installed on your local server in Settings → AI explanations.",
          action: "settings",
        };
      case "ai_invalid_response":
        return {
          title: "Couldn't read the model's answer",
          body: "Small local models sometimes return incomplete answers. Try again, or choose a larger model.",
          action: "retry",
        };
    }
  }
  switch (kind) {
    case "no_api_key":
      return {
        title: "Add your API key to use the Advisor",
        body: "The Advisor sends a summary of your connection to Claude using your own Anthropic API key.",
        action: "settings",
      };
    case "ai_auth":
      return {
        title: "API key rejected",
        body: "Anthropic didn't accept your key, or the account has a billing problem. Check the key in Controls and your billing in the Anthropic Console.",
        action: "settings",
      };
    case "ai_rate_limit":
      return {
        title: "Too many requests",
        body: "Anthropic is limiting requests for this key. Wait a minute, then try again.",
        action: "retry",
      };
    case "ai_unavailable":
      return {
        title: "Claude is unavailable",
        body: "The Anthropic API is busy or down. Try again in a few minutes.",
        action: "retry",
      };
    case "ai_refused":
      return {
        title: "Claude declined this request",
        body: "The model didn't produce a report for this data. Try again, or choose a different model in Settings.",
        action: "retry",
      };
    case "ai_invalid_response":
      return {
        title: "Couldn't read the report",
        body: "Claude's reply was incomplete or in an unexpected format. Running the analysis again usually fixes this.",
        action: "retry",
      };
    case "offline":
      return {
        title: "Can't reach Anthropic",
        body: "Check your internet connection, then try again. With Starlink down, the Advisor can't run.",
        action: "retry",
      };
    case "timeout":
      return {
        title: "Analysis timed out",
        body: "Claude didn't answer within 2 minutes. Try again, or choose a faster model in Settings.",
        action: "retry",
      };
    case "invalid_input":
      return {
        title: "Model not available",
        body: "Your API key can't use the selected model. Choose another model in Settings.",
        action: "settings",
      };
    case "insufficient_data":
      return {
        title: "Not enough history yet",
        body: "The Advisor needs at least an hour of measurements to find patterns. Keep StarlinkPulse running, then try again.",
        action: "retry",
      };
    case "keyring":
      return {
        title: "Can't read your API key",
        body: "The system keychain is not available. Unlock it, or save the key again in Controls.",
        action: "settings",
      };
    default:
      return { title: "Analysis failed", body: "Something went wrong. Try again.", action: "retry" };
  }
}

export const CLAUDE_MODEL_OPTIONS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most capable" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest, cheapest" },
] as const;

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

// ---- Providers ------------------------------------------------------------

export const SOURCE_LABELS: Record<ReportSource, string> = {
  rules: "Built-in rules",
  claude: "Claude",
  local: "Local model",
};

/** True for localhost, 127.0.0.0/8 and ::1. Invalid URLs are not loopback. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface AiDestination {
  /** Short name for titles, e.g. "Claude" or "your local model". */
  name: string;
  /** Where the data goes, for the privacy note. */
  target: string;
  /** True when data leaves this computer. */
  leavesComputer: boolean;
  /** Local provider pointing at another machine. */
  remoteLocal: boolean;
}

export function aiDestination(s: Pick<Settings, "aiProvider" | "localAiUrl">): AiDestination | null {
  if (s.aiProvider === "claude") {
    return { name: "Claude", target: "Anthropic (api.anthropic.com)", leavesComputer: true, remoteLocal: false };
  }
  if (s.aiProvider === "local") {
    const loop = isLoopbackUrl(s.localAiUrl);
    return { name: "your local model", target: s.localAiUrl, leavesComputer: !loop, remoteLocal: !loop };
  }
  return null;
}

/** Privacy note shown in the preview dialog, naming the destination. */
export function privacyNote(d: AiDestination): string {
  const never = "No device IDs, MAC addresses, names or location.";
  if (!d.leavesComputer) {
    return `Only these aggregated numbers and findings are sent to your local model at ${d.target}. Nothing leaves this computer. ${never}`;
  }
  if (d.remoteLocal) {
    return `Only these aggregated numbers and findings are sent to ${d.target}. ${never}`;
  }
  return `Only these aggregated numbers and findings are sent to ${d.target} using your API key. ${never}`;
}
