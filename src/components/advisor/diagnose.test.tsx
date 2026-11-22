import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiProvider, AiReport, DiagnosticSummary } from "@/types/models";
import { setBackendForTesting, type Backend } from "@/lib/api";
import {
  advisorErrorCopy,
  aiDestination,
  groupFindings,
  isInsufficientHistory,
  isLoopbackUrl,
  privacyNote,
} from "@/lib/advisor";
import { errorTitle, normalizeError } from "@/lib/errors";
import { validateSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/mock";
import { DiagnoseTab } from "@/components/advisor/diagnose-tab";
import { ReportView } from "@/components/advisor/report-view";

const finding = { category: "obstruction" as const, severity: "critical" as const, title: "Sky blocked", detail: "d", actions: [] };

const summary: DiagnosticSummary = {
  language: "en",
  windowHours: 24,
  historyMinutes: 1440,
  hardwareVersion: "rev3_proto2",
  softwareVersion: "2026.11.04",
  latencyAvgMs: 32,
  latencyP95Ms: 61,
  dropRateAvg: 0.004,
  fractionObstructed: 0.002,
  outageCount: 3,
  outageTotalS: 54,
  outagesByCause: [["OBSTRUCTED", 40]],
  worstHours: [21],
  throttledMinutes: 0,
  azimuthCorrectionDeg: null,
  elevationCorrectionDeg: null,
  isSimulated: false,
  weakestWifiSignalDbm: null,
  ruleFindings: [finding],
};

const report = (source: AiReport["source"], headline: string): AiReport => ({
  generatedAtMs: Date.UTC(2026, 10, 22, 10, 0),
  source,
  model: source === "rules" ? "rules-v1" : source === "local" ? "llama3.2:3b" : "claude-opus-5-5",
  overallHealth: "fair",
  headline,
  findings: [
    { category: "wifi", severity: "info", title: "Info finding", detail: "d", actions: [] },
    { category: "obstruction", severity: "critical", title: "Critical finding", detail: "d", actions: ["Move the dish"] },
    { category: "power", severity: "warning", title: "Warning finding", detail: "d", actions: [] },
    { category: "hardware", severity: "critical", title: "Second critical", detail: "d", actions: [] },
  ],
  payload: summary,
});

const sentArgs: Record<string, unknown>[] = [];

function fake(overrides: Record<string, () => Promise<unknown>> = {}) {
  const calls: string[] = [];
  sentArgs.length = 0;
  const backend: Backend = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === "analyze_network_with_ai") sentArgs.push(args ?? {});
      if (overrides[cmd]) return overrides[cmd]();
      if (cmd === "get_last_ai_report") return null;
      if (cmd === "run_diagnostics") return report("rules", "Rules headline");
      if (cmd === "preview_ai_payload") return summary;
      if (cmd === "analyze_network_with_ai") return report("claude", "AI headline");
      throw { kind: "internal", message: `unexpected ${cmd}` };
    }),
    listen: vi.fn(async () => () => undefined),
  };
  setBackendForTesting(backend);
  return calls;
}

function renderTab(provider: AiProvider = "claude", opts: { hasKey?: boolean | null; url?: string } = {}) {
  const onOpenApiKey = vi.fn();
  const onOpenAiSettings = vi.fn();
  render(
    <DiagnoseTab
      ai={{ aiProvider: provider, localAiUrl: opts.url ?? "http://localhost:11434" }}
      hasKey={opts.hasKey ?? true}
      onOpenApiKey={onOpenApiKey}
      onOpenAiSettings={onOpenAiSettings}
    />,
  );
  return { onOpenApiKey, onOpenAiSettings, user: userEvent.setup() };
}

afterEach(() => setBackendForTesting(null));

