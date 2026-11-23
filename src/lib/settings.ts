import type { MockMode, MockProfile, Settings } from "@/types/models";
import { isHttpUrl } from "@/lib/advisor";
import { tr as t } from "@/i18n";
import { tk } from "@/i18n/keys";

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
  if (!isHostPort(s.dishAddress)) e.dishAddress = t("Use host:port, for example 192.168.100.1:9200.");
  if (s.routerAddress.trim() && !isHostPort(s.routerAddress)) {
    e.routerAddress = t("Use host:port, for example 192.168.1.1:9000, or leave empty.");
  }
  if (!Number.isInteger(s.livePollIntervalS) || s.livePollIntervalS < 1 || s.livePollIntervalS > 60) {
    e.livePollIntervalS = t("Whole seconds between 1 and 60.");
  }
  if (!s.claudeModel.trim()) e.claudeModel = t("Enter a model ID.");
  if (s.dataCapGb !== null && !(Number.isFinite(s.dataCapGb) && s.dataCapGb > 0)) {
    e.dataCapGb = t("Enter a positive number of GB, or leave empty for no cap.");
  }
  if (!Number.isInteger(s.billingCycleDay) || s.billingCycleDay < 1 || s.billingCycleDay > 28) {
    e.billingCycleDay = t("Pick a day between 1 and 28.");
  }
  if (s.aiProvider === "local") {
    if (!isHttpUrl(s.localAiUrl.trim())) e.localAiUrl = t("Use an http:// or https:// address, for example http://localhost:11434.");
    if (!s.localAiModel.trim()) e.localAiModel = t("Choose or type the name of a model on your server.");
  }
  if (s.battery) {
    const b = s.battery;
    const ok =
      Number.isFinite(b.capacityAh) && b.capacityAh > 0 && b.capacityAh <= 10_000 &&
      Number.isFinite(b.voltage) && b.voltage > 0 && b.voltage <= 1_000 &&
      Number.isFinite(b.usableFraction) && b.usableFraction >= 0.1 && b.usableFraction <= 1;
    if (!ok) e.battery = t("Check the battery values: capacity and voltage above 0, usable between 10 and 100 %.");
  }
  const { quietStartHour: qs, quietEndHour: qe } = s.notifications;
  if ((qs === null) !== (qe === null)) e.quietHours = t("Set both a start and an end, or turn quiet hours off.");
  else if (qs !== null && qs === qe) e.quietHours = t("Start and end must be different hours.");
  return e;
}

export const MOCK_MODE_LABELS: Record<MockMode, string> = {
  auto: tk("Auto (when dish is unreachable)"),
  on: tk("Always"),
  off: tk("Never"),
};

export const MOCK_PROFILE_LABELS: Record<MockProfile, string> = {
  mini: tk("Mini"),
  standard: tk("Standard"),
  standard_actuated: tk("Standard Actuated"),
  obstructed: tk("Obstructed sky"),
  throttled: tk("Throttled plan"),
  offline: tk("Offline dish"),
};


export const NOTIFICATION_TYPES = [
  { key: "outage", label: tk("Outages"), hint: tk("Connection drops longer than a few seconds") },
  { key: "obstruction", label: tk("New obstructions"), hint: tk("Something starts blocking the sky view") },
  { key: "thermal", label: tk("Overheating"), hint: tk("Thermal throttling or shutdown") },
  { key: "throttle", label: tk("Plan speed limit"), hint: tk("Starlink starts limiting your speed") },
  { key: "reboot", label: tk("Reboots"), hint: tk("The dish restarted") },
  { key: "firmwareUpdate", label: tk("Software updates"), hint: tk("An update is waiting to install") },
  { key: "dataCap", label: tk("Data cap"), hint: tk("Usage reaches 80 % and 100 % of your cap") },
] as const;

export type NotificationTypeKey = (typeof NOTIFICATION_TYPES)[number]["key"];

export function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}
