# Tauri command & event contract

Single source of truth between `src-tauri` (Rust) and `src` (React). Types live in
`src-tauri/src/models.rs` and `src/types/models.ts` (keep in sync).
All commands are async and return `Result<T, CommandError>`; arguments are camelCase on the JS side.

## Commands

| Command | Args | Returns | Phase |
|---|---|---|---|
| `get_connection_status` | – | `ConnectionStatus` | 2 |
| `get_capabilities` | – | `DishCapabilities` | 2 |
| `get_live_snapshot` | – | `TelemetrySnapshot` | 2 |
| `get_history` | `rangeMinutes: u32` | `HistoryPoint[]` (ascending) | 2 |
| `get_events` | `rangeMinutes: u32` | `DishEvent[]` (ascending) | 2 |
| `get_obstruction_map` | – | `ObstructionMap` (`unsupported` error if not available) | 2 |
| `get_settings` | – | `Settings` | 2 |
| `update_settings` | `settings: Settings` | `Settings` (validated, persisted, client reconnects if addresses/mock changed) | 2 |
| `reboot_dish` | – | `()` — `read_only` / `unsupported` errors | 2 |
| `stow_dish` / `unstow_dish` | – | `()` — only if `capabilities.canStow` | 2 |
| `set_snow_melt` | `mode: SnowMeltMode` | `()` | 2 |
| `set_api_key` | `key: string` | `()` (stored in OS keyring, never logged/returned) | 2 |
| `has_api_key` | – | `boolean` | 2 |
| `delete_api_key` | – | `()` | 2 |
| `analyze_network_with_ai` | – | defined in Phase 4 | 4 |

## Events (backend → frontend)

| Event | Payload | When |
|---|---|---|
| `telemetry` | `TelemetrySnapshot` | every `livePollIntervalS` while connected or mock |
| `connection-status` | `ConnectionStatus` | on every state change |
| `capabilities` | `DishCapabilities` | after (re)connect |

## Rules
- Write commands are rejected with `read_only` when `settings.readOnly` is true (default) and with `unsupported` when capabilities say so.
- During development write commands are exercised only against `MockClient`.
- No device IDs, MACs, GPS or client names ever cross this boundary.
