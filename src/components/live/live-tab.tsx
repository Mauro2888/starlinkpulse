import { useCapabilities, useConnection, useSettings, useTelemetry } from "@/hooks/use-pulse";
import { useNow } from "@/hooks/use-now";
import { LiveView } from "@/components/live/live-view";

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
    />
  );
}
