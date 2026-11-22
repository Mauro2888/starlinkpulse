import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AiReport, DiagnosticSummary } from "@/types/models";
import { setBackendForTesting, type Backend } from "@/lib/api";
import { advisorErrorCopy, groupFindings, isInsufficientHistory } from "@/lib/advisor";
import { errorTitle, normalizeError } from "@/lib/errors";
import { AdvisorTab, PRIVACY_NOTE } from "@/components/advisor/advisor-tab";
import { ReportView } from "@/components/advisor/report-view";

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
  alignmentDeltaAzimuthDeg: null,
  alignmentDeltaElevationDeg: null,
  weakestWifiSignalDbm: null,
};

const report: AiReport = {
  generatedAtMs: Date.UTC(2026, 10, 22, 10, 0),
  model: "claude-opus-5-5",
  overallHealth: "fair",
  headline: "Obstructions cause short dropouts.",
  findings: [
    { category: "wifi", severity: "info", title: "Info finding", detail: "d", actions: [] },
    { category: "obstruction", severity: "critical", title: "Critical finding", detail: "d", actions: ["Move the dish"] },
    { category: "power", severity: "warning", title: "Warning finding", detail: "d", actions: [] },
    { category: "hardware", severity: "critical", title: "Second critical", detail: "d", actions: [] },
  ],
  payload: summary,
};

function fake(overrides: Record<string, () => Promise<unknown>> = {}) {
  const calls: string[] = [];
  const backend: Backend = {
    invoke: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (overrides[cmd]) return overrides[cmd]();
      if (cmd === "get_last_ai_report") return null;
      if (cmd === "preview_ai_payload") return summary;
      if (cmd === "analyze_network_with_ai") return report;
      throw { kind: "internal", message: `unexpected ${cmd}` };
    }),
    listen: vi.fn(async () => () => undefined),
  };
  setBackendForTesting(backend);
  return calls;
}

function renderTab(hasKey: boolean | null = true) {
  const onOpenApiKey = vi.fn();
  render(<AdvisorTab hasKey={hasKey} onOpenApiKey={onOpenApiKey} onOpenModelSettings={vi.fn()} />);
  return { onOpenApiKey, user: userEvent.setup() };
}

afterEach(() => setBackendForTesting(null));

describe("AdvisorTab privacy gating", () => {
  it("shows the exact payload and does not analyze before confirmation", async () => {
    const calls = fake();
    const { user } = renderTab();
    await user.click(await screen.findByRole("button", { name: /analyze last 24 hours/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(PRIVACY_NOTE);
    expect(within(dialog).getByLabelText("Payload JSON").textContent).toBe(JSON.stringify(summary, null, 2));
    expect(calls).toContain("preview_ai_payload");
    expect(calls).not.toContain("analyze_network_with_ai");

    await user.click(within(dialog).getByRole("button", { name: "Send and analyze" }));
    expect(await screen.findByText(report.headline)).toBeInTheDocument();
    expect(calls.filter((c) => c === "analyze_network_with_ai")).toHaveLength(1);
  });

  it("never analyzes when the user declines", async () => {
    const calls = fake();
    const { user } = renderTab();
    await user.click(await screen.findByRole("button", { name: /analyze last 24 hours/i }));
    await user.click(await screen.findByRole("button", { name: "Don't send" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls).not.toContain("analyze_network_with_ai");
  });

  it("asks for an API key instead of previewing when none is saved", async () => {
    const calls = fake();
    const { user, onOpenApiKey } = renderTab(false);
    await user.click(await screen.findByRole("button", { name: "Add API key" }));
    expect(onOpenApiKey).toHaveBeenCalled();
    expect(calls).not.toContain("preview_ai_payload");
  });

  it("explains when there is not enough history", async () => {
    const calls = fake({
      preview_ai_payload: async () => ({ ...summary, historyMinutes: 20 }),
    });
    const { user } = renderTab();
    await user.click(await screen.findByRole("button", { name: /analyze last 24 hours/i }));
    expect(await screen.findByText("Not enough history yet")).toBeInTheDocument();
    expect(calls).not.toContain("analyze_network_with_ai");
  });

  it("shows the not-enough-history state when the backend answers insufficient_data", async () => {
    fake({
      analyze_network_with_ai: async () => {
        throw { kind: "insufficient_data", message: "Less than 1 hour of history." };
      },
    });
    const { user } = renderTab();
    await user.click(await screen.findByRole("button", { name: /analyze last 24 hours/i }));
    await user.click(await screen.findByRole("button", { name: "Send and analyze" }));
    expect(await screen.findByText("Not enough history yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("maps an analysis error to friendly copy", async () => {
    fake({
      analyze_network_with_ai: async () => {
        throw { kind: "ai_rate_limit", message: "retry after 30 s" };
      },
    });
    const { user } = renderTab();
    await user.click(await screen.findByRole("button", { name: /analyze last 24 hours/i }));
    await user.click(await screen.findByRole("button", { name: "Send and analyze" }));
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
    expect(screen.getByText(/retry after 30 s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("ReportView", () => {
  it("orders findings critical, warning, info and keeps order within a group", () => {
    render(<ReportView report={report} />);
    const groups = screen.getAllByTestId(/^group-/).map((g) => g.dataset.testid);
    expect(groups).toEqual(["group-critical", "group-warning", "group-info"]);
    const titles = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(titles).toEqual(["Critical finding", "Second critical", "Warning finding", "Info finding"]);
    expect(screen.getByText(/Overall: Needs attention/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Move the dish" })).not.toBeChecked();
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument();
  });

  it("groupFindings omits empty groups", () => {
    expect(groupFindings([report.findings[0]]).map((g) => g.severity)).toEqual(["info"]);
  });
});

describe("AI error mapping", () => {
  it.each([
    ["no_api_key", "settings"],
    ["ai_auth", "settings"],
    ["ai_rate_limit", "retry"],
    ["ai_unavailable", "retry"],
    ["ai_refused", "retry"],
    ["ai_invalid_response", "retry"],
    ["offline", "retry"],
    ["insufficient_data", "retry"],
  ] as const)("%s keeps its kind and has copy with a %s action", (kind, action) => {
    const e = normalizeError({ kind, message: "x" });
    expect(e.kind).toBe(kind);
    expect(errorTitle(kind)).toBeTruthy();
    const copy = advisorErrorCopy(kind);
    expect(copy.title).toBeTruthy();
    expect(copy.body).toBeTruthy();
    expect(copy.action).toBe(action);
  });

  it("detects insufficient history", () => {
    expect(isInsufficientHistory(summary)).toBe(false);
    expect(isInsufficientHistory({ ...summary, historyMinutes: 59 })).toBe(true);
  });
});
