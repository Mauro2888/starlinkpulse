import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TelemetrySnapshot } from "@/types/models";
import { setBackendForTesting, type Backend } from "@/lib/api";
import { AlignMode } from "@/components/sky/align-mode";

function fake() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (p: unknown) => void>();
  const backend: Backend = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return null;
    }),
    listen: vi.fn(async (event: string, h: (p: unknown) => void) => {
      handlers.set(event, h);
      return () => handlers.delete(event);
    }),
  };
  setBackendForTesting(backend);
  return { calls, handlers };
}

const snap = (t: number, az: number, el: number): TelemetrySnapshot =>
  ({
    timestampMs: t,
    alignment: {
      azimuthDeg: az,
      elevationDeg: el,
      desiredAzimuthDeg: 178,
      desiredElevationDeg: 66,
      tiltAngleDeg: 24,
      uncertaintyDeg: 0.8,
      estimationState: "FILTER_CONVERGED",
    },
  }) as TelemetrySnapshot;

afterEach(() => setBackendForTesting(null));

describe("AlignMode", () => {
  it("starts fast polling on open and always stops it on close", async () => {
    const { calls } = fake();
    const { unmount } = render(<AlignMode snapshot={null} onClose={() => undefined} />);
    await vi.waitFor(() => expect(calls).toContainEqual({ cmd: "set_alignment_mode", args: { enabled: true } }));
    unmount();
    await vi.waitFor(() => expect(calls).toContainEqual({ cmd: "set_alignment_mode", args: { enabled: false } }));
  });

  it("exits with Escape", async () => {
    fake();
    const onClose = vi.fn();
    render(<AlignMode snapshot={null} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows big direction guidance, and hold-still instead of directions after a jump", () => {
    fake();
    const { rerender } = render(<AlignMode snapshot={snap(0, 166.8, 63.9)} onClose={() => undefined} />);
    expect(screen.getByText("Rotate clockwise")).toBeInTheDocument();
    expect(screen.getByText("11°")).toBeInTheDocument();
    rerender(<AlignMode snapshot={snap(1000, 172, 63.9)} onClose={() => undefined} />);
    expect(screen.getByText("Hold still…")).toBeInTheDocument();
    expect(screen.queryByText(/Rotate/)).not.toBeInTheDocument();
  });

  it("shows the countdown from the alignment-mode event and the stopped state on auto-off", async () => {
    const { handlers } = fake();
    render(<AlignMode snapshot={null} onClose={() => undefined} />);
    await vi.waitFor(() => expect(handlers.has("alignment-mode")).toBe(true));
    act(() => handlers.get("alignment-mode")!({ enabled: true, remainingS: 600 }));
    expect(screen.getByText(/10:00 left|9:59 left/)).toBeInTheDocument();
    act(() => handlers.get("alignment-mode")!({ enabled: false, remainingS: 0 }));
    expect(screen.getByText("Guided alignment stopped")).toBeInTheDocument();
  });

  it("remembers the sound toggle", async () => {
    fake();
    localStorage.removeItem("starlinkpulse.alignAudio");
    const user = userEvent.setup();
    render(<AlignMode snapshot={null} onClose={() => undefined} />);
    const btn = screen.getByRole("button", { name: "Sound on" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    await user.click(btn);
    expect(screen.getByRole("button", { name: "Sound off" })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("starlinkpulse.alignAudio")).toBe("off");
  });
});
