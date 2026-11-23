# Contributing to StarlinkPulse

Thanks for helping! This guide covers setup, the rules that keep users' dishes safe, and how to report a dish model we don't handle well yet.

## Development setup

Prerequisites: Node.js 20+, Rust 1.85+ (edition 2024), and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. On Linux you also need `libdbus-1-dev` for the keyring.

```sh
npm ci
npm run tauri dev       # full desktop app (Rust backend + UI)
```

### UI work without Rust or a dish

```sh
npm run dev             # opens http://localhost:1420
```

Outside Tauri, `src/lib/api.ts` loads an in-browser mock backend from `src/lib/mock/`. It implements the whole command and event contract, including read-only mode and capability checks. Handy URL parameters:

| Parameter | Effect |
|---|---|
| `?mockProfile=mini` | Force a profile and demo mode: `mini`, `standard`, `standard_actuated`, `obstructed`, `throttled`, `offline` |
| `?mockAlign` | Open guided alignment directly (use with `?mockProfile=mini` to see it converge) |
| `?mockReport` | Pre-load a saved Diagnose report |
| `#live`, `#history`, `#controls`, `#diagnose` | Open a specific tab (`#advisor` still works as an alias) |

The mock is dev-only code. It is a separate chunk that the desktop build never loads.

## Tests and checks

Run these before opening a pull request:

```sh
npm run build           # tsc (strict) + vite
npm test                # vitest + Testing Library
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Code style

- **TypeScript** is `strict`; avoid `any`. Use Tailwind with the semantic tokens (`bg-card`, `text-muted-foreground`, …), not raw colours. Icons come from `lucide-react`, charts from `recharts`.
- **Rust**: `cargo fmt`, a clean `clippy`, and errors through `thiserror`.
- **Nullable data**: every telemetry field is optional. Dish models and firmware differ, so missing data must render as "—", never crash.
- **Copy**: short, plain English. Error messages say what happened and how to fix it.
- **Accessibility**: keyboard reachable, visible focus, labels on every control, never colour alone.

## Translations

The UI uses [react-i18next](https://react.i18next.com/). **Keys are the English source strings** ("gettext style"), so code stays readable:

```tsx
const { t } = useTranslation();
<p>{t("No active alerts")}</p>
<p>{t("Last reading {{ago}}.", { ago })}</p>
<p>{t("{{count}} outages, {{duration}}", { count, duration })}</p> // plural: _one / _other keys
```

- Outside components use `tr("…")` from `@/i18n`; for constant label maps mark strings with `tk("…")` and translate at render time with `t(label)`.
- Catalogs: `src/locales/en.json` (generated) and `src/locales/it.json` (hand-written).
- After adding or changing strings run `npm run i18n:extract`. It updates `en.json` (plural keys get `_one`/`_other`; fix the English singular by hand) and lists keys missing from `it.json`.
- `npm run i18n:check` (also covered by the tests) fails if the catalogs are out of sync or a translation drops a `{{placeholder}}`.
- Don't build sentences from fragments: translate whole sentences with placeholders, because word order differs between languages.
- Numbers, dates and units go through `src/lib/format.ts` (Intl with the active language: Italian uses comma decimals, times are always 24 h).
- Texts that come from the backend (built-in rule reports, notifications, tray, error messages) are localized in Rust, not in the UI.
- **Adding a language:** copy `it.json` to `xx.json`, translate the values, register it in `src/i18n/index.ts` (`resources`, `LANGUAGES`, `resolveLanguage`) and in the Settings language list, and add the backend catalog. Write natural phrasing rather than word-for-word translations.

## The contract rule

The UI and the backend share one contract. When you change a command, event or shared type, update **all three in the same pull request**:

1. `src-tauri/src/models.rs` (Rust structs, `serde(rename_all = "camelCase")`)
2. `src/types/models.ts` (TypeScript mirror)
3. `docs/api.md` (the command/event table)

Then update `src/lib/api.ts` and the mock in `src/lib/mock/` so `npm run dev` keeps working.

## Safety: never write to a real dish in tests

> **Do not send write commands to a real dish** from tests, examples or CI. This includes `reboot`, `stow`, `unstow`, `set_snow_melt`, `dish_set_config` and any `*_set_*`.

- Automated tests use the `MockClient` (Rust) or the browser mock (UI) only.
- Only read-only requests may touch a real dish: `get_status`, `get_history`, `get_device_info`, `get_diagnostics`, `dish_get_config`, `dish_get_obstruction_map`, and reflection.
- The single exception is `src-tauri/tests/real_dish_snow_melt.rs`. It is `#[ignore]`, needs `STARLINKPULSE_ALLOW_REAL_WRITE=1`, and only writes back the snow-melt value that is already set. Don't add similar tests.
- Never probe write support automatically. Only a user's explicit, confirmed action may find out that a write is blocked.

## Privacy

Device IDs, serial numbers, MAC addresses, client names, IP addresses and GPS coordinates must never be logged, stored, sent to an AI provider, or committed in fixtures. Anonymize test fixtures in `src-tauri/tests/fixtures/` before committing.

## Reporting a new dish model or firmware

Open a **Dish compatibility** issue. The form asks for:

- the hardware version and firmware version (shown in the app header, or in the Starlink app under Advanced → Debug data)
- your OS and StarlinkPulse version
- optionally, anonymized output of a read-only status request:

  ```sh
  grpcurl -plaintext -d '{"get_status":{}}' 192.168.100.1:9200 SpaceX.API.Device.Device/Handle
  ```

**Before pasting, remove `id`, `deviceId`, serial numbers, MAC addresses, IP addresses, any `uuid`, and any location fields.** Never run write requests to collect data.

## Pull requests

- Keep each PR focused, and describe what changed and how you tested it.
- Update `TASKS.md` if you complete a roadmap item.
- By contributing you agree that your contribution is licensed under the MIT License.
