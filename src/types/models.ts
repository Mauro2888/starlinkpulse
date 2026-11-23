// Shared data structures returned by the Rust backend.
// Keep in sync with `src-tauri/src/models.rs`.
// All telemetry fields are nullable: dish models and firmware differ.

export type ActuatorSupport = "yes" | "no" | "unknown";

export interface DishCapabilities {
  hardwareVersion: string | null;
  softwareVersion: string | null;
  actuators: ActuatorSupport;
  canStow: boolean;
  canReboot: boolean;
  canSetSnowMelt: boolean;
  hasObstructionMap: boolean;
  hasPowerTelemetry: boolean;
  hasAlignmentStats: boolean;
  hasRouter: boolean;
  isMock: boolean;
  /** Current snow-melt mode read from dish config, if known. */
  snowMeltMode: SnowMeltMode | null;
}

export interface ObstructionStats {
  fractionObstructed: number | null;
  timeObstructed: number | null;
  validS: number | null;
  currentlyObstructed: boolean | null;
  avgProlongedObstructionIntervalS: number | null;
}

export interface AlignmentStats {
  azimuthDeg: number | null;
  elevationDeg: number | null;
  desiredAzimuthDeg: number | null;
  desiredElevationDeg: number | null;
  tiltAngleDeg: number | null;
  uncertaintyDeg: number | null;
  /** Attitude estimator state, e.g. "FILTER_CONVERGED". */
  estimationState: string | null;
}

export interface TelemetrySnapshot {
  timestampMs: number;
  uptimeS: number | null;
  downlinkBps: number | null;
  uplinkBps: number | null;
  /** Latest dish power draw in watts (from history samples), if available. */
  powerW: number | null;
  /** Approx. jitter = mean |Δlatency| between consecutive live samples over ~2 min. */
  jitterMs: number | null;
  readiness: Readiness | null;
  popPingLatencyMs: number | null;
  popPingDropRate: number | null;
  snrAboveNoiseFloor: boolean | null;
  signalQuality: number | null;
  obstruction: ObstructionStats;
  alignment: AlignmentStats;
  gpsValid: boolean | null;
  gpsSats: number | null;
  dlBandwidthRestrictedReason: string | null;
  ulBandwidthRestrictedReason: string | null;
  softwareUpdateState: string | null;
  disablementCode: string | null;
  alerts: string[];
  isHeating: boolean | null;
}

export interface HistoryPoint {
  minuteMs: number;
  samples: number;
  latencyAvgMs: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  dropRateAvg: number | null;
  downlinkAvgBps: number | null;
  downlinkMaxBps: number | null;
  uplinkAvgBps: number | null;
  uplinkMaxBps: number | null;
  powerAvgW: number | null;
  powerMaxW: number | null;
}

export interface DishEvent {
  startMs: number;
  durationMs: number;
  cause: string;
  severity: string | null;
}

export interface DiagnosticSummary {
  /** Language the advisor should answer in (e.g. "en"). */
  language: string;
  windowHours: number;
  /** Minutes of history available inside the window. */
  historyMinutes: number;
  hardwareVersion: string | null;
  softwareVersion: string | null;
  latencyAvgMs: number | null;
  latencyP95Ms: number | null;
  dropRateAvg: number | null;
  fractionObstructed: number | null;
  outageCount: number;
  outageTotalS: number;
  outagesByCause: [string, number][];
  worstHours: number[];
  throttledMinutes: number;
  /** Correction to apply = desired − actual, azimuth wrapped to (−180, 180]; positive = rotate clockwise seen from above. */
  azimuthCorrectionDeg: number | null;
  /** Correction to apply = desired − actual; positive = tilt up. */
  elevationCorrectionDeg: number | null;
  /** True when the data comes from the mock client (simulated). */
  isSimulated: boolean;
  weakestWifiSignalDbm: number | null;
  /** Findings of the built-in rule engine, given to the AI to explain (empty for rules-only). */
  ruleFindings: AiFinding[];
}

export type ConnectionState = "connecting" | "connected" | "offline" | "mock";

