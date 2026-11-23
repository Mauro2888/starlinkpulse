import { CloudOff, Loader2 } from "lucide-react";
import { useObstructionMap } from "@/hooks/use-pulse";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { Section } from "@/components/state-panels";
import { ObstructionMapView, type MapMode } from "@/components/sky/obstruction-map";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useMediaQuery, usePrefersReducedMotion } from "@/hooks/use-media";
import { loadSkyMode, resolveSkyMode, saveSkyMode } from "@/lib/view-pref";

/** Obstruction map card. Renders nothing when the dish can't provide a map. */
export function SkySection({ supported }: { supported: boolean }) {
  const { t } = useTranslation();
  const state = useObstructionMap(supported);
  const now = useNow(10_000);
  const reduced = usePrefersReducedMotion();
  const wide = useMediaQuery("(min-width: 768px)");
  const [saved, setSaved] = useState<MapMode | null>(loadSkyMode);
  const mode = resolveSkyMode(saved, wide, reduced);
  if (!supported || state.status === "unsupported") return null;

  const choose = (m: MapMode) => {
    setSaved(m);
    saveSkyMode(m);
  };

  return (
    <Section
      title={t("Sky view")}
      id="sky-view"
      aside={
        <div className="flex items-center gap-2">
          {state.status === "ready" && (
            <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
              {t("Updated {{ago}}", { ago: formatAgo(state.fetchedAt, now) })}
            </span>
          )}
          <div role="group" aria-label={t("Map view")} className="inline-flex h-6 rounded-md bg-muted p-0.5 ring-1 ring-border">
            {(["2d", "3d"] as const).map((m) => {
              const disabled = m === "3d" && reduced;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  disabled={disabled}
                  title={disabled ? t("3D is off because Reduce Motion is on") : m === "3d" ? t("3D dome view") : t("Flat map")}
                  onClick={() => choose(m)}
                  className={cn(
                    "num rounded-[5px] px-2 text-[0.6875rem] uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                    mode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      {state.status === "loading" && (
        <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> {t("Loading obstruction map…")}
        </p>
      )}
      {state.status === "error" && (
        <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground" role="status">
          <CloudOff className="size-3.5" aria-hidden /> {t("Couldn't load the obstruction map.")} {state.error.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          <ObstructionMapView map={state.map} mode={mode} still={reduced} />
          {state.error && (
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              {t("Showing the last map. Refresh failed: {{error}}", { error: state.error.message })}
            </p>
          )}
        </>
      )}
    </Section>
  );
}
