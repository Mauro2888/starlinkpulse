## What does this change?

<!-- One or two sentences. Link the issue if there is one: "Fixes #123". -->

## How was it tested?

- [ ] `npm run build` and `npm test`
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (in `src-tauri/`)
- [ ] Tried it in the app or in the browser mock (`npm run dev`). Profiles / dish model used:

## Checklist

- [ ] **No write commands were sent to a real dish** (reboot, stow, `*_set_*`); writes were tested against the mock only.
- [ ] If a command, event or shared type changed: `models.rs`, `models.ts` and `docs/api.md` are updated together, plus `src/lib/api.ts` and the mock.
- [ ] No device IDs, serials, MAC/IP addresses, location data or API keys in code, fixtures, logs or screenshots.
- [ ] Missing or unsupported data is handled ("—" or hidden control), never an error.
- [ ] UI changes are keyboard accessible, labelled, and don't rely on colour alone.
- [ ] `TASKS.md` updated if a roadmap item is done.

## Screenshots (UI changes)

<!-- Tray width (~380 px) and desktop width if layout changed. -->
