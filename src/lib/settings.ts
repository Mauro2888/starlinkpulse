import type { MockMode, MockProfile, Settings } from "@/types/models";

export type SettingsErrors = Partial<Record<keyof Settings | "quietHours", string>>;

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
  if (s.dataCapGb !== null && !(Number.isFinite(s.dataCapGb) && s.dataCapGb > 0)) {
    e.dataCapGb = "Enter a positive number of GB, or leave empty for no cap.";
  }
  if (!Number.isInteger(s.billingCycleDay) || s.billingCycleDay < 1 || s.billingCycleDay > 28) {
    e.billingCycleDay = "Pick a day between 1 and 28.";
  }
  const { quietStartHour: qs, quietEndHour: qe } = s.notifications;
  if ((qs === null) !== (qe === null)) e.quietHours = "Set both a start and an end, or turn quiet hours off.";
  else if (qs !== null && qs === qe) e.quietHours = "Start and end must be different hours.";
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


export const NOTIFICATION_TYPES = [
  { key: "outage", label: "Outages", hint: "Connection drops longer than a few seconds" },
  { key: "obstruction", label: "New obstructions", hint: "Something starts blocking the sky view" },
  { key: "thermal", label: "Overheating", hint: "Thermal throttling or shutdown" },
  { key: "throttle", label: "Plan speed limit", hint: "Starlink starts limiting your speed" },
  { key: "reboot", label: "Reboots", hint: "The dish restarted" },
  { key: "firmwareUpdate", label: "Software updates", hint: "An update is waiting to install" },
  { key: "dataCap", label: "Data cap", hint: "Usage reaches 80 % and 100 % of your cap" },
] as const;

export type NotificationTypeKey = (typeof NOTIFICATION_TYPES)[number]["key"];

export function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}
