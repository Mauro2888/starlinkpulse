import type { MapMode } from "@/components/sky/obstruction-map";

const KEY = "starlinkpulse.skyView";

/** Saved 2D/3D choice, or null. Storage errors are ignored (private mode, quotas). */
export function loadSkyMode(): MapMode | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "2d" || v === "3d" ? v : null;
  } catch {
    return null;
  }
}

export function saveSkyMode(mode: MapMode): void {
  try {
    globalThis.localStorage?.setItem(KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * Effective mode: reduced motion forces 2D; otherwise the saved choice, else 3D on
 * desktop widths and 2D in the narrow tray popup.
 */
export function resolveSkyMode(saved: MapMode | null, wide: boolean, reducedMotion: boolean): MapMode {
  if (reducedMotion) return "2d";
  return saved ?? (wide ? "3d" : "2d");
}
