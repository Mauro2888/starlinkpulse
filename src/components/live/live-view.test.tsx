import { describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ConnectionStatus, DishCapabilities, TelemetrySnapshot } from "@/types/models";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveView, type LiveViewProps } from "@/components/live/live-view";

const NOW = 1_700_000_000_000;

const nullSnapshot: TelemetrySnapshot = {
  timestampMs: NOW - 1_000,
  uptimeS: null,
  downlinkBps: null,
  uplinkBps: 2_500_000,
  powerW: null,
  popPingLatencyMs: null,
  popPingDropRate: null,
  snrAboveNoiseFloor: null,
  signalQuality: null,
  obstruction: {
    fractionObstructed: null,
    timeObstructed: null,
    validS: null,
    currentlyObstructed: null,
    avgProlongedObstructionIntervalS: null,
  },
  alignment: {
    azimuthDeg: null,
    elevationDeg: null,
    desiredAzimuthDeg: null,
    desiredElevationDeg: null,
    tiltAngleDeg: null,
    uncertaintyDeg: null,
  },
  gpsValid: null,
  gpsSats: null,
  dlBandwidthRestrictedReason: "POLICY_LIMIT",
  ulBandwidthRestrictedReason: null,
  softwareUpdateState: null,
  disablementCode: null,
  alerts: ["thermalThrottle"],
  isHeating: null,
};

const caps: DishCapabilities = {
  hardwareVersion: "mini1_prod2",
  softwareVersion: null,
  actuators: "no",
  canStow: false,
  canReboot: true,
  canSetSnowMelt: false,
  hasObstructionMap: false,
  hasPowerTelemetry: true,
  hasAlignmentStats: false,
  hasRouter: true,
  isMock: false,
  snowMeltMode: null,
};

const connected: ConnectionStatus = {
  state: "connected",
  dishAddress: "192.168.100.1:9200",
  routerAvailable: true,
  lastError: null,
  lastSuccessMs: NOW,
};

function renderLive(props: Partial<LiveViewProps> = {}) {
  return render(
    <TooltipProvider>
      <LiveView
        snapshot={nullSnapshot}
        buffer={[nullSnapshot]}
        capabilities={caps}
        connection={connected}
        error={null}
        now={NOW}
        pollIntervalS={3}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("LiveView", () => {
  it("renders a snapshot full of nulls without crashing, using dashes", () => {
    renderLive();
    const download = screen.getByRole("group", { name: "Download" });
    expect(within(download).getByText(/No data/)).toBeInTheDocument();
    expect(within(download).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Upload" })).getByText("2.5")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Latency" })).getByText("—")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Signal" })).getByText(/numeric signal quality/)).toBeInTheDocument();
    // Power tile appears because the dish reports power telemetry, even without a value yet.
    expect(screen.getByRole("group", { name: "Power" })).toBeInTheDocument();
  });

  it("explains POLICY_LIMIT and lists alerts in plain words", () => {
    renderLive();
    expect(screen.getByText("Speed limited by plan")).toBeInTheDocument();
    expect(screen.getByText("Thermal throttling")).toBeInTheDocument();
    expect(screen.getByText("Starlink Mini")).toBeInTheDocument();
  });

  it("shows power from the snapshot when reported", () => {
    renderLive({ snapshot: { ...nullSnapshot, powerW: 31.24 } });
    expect(within(screen.getByRole("group", { name: "Power" })).getByText("31.2")).toBeInTheDocument();
  });

  it("labels the GPS count as GPS satellites with an explanation", () => {
    renderLive({ snapshot: { ...nullSnapshot, gpsValid: true, gpsSats: 14 } });
    expect(screen.getByText("GPS satellites")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText(/does not report how many Starlink satellites/)).toBeInTheDocument();
    expect(screen.queryByText(/^satellites$/i)).not.toBeInTheDocument();
  });

  it("hides the power tile when the dish has no power telemetry", () => {
    renderLive({ capabilities: { ...caps, hasPowerTelemetry: false } });
    expect(screen.queryByRole("group", { name: "Power" })).not.toBeInTheDocument();
  });

  it("shows an offline state when there is no snapshot and the dish is offline", () => {
    renderLive({
      snapshot: null,
      buffer: [],
      connection: { ...connected, state: "offline", lastError: "No response within 5 s" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Dish not reachable");
    expect(screen.getByRole("alert")).toHaveTextContent("No response within 5 s");
  });

  it("labels a deliberate demo differently from an automatic fallback", () => {
    renderLive({ connection: { ...connected, state: "mock" }, mockMode: "on" });
    expect(screen.getByText("Demo mode: showing simulated data")).toBeInTheDocument();
    cleanup();
    renderLive({ connection: { ...connected, state: "mock", lastError: "No response within 5 s." }, mockMode: "auto" });
    expect(screen.getByText("Dish not reachable — showing simulated data")).toBeInTheDocument();
    expect(screen.getByText(/No response within 5 s\./)).toBeInTheDocument();
  });

  it("warns when data is stale", () => {
    renderLive({ now: NOW + 60_000 });
    expect(screen.getByText("Data is stale")).toBeInTheDocument();
  });
});
