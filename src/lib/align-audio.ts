// Optional audio guidance for guided alignment (Web Audio, no assets).

const KEY = "starlinkpulse.alignAudio";

/** Sound is on by default in Align mode; the choice is remembered. */
export function loadAlignAudio(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === null || v === undefined ? true : v === "on";
  } catch {
    return true;
  }
}

export function saveAlignAudio(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(KEY, on ? "on" : "off");
  } catch {
    // ignore (private mode, quota)
  }
}

export type AudioMode = { kind: "silent" } | { kind: "beep"; intervalMs: number } | { kind: "tone" };

type Ctx = AudioContext;

/** Beeps faster as the dish gets closer, a steady soft tone when in tolerance, silence otherwise. */
export class AlignBeeper {
  private ctx: Ctx | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tone: { osc: OscillatorNode; gain: GainNode } | null = null;
  private mode: AudioMode = { kind: "silent" };

  private context(): Ctx | null {
    if (this.ctx) return this.ctx;
    const C =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    this.ctx = new C();
    return this.ctx;
  }

  setMode(mode: AudioMode): void {
    const same =
      mode.kind === this.mode.kind && (mode.kind !== "beep" || (this.mode.kind === "beep" && this.mode.intervalMs === mode.intervalMs));
    if (same) return;
    const wasBeeping = this.mode.kind === "beep";
    this.mode = mode;
    if (mode.kind !== "tone") this.stopTone();
    if (mode.kind !== "beep") this.clearTimer();
    if (mode.kind === "tone") this.startTone();
    // A changed interval is picked up by the next scheduled beep; start the loop if idle.
    if (mode.kind === "beep" && !wasBeeping) this.beepLoop();
  }

  dispose(): void {
    this.clearTimer();
    this.stopTone();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.mode = { kind: "silent" };
  }

  private beepLoop = () => {
    if (this.mode.kind !== "beep") return;
    this.beep();
    this.timer = setTimeout(this.beepLoop, this.mode.intervalMs);
  };

  private beep() {
    const ctx = this.context();
    if (!ctx) return;
    void ctx.resume?.();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  private startTone() {
    const ctx = this.context();
    if (!ctx || this.tone) return;
    void ctx.resume?.();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    this.tone = { osc, gain };
  }

  private stopTone() {
    if (!this.tone) return;
    try {
      this.tone.osc.stop();
    } catch {
      // already stopped
    }
    this.tone.osc.disconnect();
    this.tone.gain.disconnect();
    this.tone = null;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
