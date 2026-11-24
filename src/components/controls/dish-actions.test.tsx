import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DishCapabilities } from "@/types/models";
import { DishActions } from "@/components/controls/dish-actions";

const caps: DishCapabilities = {
  hardwareVersion: "rev3_proto2",
  softwareVersion: "x",
  actuators: "no",
  canStow: false,
  canReboot: true,
  canSetSnowMelt: false,
  hasObstructionMap: true,
  hasPowerTelemetry: true,
  hasAlignmentStats: true,
  hasRouter: true,
  isMock: true,
  snowMeltMode: null,
};

function setup(props: Partial<Parameters<typeof DishActions>[0]> = {}) {
  const onRun = vi.fn(async () => undefined);
  render(<DishActions capabilities={caps} readOnly={false} linkUp onRun={onRun} {...props} />);
  return { onRun, user: userEvent.setup() };
}

describe("DishActions", () => {
  it("disables reboot and never opens the dialog in read-only mode", async () => {
    const { onRun, user } = setup({ readOnly: true });
    const reboot = screen.getByRole("button", { name: /reboot dish/i });
    expect(reboot).toBeDisabled();
    expect(screen.getByText(/Read-only mode is on/)).toBeInTheDocument();
    await user.click(reboot);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("asks for confirmation and runs only after confirming", async () => {
    const { onRun, user } = setup();
    await user.click(screen.getByRole("button", { name: /reboot dish/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Reboot the dish?");
    expect(onRun).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reboot" }));
    expect(onRun).toHaveBeenCalledWith({ type: "reboot" });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const { onRun, user } = setup();
    await user.click(screen.getByRole("button", { name: /reboot dish/i }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("hides unsupported actions", () => {
    setup();
    expect(screen.queryByRole("button", { name: /^stow/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/snow melt/i)).not.toBeInTheDocument();
  });

  it("shows stow controls when the dish has actuators", () => {
    setup({ capabilities: { ...caps, canStow: true, actuators: "yes" } });
    expect(screen.getByRole("button", { name: /^stow/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^unstow/i })).toBeInTheDocument();
  });

  it("shows the current snow melt mode and enables Apply only for a different mode", () => {
    setup({ capabilities: { ...caps, canSetSnowMelt: true, snowMeltMode: "always_off" } });
    expect(screen.getByText("Current:").parentElement).toHaveTextContent("Current: Off");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("requires an explicit choice when the current snow melt mode is unknown", () => {
    setup({ capabilities: { ...caps, canSetSnowMelt: true, snowMeltMode: null } });
    expect(screen.getByText(/Current:/)).toHaveTextContent("unknown");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("closes an open confirmation and blocks the write when read-only turns on", async () => {
    const onRun = vi.fn(async () => undefined);
    const props = { capabilities: { ...caps, canReboot: true }, linkUp: true, onRun };
    const { rerender } = render(<DishActions {...props} readOnly={false} />);
    await userEvent.click(screen.getByRole("button", { name: /reboot dish/i }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    rerender(<DishActions {...props} readOnly />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("resets to an explicit choice when the reported mode becomes unknown", () => {
    const props = { readOnly: false, linkUp: true, onRun: vi.fn(async () => undefined) };
    const { rerender } = render(<DishActions {...props} capabilities={{ ...caps, canSetSnowMelt: true, snowMeltMode: "auto" }} />);
    rerender(<DishActions {...props} capabilities={{ ...caps, canSetSnowMelt: true, snowMeltMode: null }} />);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