export interface ConnectionStatus {
  state: ConnectionState;
  dishAddress: string;
  routerAvailable: boolean;
  lastError: string | null;
  lastSuccessMs: number | null;
}

export type MockMode = "auto" | "on" | "off";
export type MockProfile =
  | "mini"
  | "standard"
  | "standard_actuated"
  | "obstructed"
  | "throttled"
  | "offline";
export type SnowMeltMode = "auto" | "always_on" | "always_off";

export interface Settings {
  dishAddress: string;
  routerAddress: string;
  readOnly: boolean;
  mockMode: MockMode;
  mockProfile: MockProfile;
  livePollIntervalS: number;
  claudeModel: string;
  /** Hide to tray on window close instead of quitting (default false on Linux). */
  closeToTray: boolean;
  /** Start StarlinkPulse when the user logs in. Default false. */
  launchAtLogin: boolean;
  /** UI + notifications + rule texts language. "system" follows the OS. */
  language: AppLanguage;
  /** Name of the current dish location (e.g. "Roof"); null = untagged. */
  activeLocation: string | null;
  /** Optional battery for off-grid runtime estimates; null = not configured. */
  battery: BatteryConfig | null;
  /** Optional place for weather correlation (opt-in); null = off. */
  weatherLocation: WeatherLocation | null;
  notifications: NotificationSettings;
  /** Monthly data cap in GB for usage alerts; null = none. */
  dataCapGb: number | null;
  /** Day of month (1-28) when the billing cycle resets. */
  billingCycleDay: number;
  /** Optional AI explanation provider. Default "off". */
  aiProvider: AiProvider;
  /** Local model server (Ollama / OpenAI-compatible), e.g. http://localhost:11434 */
  localAiUrl: string;
  localAiKind: LocalAiKind;
  localAiModel: string;
}

export type WifiBand = "2.4ghz" | "5ghz" | "6ghz" | "ethernet" | "unknown";
export type WifiQuality = "good" | "fair" | "poor";

/** One router client. `name` is display-only: never log, save or export it. */
export interface WifiDevice {
  name: string | null;
  band: WifiBand;
  role: string | null;
  signalDbm: number | null;
  snr: number | null;
  quality: WifiQuality | null;
  linkDownMbps: number | null;
  linkUpMbps: number | null;
  downMbps: number | null;
  upMbps: number | null;
  downBytes: number | null;
  upBytes: number | null;
  connectedS: number | null;
}

export interface WifiDevices {
  /** False when the Starlink router is not reachable (third-party router / bypass). */
  available: boolean;
  devices: WifiDevice[];
  updatedMs: number | null;
}

export type AiProvider = "off" | "claude" | "local";
export type LocalAiKind = "ollama" | "openai_compatible";

export interface ObstructionMap {
  rows: number;
  cols: number;
  minElevationDeg: number | null;
  maxThetaDeg: number | null;
  referenceFrame: string | null;
  snr: (number | null)[];
}

export type CommandErrorKind =
  | "offline"
  | "unsupported"
  | "read_only"
  | "timeout"
  | "invalid_input"
  | "keyring"
  | "internal"
  | "no_api_key"
  | "ai_auth"
  | "ai_rate_limit"
  | "ai_unavailable"
  | "ai_refused"
  | "ai_invalid_response"
  | "insufficient_data";

export interface CommandError {
  kind: CommandErrorKind;
  message: string;
}

// ---- Phase 4: AI Advisor ----

export type AiFindingCategory =
  | "wifi"
  | "obstruction"
  | "starlink_network"
  | "hardware"
  | "power"
  | "configuration";
export type AiSeverity = "info" | "warning" | "critical";
export type AiOverallHealth = "good" | "fair" | "poor";

export interface AiFinding {
  category: AiFindingCategory;
  severity: AiSeverity;
  title: string;
  detail: string;
  actions: string[];
}

export type ReportSource = "rules" | "claude" | "local";

