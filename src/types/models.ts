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
}

export interface TelemetrySnapshot {
  timestampMs: number;
  uptimeS: number | null;
  downlinkBps: number | null;
  uplinkBps: number | null;
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
  windowHours: number;
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
  alignmentDeltaAzimuthDeg: number | null;
  alignmentDeltaElevationDeg: number | null;
  weakestWifiSignalDbm: number | null;
}
