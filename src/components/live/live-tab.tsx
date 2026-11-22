import {
  useCapabilities,
  useConnection,
  useSettings,
  useTelemetry,
} from "@/hooks/use-pulse";
import { useNow } from "@/hooks/use-now";
import { LiveView } from "@/components/live/live-view";
import { lazy, Suspense } from "react";

// The obstruction map (canvas + geometry) loads on demand.
const SkySection = lazy(() =>
  import("@/components/sky/sky-section").then((m) => ({
    default: m.SkySection,
  })),
);

export function LiveTab() {
  const { snapshot, buffer, error } = useTelemetry();
  const connection = useConnection();
  const capabilities = useCapabilities();
  const { settings } = useSettings();
  const now = useNow(1000);

  return (
    <LiveView
      snapshot={snapshot}
      buffer={buffer}
      error={error}
      connection={connection}
      capabilities={capabilities}
      now={now}
      pollIntervalS={settings?.livePollIntervalS ?? 3}
      mockMode={settings?.mockMode ?? null}
      skySlot={
        capabilities?.hasObstructionMap ? (
          <Suspense fallback={null}>
            <SkySection supported />
          </Suspense>
        ) : null
      }
    />
  );
}