export interface AiReport {
  generatedAtMs: number;
  /** Who produced the report: built-in rule engine, Claude API, or a local model. */
  source: ReportSource;
  /** Model that produced the report (may differ from the requested one after a fallback). */
  model: string;
  overallHealth: AiOverallHealth;
  headline: string;
  findings: AiFinding[];
  /** Exact anonymized payload that was sent. */
  payload: DiagnosticSummary;
}

// ---- Phase 4.5: notifications, uptime, data usage ----

export interface NotificationSettings {
  enabled: boolean;
  outage: boolean;
  obstruction: boolean;
  thermal: boolean;
  throttle: boolean;
  reboot: boolean;
  firmwareUpdate: boolean;
  dataCap: boolean;
  /** Local hour 0-23; both null = no quiet hours. */
  quietStartHour: number | null;
  quietEndHour: number | null;
}

export interface UptimeWindow {
  /** "24h" | "7d" | "30d" */
  label: string;
  windowS: number;
  /** Seconds covered by data (app running / history available). */
  coveredS: number;
  /** null when coverage is too low to be meaningful. */
  uptimePct: number | null;
  outageCount: number;
  outageS: number;
}

export interface UptimeStats {
  windows: UptimeWindow[];
}

export interface DailyUsage {
  /** Local midnight, Unix ms. */
  dayMs: number;
  downloadBytes: number;
  uploadBytes: number;
}

export interface DataUsage {
  daily: DailyUsage[];
  cycleStartMs: number;
  cycleDownloadBytes: number;
  cycleUploadBytes: number;
  /** Configured cap in GB, null = no cap. */
  capGb: number | null;
  /** Estimate disclaimer is required in UI: derived from throughput samples, not billing data. */
  isEstimate: true;
}

// ---- Phase 5: updates ----

export interface UpdateInfo {
  /** False when the build has no updater public key configured. */
  updaterConfigured: boolean;
  available: boolean;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
}

// ---- Phase 4.8: guided alignment ----

export interface AlignmentModeEvent {
  enabled: boolean;
  /** Seconds until automatic stop. */
  remainingS: number;
}

// ---- Phase 6 (v1.1): i18n, locations, time-of-day, readiness, energy ----

export type AppLanguage = "system" | "en" | "it";

export type ReadinessLevel = "good" | "fair" | "poor";

export interface Readiness {
  videoCall: ReadinessLevel;
  gaming: ReadinessLevel;
  streaming: ReadinessLevel;
}

export interface BatteryConfig {
  capacityAh: number;
  voltage: number;
  /** Usable fraction 0.1–1 (e.g. 0.8 for LiFePO4 at 80 % DoD). */
  usableFraction: number;
}

export interface LocationStats {
  name: string;
  firstSeenMs: number;
  lastSeenMs: number;
  coveredS: number;
  outageCount: number;
  outageS: number;
  outagesPerHour: number | null;
  fractionObstructedAvg: number | null;
  latencyAvgMs: number | null;
  latencyP95Ms: number | null;
  dropRateAvg: number | null;
  downlinkAvgBps: number | null;
}

export interface HourCell {
  /** 0 = Monday … 6 = Sunday (local time). */
  weekday: number;
  /** 0–23 local time. */
  hour: number;
  minutes: number;
  latencyAvgMs: number | null;
  latencyP95Ms: number | null;
  dropRateAvg: number | null;
  downlinkAvgBps: number | null;
}

export interface TimeOfDayStats {
  days: number;
  cells: HourCell[];
}

export interface DailyEnergy {
  /** Local midnight, Unix ms. */
  dayMs: number;
  wh: number;
  avgW: number | null;
  peakW: number | null;
  coveredS: number;
}

// ---- Weather correlation (opt-in) ----

export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}

export interface WeatherPlace {
  name: string;
  admin1: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
}

export interface WeatherPoint {
  hourMs: number;
  precipitationMm: number | null;
  snowfallCm: number | null;
  cloudCoverPct: number | null;
  windKmh: number | null;
}

export interface WeatherSeries {
  available: boolean;
  locationName: string | null;
  points: WeatherPoint[];
}
