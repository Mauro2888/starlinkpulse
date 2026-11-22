import { CloudOff, Loader2 } from "lucide-react";
import { useObstructionMap } from "@/hooks/use-pulse";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { Section } from "@/components/state-panels";
import { ObstructionMapView } from "@/components/sky/obstruction-map";

/** Obstruction map card. Renders nothing when the dish can't provide a map. */
export function SkySection({ supported }: { supported: boolean }) {
  const state = useObstructionMap(supported);
  const now = useNow(10_000);
  if (!supported || state.status === "unsupported") return null;

  return (
    <Section
      title="Sky view"
      id="sky-view"
      aside={
        state.status === "ready" ? (
          <span className="text-[0.6875rem] text-muted-foreground">Updated {formatAgo(state.fetchedAt, now)}</span>
        ) : undefined
      }
    >
      {state.status === "loading" && (
        <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Loading obstruction map…
        </p>
      )}
      {state.status === "error" && (
        <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground" role="status">
          <CloudOff className="size-3.5" aria-hidden /> Couldn't load the obstruction map. {state.error.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          <ObstructionMapView map={state.map} />
          {state.error && (
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">Showing the last map. Refresh failed: {state.error.message}</p>
          )}
        </>
      )}
    </Section>
  );
}
