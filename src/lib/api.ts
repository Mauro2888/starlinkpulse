// Typed wrappers around the Tauri command/event contract (docs/api.md).
// Outside Tauri (plain browser, `npm run dev`) an in-browser mock backend is
// loaded lazily from `src/lib/mock/` so the UI can be developed without Rust.

import type {
  AiReport,
  AlignmentModeEvent,
  ConnectionStatus,
  DailyEnergy,
  DataUsage,
  DiagnosticSummary,
  DishCapabilities,
  DishEvent,
  HistoryPoint,
  LocationStats,
  ObstructionMap,
  Settings,
  SnowMeltMode,
  TelemetrySnapshot,
  TimeOfDayStats,
  UpdateInfo,
  UptimeStats,
  WifiDevices,
} from "@/types/models";
import { normalizeError } from "@/lib/errors";

export { ApiError, normalizeError } from "@/lib/errors";

/** Command name -> argument and result types. */
export interface CommandMap {
  get_connection_status: { args: void; result: ConnectionStatus };
  get_capabilities: { args: void; result: DishCapabilities };
  get_live_snapshot: { args: void; result: TelemetrySnapshot };
  get_history: { args: { rangeMinutes: number }; result: HistoryPoint[] };
  get_events: { args: { rangeMinutes: number }; result: DishEvent[] };
  get_obstruction_map: { args: void; result: ObstructionMap };
  get_settings: { args: void; result: Settings };
  update_settings: { args: { settings: Settings }; result: Settings };
  reboot_dish: { args: void; result: null };
  stow_dish: { args: void; result: null };
  unstow_dish: { args: void; result: null };
  set_snow_melt: { args: { mode: SnowMeltMode }; result: null };
  set_api_key: { args: { key: string }; result: null };
  has_api_key: { args: void; result: boolean };
  delete_api_key: { args: void; result: null };
  export_history_csv: { args: { rangeMinutes: number }; result: string | null };
  get_uptime_stats: { args: void; result: UptimeStats };
  check_for_update: { args: void; result: UpdateInfo };
  install_update: { args: void; result: null };
  open_releases_page: { args: void; result: null };
  get_location_stats: { args: void; result: LocationStats[] };
  rename_location: { args: { from: string; to: string }; result: null };
  delete_location: { args: { name: string }; result: null };
  get_time_of_day_stats: { args: { days: number }; result: TimeOfDayStats };
  get_energy: { args: { days: number }; result: DailyEnergy[] };
  set_alignment_mode: { args: { enabled: boolean }; result: null };
  get_data_usage: { args: { days: number }; result: DataUsage };
  send_test_notification: { args: void; result: null };
  run_diagnostics: { args: void; result: AiReport };
  get_last_rules_report: { args: void; result: AiReport | null };
  list_local_models: { args: void; result: string[] };
  preview_ai_payload: { args: void; result: DiagnosticSummary };
  analyze_network_with_ai: { args: { payload: DiagnosticSummary }; result: AiReport };
  get_last_ai_report: { args: void; result: AiReport | null };
  get_wifi_devices: { args: void; result: WifiDevices };
  get_support_report: { args: void; result: string };
  export_support_report: { args: void; result: string | null };
}

/** Event name -> payload type. */
export interface EventMap {
  telemetry: TelemetrySnapshot;
  "connection-status": ConnectionStatus;
  capabilities: DishCapabilities;
  "alignment-mode": AlignmentModeEvent;
}

export type CommandName = keyof CommandMap;
export type EventName = keyof EventMap;
export type Unlisten = () => void;

