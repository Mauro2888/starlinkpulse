import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DataUsage, Settings } from "@/types/models";
import { cycleBars, cycleProgress, cycleStart, formatBytes, formatUptime } from "@/lib/usage";
import { validateSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/mock";
import { UptimeCard } from "@/components/history/uptime-card";
import { DataUsageCard } from "@/components/history/data-usage-card";

const GB = 1e9;

function usage(down: number, up: number, capGb: number | null): DataUsage {
  return {
    daily: [
      { dayMs: 1000, downloadBytes: 1 * GB, uploadBytes: 0.1 * GB },
      { dayMs: 3000, downloadBytes: 2 * GB, uploadBytes: 0.2 * GB },
      { dayMs: 2000, downloadBytes: 3 * GB, uploadBytes: 0.3 * GB },
    ],
    cycleStartMs: 2000,
    cycleDownloadBytes: down,
    cycleUploadBytes: up,
    capGb,
    isEstimate: true,
  };
}

describe("formatBytes", () => {
  it("uses decimal units", () => {
    expect(formatBytes(812e6)).toBe("812 MB");
    expect(formatBytes(14.24e9)).toBe("14.2 GB");
    expect(formatBytes(150e9)).toBe("150 GB");
    expect(formatBytes(1.31e12)).toBe("1.31 TB");
    expect(formatBytes(null)).toBe("—");
  });
});

describe("cycleProgress", () => {
  it("has no state without a cap", () => {
    expect(cycleProgress(usage(10 * GB, 1 * GB, null))).toMatchObject({ state: "none", fraction: null, totalBytes: 11 * GB });
  });
  it("switches to warning at 80 % and over at 100 %", () => {
    expect(cycleProgress(usage(70 * GB, 9 * GB, 100)).state).toBe("ok");
    expect(cycleProgress(usage(70 * GB, 10 * GB, 100)).state).toBe("warning");
    expect(cycleProgress(usage(95 * GB, 5 * GB, 100)).state).toBe("over");
  });
});

describe("cycle helpers", () => {
  it("keeps only cycle days, sorted, in GB", () => {
    expect(cycleBars(usage(0, 0, null))).toEqual([
      { dayMs: 2000, down: 3, up: 0.3 },
      { dayMs: 3000, down: 2, up: 0.2 },
    ]);
  });
  it("finds the cycle start for a reset day", () => {
    expect(cycleStart(new Date(2026, 10, 22), 15)).toEqual(new Date(2026, 10, 15));
    expect(cycleStart(new Date(2026, 10, 10), 15)).toEqual(new Date(2026, 9, 15));
    expect(cycleStart(new Date(2026, 0, 3), 28)).toEqual(new Date(2025, 11, 28));
  });
  it("formats uptime", () => {
    expect(formatUptime({ uptimePct: 99.9512 })).toBe("99.95 %");
    expect(formatUptime({ uptimePct: 97.26 })).toBe("97.3 %");
    expect(formatUptime({ uptimePct: 100 })).toBe("100 %");
    expect(formatUptime({ uptimePct: null })).toBe("—");
  });
});

describe("settings validation for notifications and data plan", () => {
  const ok: Settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications } };
  it("accepts defaults", () => expect(validateSettings(ok)).toEqual({}));
  it("rejects half-set or empty quiet hours", () => {
    expect(validateSettings({ ...ok, notifications: { ...ok.notifications, quietStartHour: 22, quietEndHour: null } }).quietHours).toBeTruthy();
    expect(validateSettings({ ...ok, notifications: { ...ok.notifications, quietStartHour: 7, quietEndHour: 7 } }).quietHours).toBeTruthy();
    expect(validateSettings({ ...ok, notifications: { ...ok.notifications, quietStartHour: 22, quietEndHour: 7 } })).toEqual({});
  });
  it("validates cap and cycle day", () => {
    const e = validateSettings({ ...ok, dataCapGb: 0, billingCycleDay: 31 });
    expect(Object.keys(e).sort()).toEqual(["billingCycleDay", "dataCapGb"]);
    expect(validateSettings({ ...ok, dataCapGb: null })).toEqual({});
  });
});

describe("History cards", () => {
  it("shows 'not enough data' for windows without a percentage", () => {
    render(
      <UptimeCard
        error={null}
        data={{
          windows: [
            { label: "24h", windowS: 86400, coveredS: 86400, uptimePct: 99.9, outageCount: 2, outageS: 86 },
            { label: "7d", windowS: 604800, coveredS: 86400, uptimePct: null, outageCount: 2, outageS: 86 },
          ],
        }}
      />,
    );
    expect(screen.getByText("99.90 %")).toBeInTheDocument();
    expect(screen.getByText("Not enough data yet")).toBeInTheDocument();
  });

  it("shows cap warning text and the estimate disclaimer", () => {
    render(<DataUsageCard error={null} data={usage(80 * GB, 5 * GB, 100)} />);
    expect(screen.getByRole("progressbar", { name: "Data cap used" })).toHaveAttribute("aria-valuenow", "85");
    expect(screen.getByText(/You're getting close/)).toBeInTheDocument();
    expect(screen.getByText(/not your Starlink bill/)).toBeInTheDocument();
  });

  it("explains how to add a cap when none is set", () => {
    render(<DataUsageCard error={null} data={usage(1 * GB, 0, null)} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText(/No data cap set/)).toBeInTheDocument();
  });
});
