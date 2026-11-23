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
| `get_events` | `rangeMinutes: u32` | `DishEvent[]` (ascending, **outages only**, BOOTING = reboot) | 2 |
| `get_obstruction_map` | – | `ObstructionMap` (`unsupported` error if not available) | 2 |
| `get_settings` | – | `Settings` | 2 |
| `update_settings` | `settings: Settings` | `Settings` (validated, persisted, client reconnects if addresses/mock changed) | 2 |
| `reboot_dish` | – | `()` — `read_only` / `unsupported` errors | 2 |
| `stow_dish` / `unstow_dish` | – | `()` — only if `capabilities.canStow` | 2 |
| `set_snow_melt` | `mode: SnowMeltMode` | `()` | 2 |
| `export_history_csv` | `rangeMinutes: u32` | `string \| null` (native save dialog; returns saved path, null if cancelled) | 2 |
| `get_uptime_stats` | – | `UptimeStats` (24h / 7d / 30d) | 4.5 |
| `get_data_usage` | `days: u32` | `DataUsage` (daily list, newest last) | 4.5 |
| `send_test_notification` | – | `()` | 4.5 |
| `check_for_update` | – | `UpdateInfo` (GitHub Releases `latest.json`; `updaterConfigured:false` if no pubkey) | 5 |
| `install_update` | – | `()` (downloads, verifies signature, installs, restarts) | 5 |
| `open_releases_page` | – | `()` (opens the fixed GitHub Releases URL from build config in the system browser; no arbitrary URLs) | 5 |
| `set_alignment_mode` | `enabled: bool` | `()` (fast read-only polling of `get_status` every 1 s while enabled; auto-off after 10 min; emits `telemetry` + `alignment-mode` events) | 4.8 |
| `get_location_stats` | – | `LocationStats[]` (one per location name, incl. "untagged" as name "") | 6 |
| `rename_location` | `from: string, to: string` | `()` | 6 |
| `delete_location` | `name: string` | `()` (removes the tag, not the data) | 6 |
| `get_time_of_day_stats` | `days: u32` (7–90) | `TimeOfDayStats` (168 cells max, local time, DST-safe) | 6 |
| `get_energy` | `days: u32` (1–90) | `DailyEnergy[]` newest last | 6 |
| `set_api_key` | `key: string` | `()` (stored in OS keyring, never logged/returned) | 2 |
| `has_api_key` | – | `boolean` | 2 |
| `delete_api_key` | – | `()` | 2 |
| `run_diagnostics` | – | `AiReport` with `source: "rules"` (built-in rule engine, offline, no key; `insufficient_data` if < 60 min) | 4.6 |
| `get_last_rules_report` | – | `AiReport \| null` (last `run_diagnostics` result) | 4.6 |
| `list_local_models` | – | `string[]` (models on the configured local server; `ai_unavailable` if unreachable; `invalid_input` if `localAiUrl` is not a valid `http(s)://host[:port][/path]`) | 4.6 |
| `preview_ai_payload` | – | `DiagnosticSummary` (exactly what would be sent; no network call) | 4 |
| `analyze_network_with_ai` | `payload: DiagnosticSummary` (exactly the previewed payload; backend re-validates shape/limits and rejects `isSimulated` mismatch with the current source) | `AiReport` (errors: `no_api_key`, `ai_auth`, `ai_rate_limit`, `ai_unavailable`, `ai_refused`, `ai_invalid_response`, `offline`; `insufficient_data` when `historyMinutes` < 60; `invalid_input` when: AI provider is off, an analysis is already running, `isSimulated` differs from the current source, payload fields out of range/invalid, local model not set or not available, local URL invalid, or the API rejected the request (400/404)). `ruleFindings` in the payload are recomputed server-side. | 4 |
| `get_last_ai_report` | – | `AiReport \| null` (persisted last report) | 4 |
| `get_wifi_devices` | – | `WifiDevices` (`available:false` + empty list without a Starlink router; router itself excluded; poor signal first, then `downMbps` desc) | 7 |
| `get_support_report` | – | `string` (anonymized Markdown, UI language) | 7 |
| `export_support_report` | – | `string \| null` (native save dialog, `starlinkpulse-support-YYYYMMDD-HHMM.md`; null if cancelled) | 7 |
| `get_lan_dashboard_info` | – | `LanDashboardInfo` (`urls`/`qrSvg` only while running; `error` e.g. port in use) | 7 |
| `regenerate_lan_token` | – | `Settings` (new access code; old links/QR stop working) | 7 |

## Events (backend → frontend)

| Event | Payload | When |
|---|---|---|
| `telemetry` | `TelemetrySnapshot` | every `livePollIntervalS` while connected or mock |
| `connection-status` | `ConnectionStatus` | on every state change |
| `capabilities` | `DishCapabilities` | after (re)connect |
| `alignment-mode` | `{ enabled: boolean, remainingS: number }` | when alignment mode starts/stops (incl. auto-off) |

## Rules
- Write commands are rejected with `read_only` when `settings.readOnly` is true (default) and with `unsupported` when capabilities say so.
- During development write commands are exercised only against `MockClient`.
- No device IDs, MACs or GPS ever cross this boundary. Wi-Fi client names cross it only in
  `get_wifi_devices` (live UI): they are never logged, persisted, exported, sent to the AI or
  served by the LAN dashboard.

