import { describe, expect, it } from "vitest";
import type { HistoryPoint, TelemetrySnapshot } from "@/types/models";
import { bucketHistory, historyToCsv, summarizeHistory } from "@/lib/history";
import { appendSnapshot } from "@/lib/buffer";
import { explainCause, explainRestriction } from "@/lib/explain";
import { validateSettings } from "@/lib/settings";
import { DEFAULT_SETTINGS } from "@/lib/mock";

function pt(minuteMs: number, over: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    minuteMs,
    samples: 60,
    latencyAvgMs: 30,
    latencyP95Ms: 50,
    latencyMaxMs: 80,
    dropRateAvg: 0.01,
    downlinkAvgBps: 100e6,
    downlinkMaxBps: 200e6,
    uplinkAvgBps: 10e6,
    uplinkMaxBps: 20e6,
    powerAvgW: null,
    powerMaxW: null,
    ...over,
  };
}

const M = 60_000;

describe("bucketHistory", () => {
  it("keeps one row per minute for short ranges and leaves gaps as nulls", () => {
    const rows = bucketHistory([pt(0), pt(2 * M)], 0, 3 * M);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ t: 0, latAvg: 30, loss: 1, down: 100, up: 10, power: null });
    expect(rows[1].latAvg).toBeNull();
    expect(rows[2].latAvg).toBe(30);
  });

  it("weights averages by sample count and takes max p95", () => {
    const rows = bucketHistory(
      [pt(0, { latencyAvgMs: 10, samples: 30, latencyP95Ms: 40 }), pt(M, { latencyAvgMs: 40, samples: 60, latencyP95Ms: 90 })],
      0,
      2 * M,
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].latAvg).toBeCloseTo(30);
    expect(rows[0].latP95).toBe(90);
  });

  it("ignores null fields inside a bucket", () => {
    const rows = bucketHistory([pt(0, { latencyAvgMs: null }), pt(M, { latencyAvgMs: 20 })], 0, 2 * M, 1);
    expect(rows[0].latAvg).toBe(20);
  });
});

describe("summarizeHistory", () => {
  it("summarizes points and outages", () => {
    const s = summarizeHistory([pt(0), pt(M)], [{ startMs: 0, durationMs: 4000, cause: "OBSTRUCTED", severity: null }], 60);
    expect(s.latencyAvgMs).toBe(30);
    expect(s.outageCount).toBe(1);
    expect(s.outageTotalMs).toBe(4000);
    expect(s.coverage).toBeCloseTo(2 / 60);
  });
});

describe("historyToCsv", () => {
  it("writes a header and empty cells for nulls", () => {
    const csv = historyToCsv([pt(0)]);
    const [header, row] = csv.trim().split("\n");
    expect(header.startsWith("timeUtc,minuteMs,samples")).toBe(true);
    expect(row.startsWith("1970-01-01T00:00:00.000Z,0,60,30,50")).toBe(true);
    expect(row.endsWith(",,")).toBe(true);
  });
});

describe("appendSnapshot", () => {
  const snap = (t: number) => ({ timestampMs: t }) as TelemetrySnapshot;
  it("drops samples older than the window and ignores duplicates", () => {
    let b: TelemetrySnapshot[] = [];
    b = appendSnapshot(b, snap(0), 10_000);
    b = appendSnapshot(b, snap(5_000), 10_000);
    b = appendSnapshot(b, snap(5_000), 10_000);
    b = appendSnapshot(b, snap(12_000), 10_000);
    expect(b.map((s) => s.timestampMs)).toEqual([5_000, 12_000]);
  });
});

describe("explain", () => {
  it("explains POLICY_LIMIT in plain words", () => {
    const r = explainRestriction("POLICY_LIMIT");
    expect(r.restricted).toBe(true);
    expect(r.detail).toMatch(/plan/);
    expect(explainRestriction("NO_LIMIT").restricted).toBe(false);
    expect(explainRestriction(null).restricted).toBe(false);
  });
  it("labels outage causes", () => {
    expect(explainCause("OUTAGE_NO_DOWNLINK")).toBe("No downlink");
    expect(explainCause("BOOTING")).toBe("Reboot");
    expect(explainCause("SOMETHING_NEW")).toBe("Something new");
  });
});

describe("validateSettings", () => {
  const ok = {
    ...DEFAULT_SETTINGS,
    notifications: { ...DEFAULT_SETTINGS.notifications },
    routerAddress: "",
    mockProfile: "mini" as const,
    dataCapGb: null,
  };

  it("accepts defaults and an empty router", () => expect(validateSettings(ok)).toEqual({}));
  it("rejects bad addresses and intervals", () => {
    const e = validateSettings({ ...ok, dishAddress: "192.168.100.1", routerAddress: "x:99999", livePollIntervalS: 0 });
    expect(Object.keys(e).sort()).toEqual(["dishAddress", "livePollIntervalS", "routerAddress"]);
  });
});
