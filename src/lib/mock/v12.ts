// Mock data for v1.2: Wi-Fi clients and support report.
import type { WifiDevice, WifiDevices } from "@/types/models";
import type { ProfileSpec } from "@/lib/mock/profiles";

const BASE: WifiDevice[] = [
  { name: "MacBook Pro", band: "5ghz", role: "CLIENT", signalDbm: -48, snr: 44, quality: "good", linkDownMbps: 866, linkUpMbps: 780, downMbps: 42.1, upMbps: 3.2, downBytes: 3.1e9, upBytes: 2.4e8, connectedS: 5 * 3600 },
  { name: "iPhone", band: "5ghz", role: "CLIENT", signalDbm: -57, snr: 36, quality: "good", linkDownMbps: 585, linkUpMbps: 390, downMbps: 6.4, upMbps: 0.4, downBytes: 8.2e8, upBytes: 6.1e7, connectedS: 2 * 3600 },
  { name: "Living room TV", band: "5ghz", role: "CLIENT", signalDbm: -66, snr: 27, quality: "fair", linkDownMbps: 351, linkUpMbps: 234, downMbps: 18.7, upMbps: 0.2, downBytes: 6.5e9, upBytes: 9e7, connectedS: 26 * 3600 },
  { name: null, band: "2.4ghz", role: "CLIENT", signalDbm: -71, snr: 21, quality: "fair", linkDownMbps: 72, linkUpMbps: 72, downMbps: 0.1, upMbps: 0.05, downBytes: 4e7, upBytes: 2e7, connectedS: 9 * 86_400 },
  { name: "Office laptop", band: "5ghz", role: "CLIENT", signalDbm: -90, snr: 6, quality: "poor", linkDownMbps: 29, linkUpMbps: 13, downMbps: 1.2, upMbps: 0.3, downBytes: 2.1e8, upBytes: 4e7, connectedS: 3 * 3600 },
  { name: null, band: "5ghz", role: "REPEATER", signalDbm: -62, snr: 31, quality: "good", linkDownMbps: 1200, linkUpMbps: 1200, downMbps: 2.5, upMbps: 0.6, downBytes: 1.4e9, upBytes: 3e8, connectedS: 12 * 86_400 },
];

export function mockWifi(p: ProfileSpec): WifiDevices {
  if (!p.capabilities.hasRouter) return { available: false, devices: [], updatedMs: null };
  const j = () => 0.7 + Math.random() * 0.6;
  return {
    available: true,
    updatedMs: Date.now(),
    devices: BASE.map((d) => ({
      ...d,
      downMbps: d.downMbps == null ? null : +(d.downMbps * j()).toFixed(1),
      upMbps: d.upMbps == null ? null : +(d.upMbps * j()).toFixed(2),
    })),
  };
}

export function mockSupportReport(p: ProfileSpec, profile: string): string {
  return `# StarlinkPulse support report

_Generated ${new Date().toISOString()} · simulated data (mock profile: ${profile})_

## Dish
- Hardware: ${p.capabilities.hardwareVersion ?? "unknown"}
- Firmware: ${p.capabilities.softwareVersion ?? "unknown"}
- Uptime: 3 d 4 h

## Last 48 hours
- Outages: ${Math.round(p.outagesPerDay * 2)} (top cause: ${p.causes[0] ?? "UNKNOWN"})
- Avg latency: ${p.latencyMs.toFixed(0)} ms · Avg packet loss: ${(p.dropRate * 100).toFixed(2)} %
- Obstructed: ${(p.obstructed * 100).toFixed(1)} %
- Throttling: ${p.restricted ?? "none"}
- Active alerts: ${p.alerts.length ? p.alerts.join(", ") : "none"}

## Built-in checks
- Obstructions: ${p.obstructed > 0.05 ? "frequent, check the sky view" : "ok"}

## Wi-Fi
${p.capabilities.hasRouter ? "- 6 clients (5 GHz: 5, 2.4 GHz: 1), 1 with weak signal, 1 mesh repeater" : "- Starlink router not reachable"}
`;
}

