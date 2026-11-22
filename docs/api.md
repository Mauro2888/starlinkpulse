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
| `set_api_key` | `key: string` | `()` (stored in OS keyring, never logged/returned) | 2 |
| `has_api_key` | – | `boolean` | 2 |
| `delete_api_key` | – | `()` | 2 |
| `run_diagnostics` | – | `AiReport` with `source: "rules"` (built-in rule engine, offline, no key; `insufficient_data` if < 60 min) | 4.6 |
| `get_last_rules_report` | – | `AiReport \| null` (last `run_diagnostics` result) | 4.6 |
| `list_local_models` | – | `string[]` (models on the configured local server; `ai_unavailable` if unreachable) | 4.6 |
| `preview_ai_payload` | – | `DiagnosticSummary` (exactly what would be sent; no network call) | 4 |
| `analyze_network_with_ai` | `payload: DiagnosticSummary` (exactly the previewed payload; backend re-validates shape/limits and rejects `isSimulated` mismatch with the current source) | `AiReport` (errors: `no_api_key`, `ai_auth`, `ai_rate_limit`, `ai_unavailable`, `ai_refused`, `ai_invalid_response`, `offline`) | 4 |
| `get_last_ai_report` | – | `AiReport \| null` (persisted last report) | 4 |

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

## Phase 4 – Anthropic API call (backend)
- `POST https://api.anthropic.com/v1/messages`, headers `x-api-key: <keyring>`, `anthropic-version: 2026-10-21`, `content-type: application/json`.
- Body: `model` (settings.claudeModel, default `claude-opus-5-5`), `max_tokens: 16000`, `system` (advisor instructions), one `user` message with the `DiagnosticSummary` JSON,
  `output_config: { effort: "medium", format: { type: "json_schema", schema: <AiReport findings schema, additionalProperties false> } }`.
  Do not send `thinking` (adaptive is default on current models), `temperature`, `top_p`, `top_k`, or assistant prefill.
- Refusal fallback: for `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-*` add header `anthropic-beta: server-side-fallback-2026-07-01` and body `fallbacks: "default"`. Not for Haiku.
- Response: check `stop_reason` first (`refusal` → `ai_refused`, `max_tokens` → `ai_invalid_response`); take the `text` content block (ignore `thinking`/`fallback` blocks), parse JSON, validate. `response.model` → `AiReport.model`.
- Errors: 401/403 → `ai_auth`; 402 → `ai_auth` (billing message); 404 → `invalid_input` (model not available); 429 → `ai_rate_limit` (honor `retry-after`, no auto-loop); 500/529 → one retry with backoff, then `ai_unavailable`; network → `offline`. Timeout 120 s.
- Privacy: payload contains only `DiagnosticSummary` (no IDs, MACs, names, GPS). The API key is never logged or returned.

## Phase 4.6 – Rule engine + optional AI providers
- `run_diagnostics` is the default, always-available path: deterministic Rust rules over the 24 h `DiagnosticSummary` → `AiReport{source:"rules", model:"rules-v1"}`. Persisted as last rules report.
- `analyze_network_with_ai` uses `settings.aiProvider`: `off` → error `invalid_input` ("AI explanations are turned off"); `claude` → Anthropic as in Phase 4; `local` → local server. The payload is `DiagnosticSummary` **including `ruleFindings`**; the model is told to explain/prioritize the rule findings and only add what the data supports. Preview = exact payload.
- Local server: `localAiKind = "ollama"` → `POST {localAiUrl}/api/chat` with `stream:false`, `format: <same JSON schema>`; `"openai_compatible"` (LM Studio, llama.cpp) → `POST {localAiUrl}/v1/chat/completions` with `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}`. No API key. Timeout 180 s. Model list: Ollama `GET /api/tags`, OpenAI-compatible `GET /v1/models`.
- Local URL: http/https only; non-loopback hosts allowed but the UI must warn that data leaves this computer.
- Default `aiProvider: "off"`; `localAiUrl: "http://localhost:11434"`, `localAiKind: "ollama"`, `localAiModel: ""`.
