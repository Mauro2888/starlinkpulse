import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  formatAgo,
  formatBps,
  formatBpsParts,
  formatDuration,
  formatDurationMs,
  formatMs,
  formatPercent,
  formatWatts,
  humanizeEnum,
} from "@/lib/format";

describe("formatBps", () => {
  it("picks a unit by magnitude", () => {
    expect(formatBps(0)).toBe("0 bps");
    expect(formatBps(950)).toBe("950 bps");
    expect(formatBps(1_500)).toBe("1.5 Kbps");
    expect(formatBps(820_000)).toBe("820 Kbps");
    expect(formatBps(12_340_000)).toBe("12.3 Mbps");
    expect(formatBps(143_600_000)).toBe("144 Mbps");
    expect(formatBps(1_250_000_000)).toBe("1.25 Gbps");
  });

  it("drops trailing zeros", () => {
    expect(formatBps(5_000_000)).toBe("5 Mbps");
  });

  it("returns a dash for null, undefined, NaN, Infinity and negatives", () => {
    for (const v of [null, undefined, NaN, Infinity, -1]) {
      expect(formatBps(v)).toBe(EM_DASH);
      expect(formatBpsParts(v)).toEqual({ value: EM_DASH, unit: "" });
    }
  });
});

describe("formatMs", () => {
  it("keeps one decimal under 100 ms", () => {
    expect(formatMs(31.46)).toBe("31.5 ms");
    expect(formatMs(142.7)).toBe("143 ms");
  });
  it("handles null", () => expect(formatMs(null)).toBe(EM_DASH));
});

describe("formatPercent", () => {
  it("formats fractions", () => {
    expect(formatPercent(0)).toBe("0 %");
    expect(formatPercent(0.004)).toBe("0.4 %");
    expect(formatPercent(0.25)).toBe("25 %");
    expect(formatPercent(1)).toBe("100 %");
    expect(formatPercent(0.8612, 0)).toBe("86 %");
  });
  it("marks tiny non-zero values instead of rounding to zero", () => {
    expect(formatPercent(0.0002)).toBe("<0.1 %");
  });
  it("handles null and NaN", () => {
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(NaN)).toBe(EM_DASH);
  });
});

describe("formatDuration", () => {
  it("formats seconds into compact units", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45.9)).toBe("45 s");
    expect(formatDuration(12 * 60 + 5)).toBe("12 min");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3 h 05 min");
    expect(formatDuration(2 * 86400 + 4 * 3600 + 59)).toBe("2 d 4 h");
  });
  it("handles null and negatives", () => {
    expect(formatDuration(null)).toBe(EM_DASH);
    expect(formatDuration(-3)).toBe(EM_DASH);
  });
  it("formats millisecond durations with sub-second precision", () => {
    expect(formatDurationMs(1_500)).toBe("1.5 s");
    expect(formatDurationMs(90_000)).toBe("1 min");
    expect(formatDurationMs(undefined)).toBe(EM_DASH);
  });
});

describe("misc", () => {
  it("formats watts", () => {
    expect(formatWatts(27.34)).toBe("27.3 W");
    expect(formatWatts(null)).toBe(EM_DASH);
  });
  it("formats relative time", () => {
    expect(formatAgo(1000, 3000)).toBe("just now");
    expect(formatAgo(0, 125_000)).toBe("2 min ago");
    expect(formatAgo(null)).toBe(EM_DASH);
  });
  it("humanizes enums in both naming styles", () => {
    expect(humanizeEnum("POLICY_LIMIT")).toBe("Policy limit");
    expect(humanizeEnum("thermalThrottle")).toBe("Thermal throttle");
    expect(humanizeEnum(null)).toBe(EM_DASH);
  });
});
