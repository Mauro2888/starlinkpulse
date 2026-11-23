import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { PulseContext, type PulseState } from "@/state/pulse-context";
import { api } from "@/lib/api";
import { normalizeError, type ApiError } from "@/lib/errors";
import type {
  DailyEnergy,
  DataUsage,
  DishEvent,
  HistoryPoint,
  LocationStats,
  ObstructionMap,
  TimeOfDayStats,
  UptimeStats,
} from "@/types/models";

function usePulse(): PulseState {
  const ctx = useContext(PulseContext);
  if (!ctx) throw new Error("usePulse must be used inside <PulseProvider>");
  return ctx;
}

export function useTelemetry() {
  const { snapshot, buffer, telemetryError } = usePulse();
  return { snapshot, buffer, error: telemetryError };
}

export function useConnection() {
  return usePulse().connection;
}

export function useCapabilities() {
  return usePulse().capabilities;
}

export function useSettings() {
  const { settings, settingsError, saveSettings } = usePulse();
  return { settings, error: settingsError, save: saveSettings };
}

export function useRefreshAll() {
  return usePulse().refresh;
}

interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
}

/**
 * Fetches on mount, refetches every `refreshMs` and whenever `refetchKey`
 * changes. A `resetKey` change (different range or data source) also clears
 * stale data. Responses from superseded requests are ignored.
 */
function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  resetKey: string,
  refetchKey: number,
  refreshMs: number,
): AsyncResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const reqId = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(() => {
    const id = ++reqId.current;
    setLoading(true);
    fetcherRef.current().then(
      (d) => {
        if (id !== reqId.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (id !== reqId.current) return;
        setError(normalizeError(e));
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [resetKey]);

  useEffect(() => {
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [resetKey, refetchKey, load, refreshMs]);

  return { data, loading, error, refresh: load };
}

/** Cache identity of the current data source: mock vs real dish, and which dish. */
function useSourceKey(): [string, number] {
  const { capabilities, connection, capsVersion } = usePulse();
  return [`${capabilities?.isMock ?? "?"}|${connection?.dishAddress ?? ""}`, capsVersion];
}

/** Per-minute aggregates for the last `rangeMinutes` (refreshes every minute and on reconnect). */
export function useHistory(rangeMinutes: number): AsyncResource<HistoryPoint[]> {
  const [source, version] = useSourceKey();
  return useAsyncResource(() => api.getHistory(rangeMinutes), `h${rangeMinutes}|${source}`, version, 60_000);
}

/** Outages for the last `rangeMinutes` (BOOTING marks a reboot). */
export function useEvents(rangeMinutes: number): AsyncResource<DishEvent[]> {
  const [source, version] = useSourceKey();
  return useAsyncResource(() => api.getEvents(rangeMinutes), `e${rangeMinutes}|${source}`, version, 60_000);
}

/** Uptime % for 24h / 7d / 30d (refreshes every 5 minutes). */
export function useUptime(): AsyncResource<UptimeStats> {
  const [source, version] = useSourceKey();
  return useAsyncResource(() => api.getUptimeStats(), `u|${source}`, version, 300_000);
}

/** Estimated data usage; refetches when the cap or cycle day changes. */
export function useDataUsage(days = 31): AsyncResource<DataUsage> {
  const [source, version] = useSourceKey();
  const { settings } = usePulse();
  const plan = `${settings?.dataCapGb ?? "none"}|${settings?.billingCycleDay ?? 1}`;
  return useAsyncResource(() => api.getDataUsage(days), `d${days}|${source}|${plan}`, version, 300_000);
}

/** Per-location stats; refetches when the active location changes. */
export function useLocationStats(): AsyncResource<LocationStats[]> {
  const [source, version] = useSourceKey();
  const { settings } = usePulse();
  return useAsyncResource(
    () => api.getLocationStats(),
    `loc|${source}|${settings?.activeLocation ?? ""}`,
    version,
    300_000,
  );
}

/** Weekday × hour aggregates for the last `days` (7–90). */
export function useTimeOfDay(days: number): AsyncResource<TimeOfDayStats> {
  const [source, version] = useSourceKey();
  return useAsyncResource(() => api.getTimeOfDayStats(days), `tod${days}|${source}`, version, 600_000);
}

/** Daily energy (Wh, avg/peak W), newest last. */
export function useEnergy(days: number): AsyncResource<DailyEnergy[]> {
  const [source, version] = useSourceKey();
  return useAsyncResource(() => api.getEnergy(days), `en${days}|${source}`, version, 600_000);
}

/** Write-only API key status. The key itself is never read back. */
export function useApiKey() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(() => {
    api.hasApiKey().then(
      (v) => {
        setHasKey(v);
        setError(null);
      },
      (e) => setError(normalizeError(e)),
    );
  }, []);

  useEffect(reload, [reload]);

  const save = useCallback(
    async (key: string) => {
      await api.setApiKey(key);
      reload();
    },
    [reload],
  );

  const remove = useCallback(async () => {
    await api.deleteApiKey();
    reload();
  }, [reload]);

  return { hasKey, error, save, remove };
}

export type ObstructionMapState =
  | { status: "loading" }
  | { status: "unsupported" }
  | { status: "ready"; map: ObstructionMap; fetchedAt: number; error: ApiError | null }
  | { status: "error"; error: ApiError };

/**
 * Obstruction map, refreshed every `refreshMs` while mounted and the window
 * is visible. An `unsupported` answer is sticky until capabilities change.
 */
export function useObstructionMap(enabled: boolean, refreshMs = 30_000): ObstructionMapState {
  const [source, version] = useSourceKey();
  const [state, setState] = useState<ObstructionMapState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let unsupported = false;
    setState({ status: "loading" });
    const load = () => {
      if (unsupported || document.visibilityState === "hidden") return;
      api.getObstructionMap().then(
        (map) => alive && setState({ status: "ready", map, fetchedAt: Date.now(), error: null }),
        (e) => {
          if (!alive) return;
          const err = normalizeError(e);
          if (err.kind === "unsupported") {
            unsupported = true;
            setState({ status: "unsupported" });
            return;
          }
          // Keep the last good map on transient errors.
          setState((s) => (s.status === "ready" ? { ...s, error: err } : { status: "error", error: err }));
        },
      );
    };
    load();
    const t = setInterval(load, refreshMs);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, refreshMs, source, version]);

  return state;
}
