import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import en from "@/locales/en.json";
import itCatalog from "@/locales/it.json";
import i18n, { applyLanguage, resolveLanguage } from "@/i18n";
import { formatBps, formatDuration, formatMs } from "@/lib/format";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveView } from "@/components/live/live-view";
import type { TelemetrySnapshot } from "@/types/models";

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

afterEach(() => applyLanguage("en"));

describe("translation catalogs", () => {
  it("have exactly the same keys in English and Italian", () => {
    expect(Object.keys(itCatalog).sort()).toEqual(Object.keys(en).sort());
  });

  it("have a non-empty Italian value with the same placeholders for every key", () => {
    for (const [key, value] of Object.entries(en)) {
      const itValue = (itCatalog as Record<string, string>)[key];
      expect(itValue, key).toBeTruthy();
      expect(placeholders(itValue), key).toEqual(placeholders(value));
    }
  });
});

describe("language resolution", () => {
  it("resolves system from the browser language, falling back to English", () => {
    expect(resolveLanguage("system", "it-IT")).toBe("it");
    expect(resolveLanguage("system", "de-DE")).toBe("en");
    expect(resolveLanguage("en", "it-IT")).toBe("en");
    expect(resolveLanguage("it", "en-US")).toBe("it");
  });

  it("formats numbers with Italian decimals and day units", () => {
    applyLanguage("it");
    expect(formatBps(12_340_000)).toBe("12,3 Mbps");
    expect(formatMs(31.46)).toBe("31,5 ms");
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe("2 g 4 h");
    expect(i18n.t("{{count}} days", { count: 1 })).toBe("1 giorno");
    expect(i18n.t("{{count}} days", { count: 30 })).toBe("30 giorni");
  });
});

describe("Live in Italian", () => {
  it("renders translated labels and readiness chips", () => {
    applyLanguage("it");
    const snap = {
      timestampMs: 1_000,
      uptimeS: 3600,
      downlinkBps: 25_500_000,
      uplinkBps: null,
      powerW: null,
      jitterMs: 4.2,
      readiness: { videoCall: "good", gaming: "fair", streaming: "poor" },
      popPingLatencyMs: 31.4,
      popPingDropRate: 0.002,
      snrAboveNoiseFloor: true,
      signalQuality: null,
      obstruction: { fractionObstructed: 0.001, timeObstructed: null, validS: null, currentlyObstructed: false, avgProlongedObstructionIntervalS: null },
      alignment: { azimuthDeg: null, elevationDeg: null, desiredAzimuthDeg: null, desiredElevationDeg: null, tiltAngleDeg: null, uncertaintyDeg: null, estimationState: null },
      gpsValid: true,
      gpsSats: 12,
      dlBandwidthRestrictedReason: "NO_LIMIT",
      ulBandwidthRestrictedReason: null,
      softwareUpdateState: null,
      disablementCode: null,
      alerts: [],
      isHeating: false,
    } as TelemetrySnapshot;
    render(
      <TooltipProvider>
        <LiveView snapshot={snap} buffer={[snap]} capabilities={null} connection={null} error={null} now={2_000} pollIntervalS={3} />
      </TooltipProvider>,
    );
    expect(screen.getByRole("group", { name: "Latenza" })).toHaveTextContent("31,4");
    expect(screen.getByText("Nessun avviso attivo")).toBeInTheDocument();
    const ready = screen.getByRole("region", { name: "Adatta per" });
    expect(within(ready).getByText("Videochiamate")).toBeInTheDocument();
    expect(within(ready).getByText("Buona")).toBeInTheDocument();
    expect(within(ready).getByText("Scarsa")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Jitter" })).toHaveTextContent("Costante");
  });
});
