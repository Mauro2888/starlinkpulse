import type { ConnectionState, DishCapabilities } from "@/types/models";

/** Best-effort friendly model name from the hardware version string. */
export function dishModelName(caps: Pick<DishCapabilities, "hardwareVersion" | "actuators"> | null): string | null {
  const hw = caps?.hardwareVersion?.toLowerCase();
  if (!hw) return null;
  if (hw.startsWith("mini")) return "Starlink Mini";
  if (hw.startsWith("hp")) return "High Performance";
  if (hw.includes("flat")) return "Flat High Performance";
  if (hw.startsWith("rev1")) return "Standard (Gen 1)";
  if (hw.startsWith("rev2") || caps?.actuators === "yes") return "Standard Actuated";
  if (hw.startsWith("rev3") || hw.startsWith("rev4")) return "Standard";
  return caps?.hardwareVersion ?? null;
}

export function isLinkUp(state: ConnectionState | null | undefined): boolean {
  return state === "connected" || state === "mock";
}
