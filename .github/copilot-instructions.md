# StarlinkPulse: instructions for GitHub Copilot

Desktop app (Tauri v2: Rust backend in `src-tauri/`, React + TypeScript + Tailwind UI in `src/`)
that monitors a Starlink dish over its local gRPC API (`192.168.100.1:9200`) and the optional
Starlink router (`192.168.1.1:9000`). Architecture decisions: `docs/adr.md`. Read it before
changing structure, dependencies or anything that talks to the dish.

## Hard rules
- **Never send write commands to a real dish or router** (`reboot`, `dish_stow`, `set_*`,
  `dish_set_config`, `wifi_set_*`, any `*_set_*`). Only read-only requests (`get_status`,
  `get_history`, `get_device_info`, `get_diagnostics`, `dish_get_config`,
  `dish_get_obstruction_map`, `wifi_get_clients`, reflection). Test writes only in Mock Mode.
- Do not invent gRPC endpoints or fields. Verify with reflection
  (`grpcurl -plaintext 192.168.100.1:9200 describe SpaceX.API.Device.Request`). Treat every field
  as optional; proto3 omits false / 0.
- Never commit SpaceX `.proto` files, secrets, serial numbers, MAC / IP addresses or locations.
  Personal fields are stripped at the decode boundary (`PII_KEYS` in `src-tauri/src/dish/json.rs`).
- Do not assume a dish model. Missing features are hidden, never an error (ADR-003).
- Code, comments and all `.md` files in English. UI strings go through i18n (EN + IT,
  `src/locales/*.json`); keys are the English text.

## Style
- Smallest change that fully solves the task. No speculative options, wrappers or dependencies.
- Follow the patterns already in the file you edit. Comment only the non-obvious why.
- New non-trivial logic gets a test next to the existing ones.

## Checks before saying a task is done
```sh
npm run typecheck && npm test && npm run i18n:check && npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```
Report failures with the exact output. Keep `docs/` in sync with behavior changes
(`docs/diagnostics.md` for rules and thresholds, `docs/api.md` for commands and data).

## Agents
`.github/agents/`: `architect` plans and delegates to `backend`, `frontend` and `reviewer`
(ADR-007).
