import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WifiDevice } from "@/types/models";
import { weakSignalTip, wifiQuality } from "@/lib/wifi";
import { mockWifi } from "@/lib/mock/v12";
import { PROFILES } from "@/lib/mock/profiles";
import { WifiDevicesView } from "@/components/live/wifi-card";

const dev = (over: Partial<WifiDevice>): WifiDevice => ({
  name: null, band: "5ghz", role: "CLIENT", signalDbm: null, snr: null, quality: null,
  linkDownMbps: null, linkUpMbps: null, downMbps: null, upMbps: null, downBytes: null, upBytes: null, connectedS: null,
  ...over,
});

describe("wifi helpers", () => {
  it("derives quality from dBm when the backend gives none", () => {
    expect(wifiQuality(dev({ signalDbm: -50 }))).toBe("good");
    expect(wifiQuality(dev({ signalDbm: -70 }))).toBe("fair");
    expect(wifiQuality(dev({ signalDbm: -90 }))).toBe("poor");
    expect(wifiQuality(dev({ signalDbm: -50, quality: "poor" }))).toBe("poor");
    expect(wifiQuality(dev({ band: "ethernet", signalDbm: -50 }))).toBeNull();
  });

  it("tips only for weak clients, not repeaters", () => {
    expect(weakSignalTip([dev({ signalDbm: -50 })])).toBeNull();
    expect(weakSignalTip([dev({ signalDbm: -90, role: "REPEATER" })])).toBeNull();
    expect(weakSignalTip([dev({ signalDbm: -90 })])).toMatch(/5\/6 GHz/);
    expect(weakSignalTip([dev({ band: "2.4ghz", signalDbm: -90 })])).toMatch(/^Weak signal/);
  });
});

describe("v1.2 mock data", () => {
  const withRouter = Object.values(PROFILES).find((p) => p.capabilities.hasRouter)!;

  it("has 6 devices incl. a poor 5 GHz client and a mesh repeater", () => {
    const w = mockWifi(withRouter);
    expect(w.available).toBe(true);
    expect(w.devices).toHaveLength(6);
    expect(w.devices.some((d) => d.band === "5ghz" && d.signalDbm === -90)).toBe(true);
    expect(w.devices.some((d) => d.role === "REPEATER")).toBe(true);
  });
});

describe("WifiDevicesView", () => {
  it("falls back to generic names and flags weak signals", () => {
    render(
      <WifiDevicesView
        error={null}
        data={{
          available: true,
          updatedMs: 0,
          router: { online: true, ipv6: false, dishPingMs: 0.5, popPingMs: 23.4 },
          devices: [dev({ signalDbm: -90 }), dev({ role: "REPEATER", signalDbm: -60 }), dev({ name: "Laptop", signalDbm: -50 })],
        }}
      />,
    );
    expect(screen.getByText("Device 1")).toBeInTheDocument();
    expect(screen.getByText("Mesh repeater")).toBeInTheDocument();
    expect(screen.getByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText(/1 weak signal/)).toBeInTheDocument();
    expect(screen.getByText(/never saved/)).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Not active")).toBeInTheDocument();
    expect(screen.getByText("23 ms")).toBeInTheDocument();
  });

  it("shows the unavailable state without a router", () => {
    render(<WifiDevicesView error={null} data={{ available: false, devices: [], updatedMs: null, router: null }} />);
    expect(screen.getByText("Starlink router not reachable")).toBeInTheDocument();
  });
});
