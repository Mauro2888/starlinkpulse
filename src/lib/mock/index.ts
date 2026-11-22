// In-browser mock backend. Used only when the app is NOT running inside Tauri
// (e.g. `npm run dev` in a browser). It mimics the command/event contract in
// docs/api.md, including read-only and capability gating for write commands.

import type { Backend, Unlisten } from "@/lib/api";
import type {
  CommandError,
  ConnectionStatus,
  DishCapabilities,
  DishEvent,
  HistoryPoint,
  Settings,
  TelemetrySnapshot,
} from "@/types/models";
import { PROFILES, type ProfileSpec } from "@/lib/mock/profiles";
import { mockReport, mockSummary } from "@/lib/mock/advisor";
import { mockObstructionMap } from "@/lib/mock/obstruction";
import { mockUptime, mockUsage } from "@/lib/mock/usage";
import { isInsufficientHistory, isLoopbackUrl } from "@/lib/advisor";
import type { AiReport, SnowMeltMode } from "@/types/models";

const SETTINGS_KEY = "starlinkpulse.mock.settings";
const MINUTE = 60_000;
/** Mock "app has been running" window: history starts this long ago. */
const HISTORY_SPAN_MIN = 30 * 60;

export const DEFAULT_SETTINGS: Settings = {
  dishAddress: "192.168.100.1:9200",
  routerAddress: "192.168.1.1:9000",
  readOnly: true,
  mockMode: "auto",
  mockProfile: "standard",
  livePollIntervalS: 3,
  claudeModel: "claude-opus-5-5",
  closeToTray: true,
  launchAtLogin: false,
  notifications: {
    enabled: true,
    outage: true,
    obstruction: true,
    thermal: true,
    throttle: true,
    reboot: true,
    firmwareUpdate: true,
    dataCap: true,
    quietStartHour: null,
    quietEndHour: null,
  },
  dataCapGb: 150,
  billingCycleDay: 1,
  aiProvider: "off",
  localAiUrl: "http://localhost:11434",
  localAiKind: "ollama",
  localAiModel: "",
};

function fail(kind: CommandError["kind"], message: string): never {
  throw { kind, message } satisfies CommandError;
}

