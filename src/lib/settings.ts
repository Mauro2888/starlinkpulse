import type { MockMode, MockProfile, Settings } from "@/types/models";

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

const HOST_PORT = /^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*|\[[0-9a-fA-F:]+\]):(\d{1,5})$/;

export function isHostPort(v: string): boolean {
  const m = HOST_PORT.exec(v.trim());
  if (!m) return false;
  const port = Number(m[1]);
  return port > 0 && port <= 65535;
}

/** Client-side validation; the backend validates again. */
export function validateSettings(s: Settings): SettingsErrors {
  const e: SettingsErrors = {};
  if (!isHostPort(s.dishAddress)) e.dishAddress = "Use host:port, for example 192.168.100.1:9200.";
  if (s.routerAddress.trim() && !isHostPort(s.routerAddress)) {
    e.routerAddress = "Use host:port, for example 192.168.1.1:9000, or leave empty.";
  }
  if (!Number.isInteger(s.livePollIntervalS) || s.livePollIntervalS < 1 || s.livePollIntervalS > 60) {
    e.livePollIntervalS = "Whole seconds between 1 and 60.";
  }
  if (!s.claudeModel.trim()) e.claudeModel = "Enter a model ID.";
  return e;
}

export const MOCK_MODE_LABELS: Record<MockMode, string> = {
  auto: "Auto (when dish is unreachable)",
  on: "Always",
  off: "Never",
};

export const MOCK_PROFILE_LABELS: Record<MockProfile, string> = {
  mini: "Mini",
  standard: "Standard",
  standard_actuated: "Standard Actuated",
  obstructed: "Obstructed sky",
  throttled: "Throttled plan",
  offline: "Offline dish",
};

