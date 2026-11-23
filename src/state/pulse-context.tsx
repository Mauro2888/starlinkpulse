import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ConnectionStatus,
  DishCapabilities,
  Settings,
  TelemetrySnapshot,
} from "@/types/models";
import { api, events, type Unlisten } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import { appendSnapshot } from "@/lib/buffer";
import { applyLanguage, resolveLanguage } from "@/i18n";

export interface PulseState {
  connection: ConnectionStatus | null;
  capabilities: DishCapabilities | null;
  snapshot: TelemetrySnapshot | null;
  /** ~5 min rolling buffer of live snapshots (ascending). */
  buffer: TelemetrySnapshot[];
  telemetryError: ApiError | null;
  settings: Settings | null;
  settingsError: ApiError | null;
  saveSettings: (next: Settings) => Promise<Settings>;
  /** Increments on every capabilities update (reconnect, profile change). */
  capsVersion: number;
  refresh: () => void;
}

export const PulseContext = createContext<PulseState | null>(null);

/** Owns all live state: one subscription per backend event for the whole app. */
export function PulseProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [capabilities, setCapabilities] = useState<DishCapabilities | null>(null);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [buffer, setBuffer] = useState<TelemetrySnapshot[]>([]);
  const [telemetryError, setTelemetryError] = useState<ApiError | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<ApiError | null>(null);
  const lastSnapAt = useRef(0);
  const prevState = useRef<ConnectionStatus["state"] | null>(null);
  const prevIsMock = useRef<boolean | null>(null);
  const [capsVersion, setCapsVersion] = useState(0);

  /** Drops live data so values from a previous source never mix with the new one. */
  const clearLive = useCallback(() => {
    lastSnapAt.current = 0;
    setSnapshot(null);
    setBuffer([]);
  }, []);

  const applyCapabilities = useCallback(
    (c: DishCapabilities) => {
      if (prevIsMock.current !== null && prevIsMock.current !== c.isMock) clearLive();
      prevIsMock.current = c.isMock;
      setCapabilities(c);
      setCapsVersion((v) => v + 1);
    },
    [clearLive],
  );

  const acceptSnapshot = useCallback((s: TelemetrySnapshot) => {
    lastSnapAt.current = Date.now();
    setSnapshot(s);
    setTelemetryError(null);
    setBuffer((b) => appendSnapshot(b, s));
  }, []);

  const fetchSnapshot = useCallback(async () => {
    try {
      acceptSnapshot(await api.getLiveSnapshot());
    } catch (e) {
      setTelemetryError(normalizeError(e));
    }
  }, [acceptSnapshot]);

  const refresh = useCallback(() => {
    api.getConnectionStatus().then((c) => {
      prevState.current = c.state;
      setConnection(c);
    }, () => undefined);
    api.getCapabilities().then(applyCapabilities, () => undefined);
    api.getSettings().then(
      (s) => {
        setSettings(s);
        setSettingsError(null);
      },
      (e) => setSettingsError(normalizeError(e)),
    );
    void fetchSnapshot();
  }, [fetchSnapshot, applyCapabilities]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Unlisten[] = [];
    const keep = (p: Promise<Unlisten>) =>
      p.then(
        (u) => (disposed ? u() : unlisteners.push(u)),
        () => undefined,
      );

    keep(events.onTelemetry(acceptSnapshot));
    keep(
      events.onConnectionStatus((c) => {
        const prev = prevState.current;
        prevState.current = c.state;
        const wasUp = prev === "connected" || prev === "mock";
        const isUp = c.state === "connected" || c.state === "mock";
        if (c.state === "connecting" && prev !== "connecting") clearLive();
        if (isUp && !wasUp) {
          api.getCapabilities().then(applyCapabilities, () => undefined);
          void fetchSnapshot();
        }
        setConnection(c);
      }),
    );
    keep(events.onCapabilities(applyCapabilities));
    refresh();

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [acceptSnapshot, fetchSnapshot, refresh, applyCapabilities, clearLive]);

  // UI language follows the saved setting ("system" = OS/browser language).
  const languagePref = settings?.language;
  useEffect(() => {
    applyLanguage(resolveLanguage(languagePref));
  }, [languagePref]);

  // Tell the backend when the window is hidden/minimized so it can poll the dish less often.
  useEffect(() => {
    const report = () => void api.setUiVisible(document.visibilityState === "visible").catch(() => undefined);
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, []);

  // Fallback polling: if no telemetry event arrived for two intervals, ask directly.
  const intervalS = settings?.livePollIntervalS ?? 3;
  useEffect(() => {
    const ms = Math.max(1, intervalS) * 1000;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastSnapAt.current > ms * 2) void fetchSnapshot();
    }, ms);
    return () => clearInterval(id);
  }, [intervalS, fetchSnapshot]);

  const saveSettings = useCallback(async (next: Settings) => {
    const saved = await api.updateSettings(next);
    setSettings(saved);
    // Addresses or mock mode may have changed: pick up the new state.
    api.getConnectionStatus().then(setConnection, () => undefined);
    api.getCapabilities().then(applyCapabilities, () => undefined);
    return saved;
  }, [applyCapabilities]);

  const value = useMemo<PulseState>(
    () => ({
      connection,
      capabilities,
      snapshot,
      buffer,
      telemetryError,
      settings,
      settingsError,
      saveSettings,
      refresh,
      capsVersion,
    }),
    [connection, capabilities, snapshot, buffer, telemetryError, settings, settingsError, saveSettings, refresh, capsVersion],
  );

  return <PulseContext.Provider value={value}>{children}</PulseContext.Provider>;
}