/** Deterministic hash noise in [0, 1) for a given integer seed. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function loadSettings(): Settings {
  // Dev aid: `?mockProfile=obstructed` forces a profile for UI work.
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("mockProfile") : null;
  if (forced && forced in PROFILES) return { ...DEFAULT_SETTINGS, mockMode: "on", mockProfile: forced as Settings["mockProfile"] };
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore corrupt storage
  }
  return { ...DEFAULT_SETTINGS };
}

type Handler = (payload: unknown) => void;

export class MockBackend implements Backend {
  private settings: Settings = loadSettings();
  private listeners = new Map<string, Set<Handler>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootMs = Date.now() - 3 * 86_400_000 - 4 * 3_600_000;
  private rebootingUntil = 0;
  private stowed = false;
  private snowMelt: SnowMeltMode = "auto";
  private hasKey = false;
  private lastRulesReport: AiReport | null = null;
  private updateInstalled = false;
  private lastAiReport: AiReport | null = null;
  private readonly startMs = Date.now();

  constructor() {
    // Dev aid: `?mockReport` pre-seeds a saved Advisor report for UI work.
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("mockReport")) {
      this.lastRulesReport = mockReport(this.settings.mockProfile, this.profile, "rules-v1", "rules");
      // `?mockReport=ai` also seeds a saved AI explanation.
      if (new URLSearchParams(location.search).get("mockReport") === "ai") {
        this.lastAiReport = mockReport(this.settings.mockProfile, this.profile, this.settings.claudeModel, "claude");
      }
    }
  }

  private get profile(): ProfileSpec {
    return PROFILES[this.settings.mockProfile] ?? PROFILES.standard;
  }

  private get offline(): boolean {
    return this.profile.offline || Date.now() < this.rebootingUntil;
  }

  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    switch (cmd) {
      case "get_connection_status":
        return this.connection();
      case "get_capabilities":
        return this.capabilities();
      case "get_live_snapshot":
        if (this.offline) fail("offline", "Dish did not respond within 5 s.");
        return this.snapshot(Date.now());
      case "get_history":
        return this.history(Number(args.rangeMinutes) || 60);
      case "get_events":
        return this.events(Number(args.rangeMinutes) || 60);
      case "get_obstruction_map":
        if (!this.profile.capabilities.hasObstructionMap) fail("unsupported", "Obstruction map not available.");
        if (this.offline) fail("offline", "The dish is not reachable.");
        return mockObstructionMap(this.settings.mockProfile);
      case "get_settings":
        return { ...this.settings };
      case "update_settings":
        return this.updateSettings(args.settings as Settings);
      case "reboot_dish":
        this.guardWrite("canReboot");
        this.rebootingUntil = Date.now() + 6_000;
        this.bootMs = this.rebootingUntil;
        this.stowed = false;
        this.emitStatus();
        setTimeout(() => this.emitStatus(), 6_100);
        return null;
      case "stow_dish":
        this.guardWrite("canStow");
        this.stowed = true;
        return null;
      case "unstow_dish":
        this.guardWrite("canStow");
        this.stowed = false;
        return null;
      case "set_snow_melt":
        this.guardWrite("canSetSnowMelt");
        if (!["auto", "always_on", "always_off"].includes(String(args.mode))) {
          fail("invalid_input", "Unknown snow melt mode.");
        }
        this.snowMelt = args.mode as SnowMeltMode;
        this.emit("capabilities", this.capabilities());
        return null;
      case "set_api_key": {
        const key = String(args.key ?? "").trim();
        if (key.length < 10) fail("invalid_input", "That does not look like an API key.");
        this.hasKey = true;
        return null;
      }
      case "has_api_key":
        return this.hasKey;
      case "delete_api_key":
        this.hasKey = false;
        return null;
      case "get_uptime_stats":
        return mockUptime(this.profile, this.events(1440), HISTORY_SPAN_MIN * 60 + (Date.now() - this.startMs) / 1000);
      case "get_data_usage":
        return mockUsage(this.profile, this.settings, Math.min(90, Math.max(1, Number(args.days) || 31)));
      case "check_for_update": {
        // Dev aid: `?mockUpdate=none` or `?mockUpdate=unconfigured`.
        const mode = typeof location !== "undefined" ? new URLSearchParams(location.search).get("mockUpdate") : null;
        const current = __APP_VERSION__;
        if (mode === "unconfigured") {
          return { updaterConfigured: false, available: false, currentVersion: current, latestVersion: null, notes: null };
        }
        const available = mode !== "none" && !this.updateInstalled;
        return {
          updaterConfigured: true,
          available,
          currentVersion: current,
          latestVersion: available ? "0.2.0" : current,
          notes: available
            ? "- 3D sky view of obstructions\n- Launch at login\n- Faster history charts"
            : null,
        };
      }
      case "install_update":
        await new Promise((r) => setTimeout(r, 2_000));
        this.updateInstalled = true;
        return null;
      case "send_test_notification":
        // No OS notifications in the browser mock; succeed silently.
        return null;
      case "preview_ai_payload":
        return mockSummary(this.settings.mockProfile, this.profile);
      case "get_last_rules_report":
        return this.lastRulesReport;
      case "get_last_ai_report":
        return this.lastAiReport;
      case "run_diagnostics": {
        if (isInsufficientHistory(mockSummary(this.settings.mockProfile, this.profile))) {
          fail("insufficient_data", "Less than 1 hour of history.");
        }
        this.lastRulesReport = mockReport(this.settings.mockProfile, this.profile, "rules-v1", "rules");
        return this.lastRulesReport;
      }
      case "list_local_models": {
        if (!isLoopbackUrl(this.settings.localAiUrl)) {
          fail("ai_unavailable", `Can't reach ${this.settings.localAiUrl}.`);
        }
        return this.settings.localAiKind === "ollama"
          ? ["llama3.2:3b", "qwen2.5:7b-instruct", "mistral-nemo:12b"]
          : ["lmstudio-community/Qwen2.5-7B-Instruct-GGUF", "lmstudio-community/Llama-3.2-3B-Instruct-GGUF"];
      }
      case "analyze_network_with_ai": {
        const provider = this.settings.aiProvider;
        if (!args.payload || typeof args.payload !== "object") fail("invalid_input", "Missing payload.");
        if (provider === "off") fail("invalid_input", "AI explanations are turned off.");
        if (provider === "claude" && !this.hasKey) fail("no_api_key", "No Anthropic API key saved.");
        if (provider === "local") {
          if (!this.settings.localAiModel.trim()) fail("invalid_input", "Choose a local model in Settings.");
          if (!isLoopbackUrl(this.settings.localAiUrl)) fail("ai_unavailable", `Can't reach ${this.settings.localAiUrl}.`);
        }
        if (isInsufficientHistory(mockSummary(this.settings.mockProfile, this.profile))) {
          fail("insufficient_data", "Less than 1 hour of history.");
        }
        // Simulate model latency; local models are slower.
        await new Promise((r) => setTimeout(r, (provider === "local" ? 8_000 : 4_000) + Math.random() * 3_000));
        const model = provider === "local" ? this.settings.localAiModel : this.settings.claudeModel;
        this.lastAiReport = mockReport(this.settings.mockProfile, this.profile, model, provider);
        return this.lastAiReport;
      }
      default:
        fail("internal", `Unknown command: ${cmd}`);
    }
  }

  async listen(event: string, handler: Handler): Promise<Unlisten> {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    this.ensureTimer();
    return () => {
      set.delete(handler);
      if (this.totalListeners() === 0) this.stopTimer();
    };
  }

  // -- internals ---------------------------------------------------------

  private guardWrite(cap: "canReboot" | "canStow" | "canSetSnowMelt"): void {
    if (this.settings.readOnly) fail("read_only", "Read-only mode is on. Turn it off in Settings first.");
    if (this.offline) fail("offline", "The dish is not reachable.");
    if (!this.profile.capabilities[cap]) fail("unsupported", "This dish does not support that action.");
  }

  private updateSettings(next: Settings): Settings {
    if (!next || typeof next !== "object") fail("invalid_input", "Missing settings.");
    if (!/^[\w.-]+:\d{1,5}$/.test(next.dishAddress)) fail("invalid_input", "Dish address must look like host:port.");
    if (next.routerAddress && !/^[\w.-]+:\d{1,5}$/.test(next.routerAddress)) {
      fail("invalid_input", "Router address must look like host:port.");
    }
    if (next.aiProvider === "local" && !/^https?:\/\/\S+$/.test(next.localAiUrl)) {
      fail("invalid_input", "Local AI address must start with http:// or https://.");
    }
    if (next.dataCapGb !== null && !(next.dataCapGb > 0)) fail("invalid_input", "Data cap must be a positive number of GB.");
    if (!(Number.isInteger(next.billingCycleDay) && next.billingCycleDay >= 1 && next.billingCycleDay <= 28)) {
      fail("invalid_input", "Billing cycle day must be between 1 and 28.");
    }
    if (!(next.livePollIntervalS >= 1 && next.livePollIntervalS <= 60)) {
      fail("invalid_input", "Poll interval must be between 1 and 60 seconds.");
    }
    const profileChanged = next.mockProfile !== this.settings.mockProfile || next.mockMode !== this.settings.mockMode;
    const intervalChanged = next.livePollIntervalS !== this.settings.livePollIntervalS;
    this.settings = { ...next };
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // storage unavailable: keep in memory only
    }
    if (intervalChanged) {
      this.stopTimer();
      this.ensureTimer();
    }
    if (profileChanged) {
      this.emit("capabilities", this.capabilities());
      this.emitStatus();
    }
    return { ...this.settings };
  }

  private connection(): ConnectionStatus {
    const now = Date.now();
    if (now < this.rebootingUntil) {
      return { state: "connecting", dishAddress: this.settings.dishAddress, routerAvailable: false, lastError: "Dish is rebooting.", lastSuccessMs: now - 2_000 };
    }
    if (this.profile.offline) {
      return {
        state: "offline",
        dishAddress: this.settings.dishAddress,
        routerAvailable: false,
        lastError: "No response from 192.168.100.1:9200 within 5 s.",
        lastSuccessMs: this.startMs - 42 * MINUTE,
      };
    }
    return {
      state: "mock",
      dishAddress: this.settings.dishAddress,
      routerAvailable: this.profile.capabilities.hasRouter,
      // In "auto" the mock stands in for an unreachable dish.
      lastError: this.settings.mockMode === "on" ? null : `No response from ${this.settings.dishAddress} within 5 s.`,
      lastSuccessMs: now,
    };
  }

  private capabilities(): DishCapabilities {
    const c = this.profile.capabilities;
    return { ...c, isMock: true, snowMeltMode: c.canSetSnowMelt ? this.snowMelt : null };
  }

  snapshot(now: number): TelemetrySnapshot {
    const p = this.profile;
    const t = now / 1000;
    const wobble = (period: number, amp: number) => 1 + amp * Math.sin((t / period) * 2 * Math.PI);
    const jitter = (amp: number) => 1 + amp * (Math.random() - 0.5) * 2;
    const busy = Math.random() < 0.15 ? 1.8 : 1;
    const obstructedNow = p.obstructed > 0.05 && Math.random() < 0.2;
    const down = this.stowed ? 0 : (p.downBps / 6) * wobble(90, 0.4) * jitter(0.5) * busy;
    const up = this.stowed ? 0 : (p.upBps / 5) * wobble(70, 0.3) * jitter(0.6);
    return {
      timestampMs: now,
      uptimeS: Math.max(0, (now - this.bootMs) / 1000),
      downlinkBps: down,
      uplinkBps: up,
      powerW: p.powerW == null ? null : (this.stowed ? p.powerW * 0.6 : p.powerW) * wobble(120, 0.05) * jitter(0.06),
      popPingLatencyMs: this.stowed ? null : p.latencyMs * wobble(45, 0.15) * jitter(0.25) * (obstructedNow ? 1.6 : 1),
      popPingDropRate: this.stowed ? 1 : Math.max(0, p.dropRate * jitter(0.9) * (obstructedNow ? 6 : 1)),
      snrAboveNoiseFloor: !this.stowed,
      signalQuality: p.hasSignalQuality ? Math.min(1, 0.86 * jitter(0.08)) : null,
      obstruction: {
        fractionObstructed: p.obstructed,
        timeObstructed: p.obstructed * 0.6,
        validS: 86_400 * 2.4,
        currentlyObstructed: obstructedNow,
        avgProlongedObstructionIntervalS: p.obstructed > 0.05 ? 412 : null,
      },
      // Mini is mounted ~11° off and 2° too low; the others are within tolerance.
      alignment: {
        azimuthDeg: (this.settings.mockProfile === "mini" ? 166.8 : 179.1) + (Math.random() - 0.5) * 0.4,
        elevationDeg: (this.settings.mockProfile === "mini" ? 63.9 : 65.6) + (Math.random() - 0.5) * 0.2,
        desiredAzimuthDeg: 178.0,
        desiredElevationDeg: 66.0,
        tiltAngleDeg: p.capabilities.actuators === "yes" ? null : 24.8,
        uncertaintyDeg: 0.9,
      },
      gpsValid: true,
      gpsSats: 12 + Math.round(Math.random() * 4),
      dlBandwidthRestrictedReason: p.restricted ?? "NO_LIMIT",
      ulBandwidthRestrictedReason: p.restricted ?? "NO_LIMIT",
      softwareUpdateState: "IDLE",
      disablementCode: "OKAY",
      alerts: [...p.alerts],
      isHeating: false,
    };
  }

  private history(rangeMinutes: number): HistoryPoint[] {
    const p = this.profile;
    const now = Math.floor(Date.now() / MINUTE) * MINUTE;
    const start = Math.max(now - rangeMinutes * MINUTE, this.startMs - HISTORY_SPAN_MIN * MINUTE);
    const firstMinute = Math.ceil(start / MINUTE) * MINUTE;
    const outages = this.events(rangeMinutes);
    const out: HistoryPoint[] = [];
    for (let m = firstMinute; m <= now; m += MINUTE) {
      const i = m / MINUTE;
      // Simulated gap: the app was closed for ~40 minutes 9 h ago.
      if (now - m > 9 * 3_600_000 && now - m < 9 * 3_600_000 + 40 * MINUTE) continue;
      const hour = new Date(m).getHours();
      const evening = hour >= 19 && hour <= 23 ? 1.35 : 1;
      // Smooth-ish noise: slow waves plus a little per-minute jitter.
      const n = 0.5 + 0.3 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7.3) + 0.16 * (noise(i) - 0.5);
      const n2 = 0.5 + 0.3 * Math.sin(i / 31 + 2) + 0.12 * Math.sin(i / 5.1) + 0.16 * (noise(i + 7.1) - 0.5);
      const inOutage = outages.some((e) => m + MINUTE > e.startMs && m < e.startMs + e.durationMs);
      const lat = p.latencyMs * evening * (0.85 + n * 0.35);
      const drop = Math.min(1, p.dropRate * (0.3 + n2 * 1.6) + (inOutage ? 0.12 + n * 0.2 : 0));
      const down = (p.downBps / 5) * (0.4 + n2 * 1.1) / evening;
      const up = (p.upBps / 5) * (0.4 + n * 1.0);
      out.push({
        minuteMs: m,
        samples: 60,
        latencyAvgMs: lat,
        latencyP95Ms: lat * (1.3 + n2 * 0.5),
        latencyMaxMs: lat * (1.9 + n2),
        dropRateAvg: drop,
        downlinkAvgBps: down,
        downlinkMaxBps: down * (1.6 + n * 2),
        uplinkAvgBps: up,
        uplinkMaxBps: up * (1.5 + n2),
        powerAvgW: p.powerW == null ? null : p.powerW * (0.92 + n * 0.16),
        powerMaxW: p.powerW == null ? null : p.powerW * (1.1 + n2 * 0.2),
      });
    }
    return out;
  }

  private events(rangeMinutes: number): DishEvent[] {
    const p = this.profile;
    const now = Date.now();
    const from = Math.max(now - rangeMinutes * MINUTE, this.startMs - HISTORY_SPAN_MIN * MINUTE);
    const stepMin = Math.max(5, Math.round((24 * 60) / Math.max(1, p.outagesPerDay)));
    // Slots are fixed in absolute time so every range shows the same events.
    const out: DishEvent[] = [];
    const firstSlot = Math.floor(from / (stepMin * MINUTE));
    const lastSlot = Math.floor(now / (stepMin * MINUTE));
    for (let s = firstSlot; s <= lastSlot; s++) {
      const n = noise(s * 3.3);
      const startMs = s * stepMin * MINUTE + Math.floor(n * stepMin * MINUTE * 0.8);
      if (startMs < from || startMs > now) continue;
      const cause = p.causes[Math.floor(noise(s) * p.causes.length)] ?? "UNKNOWN";
      out.push({ startMs, durationMs: Math.round(1_500 + noise(s + 1) * 45_000), cause, severity: null });
    }
    if (this.bootMs > from && this.bootMs <= now) {
      out.push({ startMs: this.bootMs - 40_000, durationMs: 40_000, cause: "BOOTING", severity: null });
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  private totalListeners(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.offline) this.emit("telemetry", this.snapshot(Date.now()));
    }, this.settings.livePollIntervalS * 1000);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emitStatus(): void {
    this.emit("connection-status", this.connection());
  }

  private emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }
}

let instance: MockBackend | null = null;

export function getMockBackend(): MockBackend {
  instance ??= new MockBackend();
  return instance;
}
