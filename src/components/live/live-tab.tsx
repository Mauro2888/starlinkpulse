import { lazy, Suspense, useCallback, useState } from "react";
import { useCapabilities, useConnection, useSettings, useTelemetry } from "@/hooks/use-pulse";
import { useNow } from "@/hooks/use-now";
import { LiveView } from "@/components/live/live-view";
import { isTauri } from "@/lib/api";

// The obstruction map (canvas + geometry) and the guided alignment overlay load on demand.
const SkySection = lazy(() =>
  import("@/components/sky/sky-section").then((m) => ({
    default: m.SkySection,
  })),
);
const AlignModePanel = lazy(() => import("@/components/sky/align-mode"));

export function LiveTab() {
  const { snapshot, buffer, error } = useTelemetry();
  const connection = useConnection();
  const capabilities = useCapabilities();
  const { settings } = useSettings();
  const now = useNow(1000);
  // Dev aid (browser mock only): `?mockAlign` opens guided alignment directly.
  const [aligning, setAligning] = useState(
    () => !isTauri() && new URLSearchParams(window.location.search).has("mockAlign"),
  );

  const closeAlign = useCallback(() => {
    setAligning(false);
    // Return focus to the Alignment card's button.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>("#alignment button")?.focus(),
    );
  }, []);

  return (
    <>
      <LiveView
        snapshot={snapshot}
        buffer={buffer}
        error={error}
        connection={connection}
        capabilities={capabilities}
        now={now}
        pollIntervalS={settings?.livePollIntervalS ?? 3}
        mockMode={settings?.mockMode ?? null}
        onStartGuidedAlignment={() => setAligning(true)}
        skySlot={
          capabilities?.hasObstructionMap ? (
            <Suspense fallback={null}>
              <SkySection supported />
            </Suspense>
          ) : null
        }
      />
      {aligning && capabilities?.actuators === "no" && (
        <Suspense fallback={null}>
          <AlignModePanel onClose={closeAlign} />
        </Suspense>
      )}
    </>
  );
}