/** Minimal transport implemented by Tauri and by the mock. */
export interface Backend {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let backendPromise: Promise<Backend> | null = null;

async function createTauriBackend(): Promise<Backend> {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  return {
    invoke: (cmd, args) => invoke(cmd, args),
    listen: (event, handler) => listen(event, (e) => handler(e.payload)),
  };
}

async function createMockBackend(): Promise<Backend> {
  const { getMockBackend } = await import("@/lib/mock");
  return getMockBackend();
}

function getBackend(): Promise<Backend> {
  backendPromise ??= isTauri() ? createTauriBackend() : createMockBackend();
  return backendPromise;
}

/** Test hook: inject a fake backend (pass null to reset). */
export function setBackendForTesting(backend: Backend | null): void {
  backendPromise = backend ? Promise.resolve(backend) : null;
}

/** Calls a command; always rejects with `ApiError`. */
export async function call<K extends CommandName>(
  cmd: K,
  ...args: CommandMap[K]["args"] extends void ? [] : [CommandMap[K]["args"]]
): Promise<CommandMap[K]["result"]> {
  try {
    const backend = await getBackend();
    return (await backend.invoke(cmd, args[0] as Record<string, unknown> | undefined)) as CommandMap[K]["result"];
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Subscribes to a backend event. Returns an unlisten function. */
export async function subscribe<E extends EventName>(
  event: E,
  handler: (payload: EventMap[E]) => void,
): Promise<Unlisten> {
  const backend = await getBackend();
  return backend.listen(event, (p) => handler(p as EventMap[E]));
}

export const api = {
  getConnectionStatus: () => call("get_connection_status"),
  getCapabilities: () => call("get_capabilities"),
  getLiveSnapshot: () => call("get_live_snapshot"),
  getHistory: (rangeMinutes: number) => call("get_history", { rangeMinutes }),
  getEvents: (rangeMinutes: number) => call("get_events", { rangeMinutes }),
  getObstructionMap: () => call("get_obstruction_map"),
  getSettings: () => call("get_settings"),
  updateSettings: (settings: Settings) => call("update_settings", { settings }),
  rebootDish: () => call("reboot_dish").then(() => undefined),
  stowDish: () => call("stow_dish").then(() => undefined),
  unstowDish: () => call("unstow_dish").then(() => undefined),
  setSnowMelt: (mode: SnowMeltMode) => call("set_snow_melt", { mode }).then(() => undefined),
  setApiKey: (key: string) => call("set_api_key", { key }).then(() => undefined),
  hasApiKey: () => call("has_api_key"),
  deleteApiKey: () => call("delete_api_key").then(() => undefined),
  /** Opens a native save dialog (Tauri only). Returns the saved path, or null if cancelled. */
  exportHistoryCsv: (rangeMinutes: number) => call("export_history_csv", { rangeMinutes }),
  getUptimeStats: () => call("get_uptime_stats"),
  checkForUpdate: () => call("check_for_update"),
  /** Downloads, verifies, installs and restarts the app. */
  installUpdate: () => call("install_update").then(() => undefined),
  /** Opens the build's fixed GitHub Releases URL in the system browser. */
  openReleasesPage: () => call("open_releases_page").then(() => undefined),
  getLocationStats: () => call("get_location_stats"),
  renameLocation: (from: string, to: string) => call("rename_location", { from, to }).then(() => undefined),
  deleteLocation: (name: string) => call("delete_location", { name }).then(() => undefined),
  getTimeOfDayStats: (days: number) => call("get_time_of_day_stats", { days }),
  getEnergy: (days: number) => call("get_energy", { days }),
  /** Fast (1 s) read-only polling for guided alignment; auto-off after 10 min. */
  setAlignmentMode: (enabled: boolean) => call("set_alignment_mode", { enabled }).then(() => undefined),
  getDataUsage: (days: number) => call("get_data_usage", { days }),
  sendTestNotification: () => call("send_test_notification").then(() => undefined),
  /** Built-in rule engine: offline, free, no key. */
  runDiagnostics: () => call("run_diagnostics"),
  /** Last built-in rules report (persisted). */
  getLastRulesReport: () => call("get_last_rules_report"),
  /** Models on the configured local server (Ollama / OpenAI-compatible). */
  listLocalModels: () => call("list_local_models"),
  previewAiPayload: () => call("preview_ai_payload"),
  /** Sends exactly the previewed payload to the configured AI provider. */
  analyzeNetworkWithAi: (payload: DiagnosticSummary) => call("analyze_network_with_ai", { payload }),
  getLastAiReport: () => call("get_last_ai_report"),
  /** Starlink router clients; names are display-only. */
  getWifiDevices: () => call("get_wifi_devices"),
  /** Anonymized Markdown report (no IDs, location or device names). */
  getSupportReport: () => call("get_support_report"),
  /** Native save dialog; returns the saved path, or null if cancelled. */
  exportSupportReport: () => call("export_support_report"),
} as const;

export const events = {
  onTelemetry: (h: (s: TelemetrySnapshot) => void) => subscribe("telemetry", h),
  onConnectionStatus: (h: (s: ConnectionStatus) => void) => subscribe("connection-status", h),
  onCapabilities: (h: (c: DishCapabilities) => void) => subscribe("capabilities", h),
  onAlignmentMode: (h: (e: AlignmentModeEvent) => void) => subscribe("alignment-mode", h),
} as const;