describe("Diagnose tab", () => {
  it("runs the built-in rules on open when there is no saved report, without any preview", async () => {
    const calls = fake();
    renderTab("off");
    expect(await screen.findByText("Rules headline")).toBeInTheDocument();
    expect(screen.getByText("Built-in rules")).toBeInTheDocument();
    expect(calls).toContain("run_diagnostics");
    expect(calls).not.toContain("preview_ai_payload");
  });

  it("shows the last saved report instead of re-running", async () => {
    const calls = fake({ get_last_ai_report: async () => report("local", "Saved local report") });
    renderTab("off");
    expect(await screen.findByText("Saved local report")).toBeInTheDocument();
    expect(screen.getByText("Local model")).toBeInTheDocument();
    expect(calls).not.toContain("run_diagnostics");
  });

  it("hides 'Explain with AI' when AI is off and offers to turn it on", async () => {
    fake();
    const { user, onOpenAiSettings } = renderTab("off");
    await screen.findByText("Rules headline");
    expect(screen.queryByRole("button", { name: /explain with ai/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn on AI explanations" }));
    expect(onOpenAiSettings).toHaveBeenCalled();
  });

  it("previews the exact payload (with rule findings) and names Anthropic before sending", async () => {
    const calls = fake();
    const { user } = renderTab("claude");
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Send this summary to Claude?");
    expect(dialog).toHaveTextContent(/Anthropic \(api\.anthropic\.com\) using your API key/);
    const json = within(dialog).getByLabelText("Payload JSON").textContent!;
    expect(json).toBe(JSON.stringify(summary, null, 2));
    expect(json).toContain("ruleFindings");
    expect(calls).not.toContain("analyze_network_with_ai");

    await user.click(within(dialog).getByRole("button", { name: "Send and analyze" }));
    expect(await screen.findByText("AI headline")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(calls.filter((c) => c === "analyze_network_with_ai")).toHaveLength(1);
    // The exact previewed payload is what gets sent.
    expect(sentArgs[0]).toEqual({ payload: summary });
  });

  it("warns prominently about simulated data, mentioning cost for Claude", async () => {
    fake({ preview_ai_payload: async () => ({ ...summary, isSimulated: true }) });
    const { user } = renderTab("claude");
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    const dialog = await screen.findByRole("alertdialog");
    const warning = within(dialog).getByRole("alert");
    expect(warning).toHaveTextContent("Simulated data.");
    expect(warning).toHaveTextContent(/costs money/);
  });

  it("never sends when the user declines", async () => {
    const calls = fake();
    const { user } = renderTab("local");
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    await user.click(await screen.findByRole("button", { name: "Don't send" }));
    expect(calls).not.toContain("analyze_network_with_ai");
  });

  it("says nothing leaves the computer for a loopback local server", async () => {
    fake();
    const { user } = renderTab("local", { url: "http://127.0.0.1:11434" });
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Send this summary to your local model?");
    expect(dialog).toHaveTextContent("Nothing leaves this computer.");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns when the 'local' server is another machine", async () => {
    fake();
    const { user } = renderTab("local", { url: "http://192.168.1.50:11434" });
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This address is not this computer.");
    expect(dialog).not.toHaveTextContent("Nothing leaves this computer.");
  });

  it("asks for a Claude key without previewing when none is saved", async () => {
    const calls = fake();
    const { user, onOpenApiKey } = renderTab("claude", { hasKey: false });
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    await user.click(await screen.findByRole("button", { name: "Add API key" }));
    expect(onOpenApiKey).toHaveBeenCalled();
    expect(calls).not.toContain("preview_ai_payload");
  });

  it("shows 'not enough history' when the rules answer insufficient_data", async () => {
    fake({
      run_diagnostics: async () => {
        throw { kind: "insufficient_data", message: "Less than 1 hour of history." };
      },
    });
    renderTab("off");
    expect(await screen.findByText("Not enough history yet")).toBeInTheDocument();
  });

  it("explains an unreachable local server", async () => {
    fake({
      analyze_network_with_ai: async () => {
        throw { kind: "ai_unavailable", message: "connection refused" };
      },
    });
    const { user } = renderTab("local");
    await screen.findByText("Rules headline");
    await user.click(screen.getByRole("button", { name: /explain with ai/i }));
    await user.click(await screen.findByRole("button", { name: "Send and analyze" }));
    expect(await screen.findByText("Can't reach your local model")).toBeInTheDocument();
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
  });
});

describe("ReportView", () => {
  it("orders findings critical, warning, info and keeps order within a group", () => {
    render(<ReportView report={report("rules", "h")} />);
    const groups = screen.getAllByTestId(/^group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual(["group-critical", "group-warning", "group-info"]);
    const titles = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(titles).toEqual(["Critical finding", "Second critical", "Warning finding", "Info finding"]);
    expect(screen.getByText(/Overall: Needs attention/)).toBeInTheDocument();
    expect(screen.getByText(/by the built-in rules, on this computer/)).toBeInTheDocument();
  });

  it("groupFindings omits empty groups", () => {
    expect(groupFindings([report("rules", "h").findings[0]]).map((g) => g.severity)).toEqual(["info"]);
  });
});

describe("providers and privacy", () => {
  it("recognizes loopback hosts only", () => {
    for (const u of ["http://localhost:11434", "http://127.0.0.1:1234", "http://[::1]:11434", "https://LOCALHOST"]) {
      expect(isLoopbackUrl(u)).toBe(true);
    }
    for (const u of ["http://192.168.1.50:11434", "http://my-pc.local:11434", "http://localhost.evil.com", "not a url"]) {
      expect(isLoopbackUrl(u)).toBe(false);
    }
  });

  it("names the destination per provider", () => {
    expect(aiDestination({ aiProvider: "off", localAiUrl: "" })).toBeNull();
    const claude = aiDestination({ aiProvider: "claude", localAiUrl: "" })!;
    expect(privacyNote(claude)).toMatch(/Anthropic/);
    const remote = aiDestination({ aiProvider: "local", localAiUrl: "http://10.0.0.5:11434" })!;
    expect(remote.remoteLocal).toBe(true);
    expect(privacyNote(remote)).toContain("http://10.0.0.5:11434");
  });

  it("validates local provider settings", () => {
    const base = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications } };
    expect(validateSettings({ ...base, aiProvider: "local", localAiUrl: "ftp://x", localAiModel: "" })).toMatchObject({
      localAiUrl: expect.any(String),
      localAiModel: expect.any(String),
    });
    expect(validateSettings({ ...base, aiProvider: "local", localAiUrl: "http://localhost:11434", localAiModel: "llama3.2:3b" })).toEqual({});
    expect(validateSettings({ ...base, aiProvider: "off", localAiUrl: "", localAiModel: "" })).toEqual({});
  });

  it.each([
    ["no_api_key", "settings"],
    ["ai_auth", "settings"],
    ["ai_rate_limit", "retry"],
    ["ai_unavailable", "retry"],
    ["ai_refused", "retry"],
    ["ai_invalid_response", "retry"],
    ["offline", "retry"],
    ["insufficient_data", "retry"],
  ] as const)("Claude error %s has copy with a %s action", (kind, action) => {
    expect(normalizeError({ kind, message: "x" }).kind).toBe(kind);
    expect(errorTitle(kind)).toBeTruthy();
    const c = advisorErrorCopy(kind, "claude");
    expect(c.title && c.body).toBeTruthy();
    expect(c.action).toBe(action);
  });

  it("uses local wording for local provider errors", () => {
    expect(advisorErrorCopy("ai_unavailable", "local").title).toBe("Can't reach your local model");
    expect(advisorErrorCopy("invalid_input", "local").action).toBe("settings");
  });

  it("detects insufficient history from historyMinutes", () => {
    expect(isInsufficientHistory(summary)).toBe(false);
    expect(isInsufficientHistory({ ...summary, historyMinutes: 59 })).toBe(true);
  });
});