## Phase 4 – Anthropic API call (backend)
- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key: <keyring>`, `anthropic-version: 2026-10-21`, `content-type: application/json`.
- Body: `model` (settings.claudeModel, default `claude-opus-5-5`), `max_tokens: 16000`, `system` (advisor instructions), one `user` message with the `DiagnosticSummary` JSON,
  `output_config: { effort: "medium", format: { type: "json_schema", schema: <AiReport findings schema, additionalProperties false> } }`.
  Do not send `thinking` (adaptive is default on current models), `temperature`, `top_p`, `top_k`, or assistant prefill.
- Refusal fallback: for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-*` add header `anthropic-beta: server-side-fallback-2026-07-01` and body `fallbacks: "default"`. Not for Haiku.
- Response: check `stop_reason` first (`refusal` → `ai_refused`, `max_tokens` → `ai_invalid_response`); take the `text` content block (ignore `thinking`/`fallback` blocks), parse JSON, validate. `response.model` → `AiReport.model`.
- Errors: 401/403 → `ai_auth`; 402 → `ai_auth` (billing message); 404 → `invalid_input` (model not available); 429 → `ai_rate_limit` (honor `retry-after`, no auto-loop); 500/529 → one retry with backoff, then `ai_unavailable`; network → `offline`. Timeout 300 s (non-streaming).
- Privacy: payload contains only `DiagnosticSummary` (no IDs, MACs, names, GPS). The API key is never logged or returned.

## Phase 4.6 – Rule engine + optional AI providers
- `run_diagnostics` is the default, always-available path: deterministic Rust rules over the 24 h `DiagnosticSummary` → `AiReport{source:"rules", model:"rules-v1"}`. Persisted as last rules report.
- `analyze_network_with_ai` uses `settings.aiProvider`: `off` → error `invalid_input` ("AI explanations are turned off"); `claude` → Anthropic as in Phase 4; `local` → local server. The payload is `DiagnosticSummary` **including `ruleFindings`**; the model is told to explain/prioritize the rule findings and only add what the data supports. Preview = exact payload.
- Local server: `localAiKind = "ollama"` → `POST {localAiUrl}/api/chat` with `stream:false`, `format: <same JSON schema>`; `"openai_compatible"` (LM Studio, llama.cpp) → `POST {localAiUrl}/v1/chat/completions` with `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}`. No API key. Timeout 180 s. Model list: Ollama `GET /api/tags`, OpenAI-compatible `GET /v1/models`.
- Local URL: http/https only; non-loopback hosts allowed but the UI must warn that data leaves this computer.
- Default `aiProvider: "off"`; `localAiUrl: "http://localhost:11434"`, `localAiKind: "ollama"`, `localAiModel: ""`.

## Phase 6 (v1.1)
- **i18n:** `settings.language` ("system" | "en" | "it"). Backend localizes notifications, tray menu, rule-engine texts and error messages; the AI payload `language` follows it. Frontend uses react-i18next with the same resolved language (backend exposes the resolved one via `get_settings` → frontend resolves "system" with `navigator.language` falling back to "en").
- **Locations:** every per-minute row and outage is tagged with `settings.activeLocation` at ingest time. Stats are computed per tag.
- **Time of day:** hourly aggregates kept 90 days (new table), grouped by local weekday × hour.
- **Readiness:** computed in Rust per live snapshot from latency, jitter, drop rate and obstruction (thresholds in docs/diagnostics.md); tray tooltip shows it.
- **Energy:** daily Wh from the existing daily table; battery runtime is computed in the UI from `battery` + recent average power.

## Phase 7 (v1.2)
- **Wi-Fi devices:** from the router poll (`wifi_get_clients`, every 15 s while the router is
  connected, read-only). Band: `ETH*` → ethernet, `RF_2*` → 2.4ghz, `RF_5*` → 5ghz, `RF_6*` →
  6ghz. Quality from `signalStrength`: good ≥ −65 dBm, fair ≥ −75, else poor (`null` when not
  reported, e.g. ethernet). Direction: router `rxStats` = device **upload**, `txStats` = device
  **download** (`rateMbps` → link speed, `throughputMbpsLast15sAvg` clamped ≥ 0 → Mbps,
  `bytes` → traffic). In Rust the name is a `DeviceName` (redacted `Debug`, `#[serde(skip)]`).
- **Support report:** app version, hardware/firmware, motors, 24 h coverage, uptime 24h/7d/30d,
  last-24 h latency avg/p95, ping loss, obstruction, throttled minutes, active alerts, outages of
  the last 48 h (totals by cause + newest 50 rows), rule-engine findings, Wi-Fi counts per band /
  quality and weakest dBm (never names). Footer states that no IDs/location/MAC/names are included.
- **LAN dashboard:** `settings.lanDashboard = { enabled: false, port: 8787 (1024–65535), token }`.
  The token (6 chars from `abcdefghjkmnpqrstuvwxyz23456789`) is generated at first start;
  `update_settings` with an empty token keeps the current one. Server: HTTP/1.1 on
  `0.0.0.0:<port>`, (re)started at startup and after `update_settings`; bind failures go to
  `LanDashboardInfo.error`. Routes (GET only, others 405): `/?k=TOKEN` (self-contained ES5 page,
  polls every 3 s), `/api/status?k=TOKEN` → `{ nowMs, lang, state, simulated, downMbps, upMbps,
  latencyMs, lossPct, obstructionPct, jitterMs, readiness, uptime24hPct, lastOutage:{startMs,
  durationS, cause} | null, alerts }`. The code is checked first (constant time) → 403 on mismatch
  or when disabled; 404 for unknown paths. Headers: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, restrictive CSP,
  `X-Frame-Options: DENY`. Max 32 concurrent connections, 10 s header timeout. No write
  commands, no device names/IDs/GPS; the code and URLs are never logged.
