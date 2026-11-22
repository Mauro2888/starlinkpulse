import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UpdateInfo } from "@/types/models";
import { setBackendForTesting, type Backend } from "@/lib/api";
import { AppUpdates } from "@/components/controls/app-updates";
import { Toaster } from "@/components/ui/sonner";

function fake(info: UpdateInfo, openResult: () => Promise<unknown> = async () => null) {
  const calls: string[] = [];
  const backend: Backend = {
    invoke: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "check_for_update") return info;
      if (cmd === "install_update") return null;
      if (cmd === "open_releases_page") return openResult();
      throw { kind: "internal", message: cmd };
    }),
    listen: vi.fn(async () => () => undefined),
  };
  setBackendForTesting(backend);
  return calls;
}

afterEach(() => setBackendForTesting(null));

const base: UpdateInfo = { updaterConfigured: true, available: false, currentVersion: "0.1.0", latestVersion: "0.1.0", notes: null };

describe("AppUpdates", () => {
  it("shows the build version before checking", () => {
    fake(base);
    render(<AppUpdates />);
    expect(screen.getByText("0.1.0-test")).toBeInTheDocument();
  });

  it("says up to date when nothing is available", async () => {
    fake(base);
    const user = userEvent.setup();
    render(<AppUpdates />);
    await user.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
  });

  it("shows version and notes, and installs only after confirmation", async () => {
    const calls = fake({ ...base, available: true, latestVersion: "0.2.0", notes: "- 3D sky view" });
    const user = userEvent.setup();
    render(<AppUpdates />);
    await user.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(await screen.findByText(/is available/)).toHaveTextContent("Version 0.2.0 is available");
    expect(screen.getByText("- 3D sky view")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Install version 0.2.0 and restart?");
    expect(calls).not.toContain("install_update");

    await user.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(calls).not.toContain("install_update");

    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Install and restart" }));
    expect(calls).toContain("install_update");
  });

  it("points to GitHub Releases when the updater isn't configured", async () => {
    const calls = fake({ ...base, updaterConfigured: false, latestVersion: null });
    const user = userEvent.setup();
    render(<AppUpdates />);
    await user.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(await screen.findByText(/download new versions from/)).toHaveTextContent("GitHub Releases");
    expect(screen.queryByRole("button", { name: /check for updates/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "GitHub Releases" }));
    expect(calls).toContain("open_releases_page");
  });

  it("says when the releases page isn't configured", async () => {
    fake({ ...base, updaterConfigured: false, latestVersion: null }, async () => {
      throw { kind: "invalid_input", message: "no url" };
    });
    const user = userEvent.setup();
    render(
      <>
        <AppUpdates />
        <Toaster />
      </>,
    );
    await user.click(screen.getByRole("button", { name: /check for updates/i }));
    await user.click(await screen.findByRole("button", { name: "GitHub Releases" }));
    expect(await screen.findByText("Releases page not configured in this build")).toBeInTheDocument();
  });
});
