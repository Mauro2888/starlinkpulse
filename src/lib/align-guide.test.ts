import { describe, expect, it } from "vitest";
import {
  beepIntervalMs,
  closeness,
  holdReason,
  initialGuide,
  stepGuide,
  type AlignSample,
  type GuideState,
} from "@/lib/align-guide";
import { loadAlignAudio, saveAlignAudio } from "@/lib/align-audio";

const s = (t: number, az: number, el: number, over: Partial<AlignSample> = {}): AlignSample => ({
  t,
  az,
  el,
  desiredAz: 178,
  desiredEl: 66,
  uncertainty: 0.8,
  estimation: "FILTER_CONVERGED",
  ...over,
});

function feed(samples: AlignSample[], from: GuideState = initialGuide()): GuideState {
  return samples.reduce(stepGuide, from);
}

describe("guided alignment steps", () => {
  it("asks for direction first, then tilt, then holding", () => {
    let g = feed([s(0, 160, 60), s(1000, 160, 60)]);
    expect(g.phase).toMatchObject({ kind: "direction" });
    expect((g.phase as { deltaDeg: number }).deltaDeg).toBeCloseTo(18);

    // Direction fixed in small steps (no jump > 3° within 2 s), tilt still 6° low.
    g = feed([s(4000, 162.5, 60), s(7000, 165, 60), s(10000, 167.5, 60), s(13000, 170, 60), s(16000, 172.5, 60), s(19000, 175, 60), s(22000, 177, 60), s(23000, 177, 60)], g);
    expect(g.phase).toMatchObject({ kind: "tilt" });
    expect((g.phase as { deltaDeg: number }).deltaDeg).toBeCloseTo(6);

    g = feed([s(26000, 177, 62.5), s(29000, 177, 65), s(30000, 177, 65)], g);
    expect(g.phase).toMatchObject({ kind: "holding" });
  });

  it("is on target within 5° combined, even if one axis alone is off by more", () => {
    // Installer's Mini: 6.7° / 3.4° off per axis at ~69° elevation = ~4.2° in total.
    const g = feed([s(0, 26.7, 69.4, { desiredAz: 20, desiredEl: 66 }), s(1000, 26.7, 69.4, { desiredAz: 20, desiredEl: 66 })]);
    expect(g.phase.kind).toBe("holding");
  });

  it("does not drop out of holding for jitter just past the limit", () => {
    // ~4.8° then ~5.3° combined (tilt only): still holding thanks to the margin; 6° leaves.
    let g = feed([s(0, 178, 61.2), s(1000, 178, 61.2)]);
    expect(g.phase.kind).toBe("holding");
    g = stepGuide(g, s(2000, 178, 60.7));
    expect(g.phase.kind).toBe("holding");
    g = feed([s(4000, 178, 60), s(5000, 178, 60)], g);
    expect(g.phase.kind).toBe("tilt");
  });

  it("goes back to direction if the dish drifts out of tolerance", () => {
    // Low target (30°) so a few degrees of azimuth matter; 2.5° steps 2 s apart are not a jump.
    const low = { desiredEl: 30 };
    const g = feed([s(0, 177.5, 30, low), s(1000, 177.5, 30, low), s(3000, 175, 30, low), s(5000, 172.5, 30, low), s(7000, 170, 30, low)]);
    expect(g.phase.kind).toBe("direction");
  });

  it("finishes only after 10 s continuously in tolerance, and stays done", () => {
    let g = feed([s(0, 177.6, 65.8)]);
    for (let t = 1000; t < 10000; t += 1000) g = stepGuide(g, s(t, 177.6, 65.8));
    expect(g.done).toBe(false);
    expect(g.phase).toMatchObject({ kind: "holding" });
    g = stepGuide(g, s(10000, 177.6, 65.8));
    expect(g.done).toBe(true);
    expect(g.phase.kind).toBe("done");
    expect(g.start).toEqual({ az: 177.6, el: 65.8 });
    // Later readings don't undo "done".
    expect(stepGuide(g, s(11000, 150, 50)).phase.kind).toBe("done");
  });

  it("restarts the 10 s count after leaving tolerance", () => {
    // 6° of tilt is off target; 3° steps 3 s apart are not a jump.
    let g = feed([s(0, 177.6, 65.8), s(5000, 177.6, 65.8), s(8000, 177.6, 62.8), s(11000, 177.6, 59.8)]);
    expect(g.phase.kind).toBe("tilt");
    g = feed([s(14000, 177.6, 62.8), s(17000, 177.6, 65.8), s(23000, 177.6, 65.8)], g);
    expect(g.done).toBe(false);
    g = stepGuide(g, s(27000, 177.6, 65.8));
    expect(g.done).toBe(true);
  });
});

describe("hold-still gating", () => {
  it("holds while uncertainty is high", () => {
    const g = feed([s(0, 166.8, 63.9, { uncertainty: 2.2 })]);
    expect(g.phase).toEqual({ kind: "hold", reason: "uncertain" });
  });

  it("holds for any reported state other than FILTER_CONVERGED", () => {
    for (const estimation of ["FILTER_INITIALIZING", "FILTER_CONVERGING"]) {
      expect(feed([s(0, 166.8, 63.9, { estimation })]).phase).toEqual({ kind: "hold", reason: "estimating" });
    }
    expect(feed([s(0, 166.8, 63.9, { estimation: "FILTER_CONVERGED" })]).phase.kind).toBe("direction");
  });

  it("with no reported state, relies on uncertainty and jumps", () => {
    expect(feed([s(0, 166.8, 63.9, { estimation: null, uncertainty: 0.8 })]).phase.kind).toBe("direction");
    expect(feed([s(0, 166.8, 63.9, { estimation: null, uncertainty: 2.2 })]).phase).toEqual({ kind: "hold", reason: "uncertain" });
    expect(
      feed([s(0, 166.8, 63.9, { estimation: null }), s(1000, 171, 63.9, { estimation: null })]).phase,
    ).toEqual({ kind: "hold", reason: "moving" });
  });

  it("holds after a jump of more than 3° in the last 2 s, then gives directions again", () => {
    let g = feed([s(0, 150, 60), s(1000, 155, 60)]);
    expect(g.phase).toEqual({ kind: "hold", reason: "moving" });
    g = stepGuide(g, s(3500, 155, 60));
    expect(g.phase.kind).toBe("direction");
    expect(holdReason([s(0, 170, 60), s(1500, 170, 63.5)])).toBe("moving");
  });

  it("never counts holding time while readings are shaky", () => {
    const g = feed([s(0, 177.6, 65.8), s(5000, 177.6, 65.8), s(6000, 177.6, 65.8, { uncertainty: 3 })]);
    expect(g.inToleranceSince).toBeNull();
  });
});

describe("audio pacing and preference", () => {
  it("beeps faster when closer, silent when holding still", () => {
    expect(beepIntervalMs(closeness({ kind: "direction", deltaDeg: 40 })!)).toBeGreaterThan(
      beepIntervalMs(closeness({ kind: "direction", deltaDeg: 3 })!),
    );
    expect(closeness({ kind: "hold", reason: "moving" })).toBeNull();
    expect(closeness({ kind: "holding", sinceMs: 0, remainingMs: 5000 })).toBe(1);
  });

  it("defaults to on and remembers the choice", () => {
    localStorage.removeItem("starlinkpulse.alignAudio");
    expect(loadAlignAudio()).toBe(true);
    saveAlignAudio(false);
    expect(loadAlignAudio()).toBe(false);
    saveAlignAudio(true);
    expect(loadAlignAudio()).toBe(true);
  });
});
