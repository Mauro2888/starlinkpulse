// Dish model profiles used by the in-browser mock backend (dev only).

import type { DishCapabilities, MockProfile } from "@/types/models";

export interface ProfileSpec {
  capabilities: Omit<DishCapabilities, "isMock" | "snowMeltMode">;
  /** Typical downlink/uplink in bps. */
  downBps: number;
  upBps: number;
  latencyMs: number;
  dropRate: number;
  obstructed: number;
  powerW: number | null;
  restricted: string | null;
  alerts: string[];
  /** Outages per 24 h, and the cause mix. */
  outagesPerDay: number;
  causes: string[];
  /** Simulate older firmware that omits numeric signal quality. */
  hasSignalQuality: boolean;
  offline: boolean;
}

const base: ProfileSpec = {
  capabilities: {
    hardwareVersion: "rev3_proto2",
    softwareVersion: "2026.11.04.mr51230",
    actuators: "no",
    canStow: false,
    canReboot: true,
    canSetSnowMelt: true,
    hasObstructionMap: true,
    hasPowerTelemetry: true,
    hasAlignmentStats: true,
    hasRouter: true,
  },
  downBps: 180e6,
  upBps: 18e6,
  latencyMs: 31,
  dropRate: 0.004,
  obstructed: 0.002,
  powerW: 48,
  restricted: null,
  alerts: [],
  outagesPerDay: 12,
  causes: ["NO_SCHEDULE", "NO_DOWNLINK", "OBSTRUCTED"],
  hasSignalQuality: true,
  offline: false,
};

export const PROFILES: Record<MockProfile, ProfileSpec> = {
  mini: {
    ...base,
    capabilities: { ...base.capabilities, hardwareVersion: "mini1_prod2" },
    downBps: 115e6,
    upBps: 12e6,
    latencyMs: 34,
    powerW: 27,
  },
  standard: base,
  standard_actuated: {
    ...base,
    capabilities: {
      ...base.capabilities,
      hardwareVersion: "rev2_proto3",
      softwareVersion: "2026.10.21.mr50912",
      actuators: "yes",
      canStow: true,
      hasPowerTelemetry: false,
      hasRouter: false,
    },
    powerW: null,
    hasSignalQuality: false,
  },
  obstructed: {
    ...base,
    downBps: 90e6,
    upBps: 8e6,
    latencyMs: 46,
    dropRate: 0.06,
    obstructed: 0.084,
    alerts: ["lowerSignalThanPredicted"],
    outagesPerDay: 30,
    causes: ["OBSTRUCTED", "OBSTRUCTED", "OBSTRUCTED", "NO_DOWNLINK"],
  },
  throttled: {
    ...base,
    downBps: 4.5e6,
    upBps: 0.9e6,
    latencyMs: 58,
    restricted: "POLICY_LIMIT",
  },
  offline: {
    ...base,
    capabilities: {
      ...base.capabilities,
      hardwareVersion: null,
      softwareVersion: null,
      actuators: "unknown",
      canReboot: false,
      canSetSnowMelt: false,
      hasObstructionMap: false,
      hasPowerTelemetry: false,
      hasAlignmentStats: false,
      hasRouter: false,
    },
    offline: true,
    powerW: null,
  },
};
