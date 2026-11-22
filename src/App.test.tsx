import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";

// Smoke test: outside Tauri the app wires itself to the in-browser mock backend.
describe("App (mock backend)", () => {
  it("shows live mock data and can switch tabs", async () => {
    render(<App />);
    expect(await screen.findByText(/showing simulated data/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Connection: Mock data/ })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Controls/ }));
    expect(await screen.findByRole("button", { name: /reboot dish/i })).toBeDisabled();
    expect(await screen.findByRole("switch", { name: /Read-only mode/ })).toBeChecked();

    await user.click(screen.getByRole("tab", { name: /History/ }));
    expect(await screen.findByRole("radiogroup", { name: "Time range" }, { timeout: 3000 })).toBeInTheDocument();
  });
});
