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
    let g = feed([s(0, 166.8, 63.9), s(1000, 166.8, 63.9)]);
    expect(g.phase).toMatchObject({ kind: "direction" });
    expect((g.phase as { deltaDeg: number }).deltaDeg).toBeCloseTo(11.2);

    // Direction fixed in small steps (no jump > 3° within 2 s), tilt still low.
    g = feed([s(4000, 169.5, 63.9), s(7000, 172, 63.9), s(10000, 174.5, 63.9), s(13000, 177, 63.9), s(14000, 177, 63.9)], g);
    expect(g.phase).toMatchObject({ kind: "tilt" });
    expect((g.phase as { deltaDeg: number }).deltaDeg).toBeCloseTo(2.1);

    g = feed([s(17000, 177, 65.5), s(18000, 177, 65.5)], g);
    expect(g.phase).toMatchObject({ kind: "holding" });
  });

  it("goes back to direction if the dish drifts out of tolerance", () => {
    const g = feed([s(0, 177.5, 66), s(1000, 177.5, 66), s(4000, 174, 66)]);
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
    let g = feed([s(0, 177.6, 65.8), s(5000, 177.6, 65.8), s(6000, 174, 65.8)]);
    g = feed([s(9000, 177.6, 65.8), s(15000, 177.6, 65.8)], g);
    expect(g.done).toBe(false);
    g = stepGuide(g, s(19500, 177.6, 65.8));
    expect(g.done).toBe(true);
  });
});

describe("hold-still gating", () => {
  it("holds while uncertainty is high", () => {
    const g = feed([s(0, 166.8, 63.9, { uncertainty: 2.2 })]);
    expect(g.phase).toEqual({ kind: "hold", reason: "uncertain" });
  });

  it("holds while the estimator has not converged, but treats unknown as converged", () => {
    expect(feed([s(0, 166.8, 63.9, { estimation: "FILTER_INITIALIZING" })]).phase).toEqual({ kind: "hold", reason: "estimating" });
    expect(feed([s(0, 166.8, 63.9, { estimation: null })]).phase.kind).toBe("direction");
  });

  it("holds after a jump of more than 3° in the last 2 s, then gives directions again", () => {
    let g = feed([s(0, 166.8, 63.9), s(1000, 171, 63.9)]);
    expect(g.phase).toEqual({ kind: "hold", reason: "moving" });
    g = stepGuide(g, s(3500, 171, 63.9));
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
