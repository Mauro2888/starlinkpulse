import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { WifiDevice } from "@/types/models";
import { weakSignalTip, wifiQuality } from "@/lib/wifi";
import { mockLanInfo, mockWifi } from "@/lib/mock/v12";
import { PROFILES } from "@/lib/mock/profiles";
import { DEFAULT_SETTINGS } from "@/lib/mock";
import { validateSettings } from "@/lib/settings";
import { setBackendForTesting, type Backend } from "@/lib/api";
import { WifiDevicesView } from "@/components/live/wifi-card";
import { LanDashboardStatus } from "@/components/controls/lan-dashboard";

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

  it("reports the LAN dashboard off / running", () => {
    const off = mockLanInfo({ enabled: false, port: 8686, token: "ABC" });
    expect(off.running).toBe(false);
    const on = mockLanInfo({ enabled: true, port: 8686, token: "ABC" });
    expect(on.urls[0]).toContain(":8686/?k=ABC");
  });

  it("validates the LAN port only when enabled", () => {
    const s = (port: number, enabled: boolean) => ({ ...DEFAULT_SETTINGS, lanDashboard: { enabled, port, token: "X" } });
    expect(validateSettings(s(80, false)).lanDashboard).toBeUndefined();
    expect(validateSettings(s(80, true)).lanDashboard).toBeDefined();
    expect(validateSettings(s(8686, true)).lanDashboard).toBeUndefined();
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
          devices: [dev({ signalDbm: -90 }), dev({ role: "REPEATER", signalDbm: -60 }), dev({ name: "Laptop", signalDbm: -50 })],
        }}
      />,
    );
    expect(screen.getByText("Device 1")).toBeInTheDocument();
    expect(screen.getByText("Mesh repeater")).toBeInTheDocument();
    expect(screen.getByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText(/1 weak signal/)).toBeInTheDocument();
    expect(screen.getByText(/never saved/)).toBeInTheDocument();
  });

  it("shows the unavailable state without a router", () => {
    render(<WifiDevicesView error={null} data={{ available: false, devices: [], updatedMs: null }} />);
    expect(screen.getByText("Starlink router not reachable")).toBeInTheDocument();
  });
});

describe("LanDashboardStatus", () => {
  afterEach(() => setBackendForTesting(null));

  it("renders the QR as a data-URI image and the access code", async () => {
    const saved = { enabled: true, port: 8686, token: "K7QF2M" };
    const backend: Backend = {
      invoke: vi.fn(async () => mockLanInfo(saved)) as Backend["invoke"],
      listen: vi.fn(async () => () => undefined),
    };
    setBackendForTesting(backend);
    render(<LanDashboardStatus saved={saved} />);
    const img = await screen.findByRole("img", { name: /qr code/i });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(screen.getByText("K7QF2M")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/:8686\/\?k=K7QF2M/)).toBeInTheDocument());
  });
});
