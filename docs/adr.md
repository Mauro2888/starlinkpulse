# Architecture Decision Records

Decisions that shape StarlinkPulse. Agents (Claude Code, GitHub Copilot) and contributors must
follow them; change one only with a new ADR or a dated update to an existing one.

## ADR-001: Cross-platform tech stack (Tauri v2)
- **Context:** Lightweight app (~10-15 MB), System Tray / Menu Bar, distributable on macOS, Windows and Linux from a single repo without Python or Docker.
- **Decision:** **Tauri v2**, **Rust** backend, **React + TypeScript + Tailwind CSS** frontend. Charts with **`recharts`**, icons with **`lucide-react`**.
- **Consequences:** A single codebase produces `.dmg`, `.exe`/`.msi`, `.AppImage`/`.deb`.

## ADR-002: gRPC via Server Reflection (no committed .proto)
- **Context:** SpaceX does not publish the `.proto` files. Those circulating online are outdated (`invalid wire type`, `Unimplemented` errors). Firmware changes often and differs between models. Redistributing extracted protos in a public repo is legally ambiguous.
- **Decision:** At startup the backend downloads the schema from the dish via **gRPC Server Reflection** and decodes messages dynamically with **`prost-reflect`** + a generic **`tonic`** client (method `SpaceX.API.Device.Device/Handle`). Fields are read **by name**, every field treated as optional (proto3 JSON omits false/0: absent = default).
- **Consequences:** Schema always matches the user's firmware; no `protoc` in build/CI; no SpaceX protos in the repo. The downloaded schema is cached in `app_data_dir` for fast startup and compared with the firmware version.
- **Endpoints:** Dish `192.168.100.1:9200` (required). Starlink router `192.168.1.1:9000` (optional: Wi-Fi clients; absent with third-party routers or bypass mode). Configurable addresses. Short timeout (default 5s).

## ADR-003: Capability detection per model
- **Context:** Models have different features (e.g. non-motorized Mini/Standard do not support stow; some firmware does not expose numeric SNR or `get_location`).
- **Decision:** On connect the backend builds a `DishCapabilities` object from `get_device_info`, `get_status` (`hasActuators`, etc.) and the requests present in the reflection schema. The UI shows only supported features; missing features = hidden or disabled with a tooltip, never an error.

## ADR-004: Local data persistence
- **Context:** AI analysis needs data from the last 24-48 hours.
- **Decision:** **SQLite** (`rusqlite`, bundled) in `app_data_dir`. Primary source: `get_history` (circular buffer of ~900 1s samples) read every ~5 min; per-minute aggregates saved (latency avg/min/max/p95, drop rate, throughput, power) + events (`eventLog`: outage, boot). Dedup via the `current` index. Records > 48h purged. `get_status` every 3s only for the Live view (not persisted).
- **Consequences:** No data gaps while the app is in the background; minimal load on the dish.

## ADR-005: Rule-based diagnosis + optional AI module (BYOK / local)
- **Update 2026-11-22:** baseline diagnosis is a deterministic rule engine in Rust (offline, free, no key). AI is an optional extra (default OFF) that explains the rules' conclusions: provider `claude` (BYOK) or `local` (Ollama / the user's OpenAI-compatible server). No model bundled with the app (size).
- **Update 2026-11-27 (Common problems):** the Diagnose tab includes a static symptom-based guide ("Common problems"), visible in every state and without detection. First entry: Instagram/Facebook videos buffering on phones (QUIC over UDP through IPv4 CGNAT, user reports 2021–22). Suggested remedies: IPv6 / DHCPv6-PD on your own router, block outbound UDP 80/443 on your own router, VPN or firewall app on the phone. **Not** implemented: QUIC vs TCP probe (needs an HTTP/3 client `quinn`/`h3`, weight against ADR-001) and OS firewall rules (writing to the user's system against ADR-006; useless for phones). The Starlink router exposes no firewall write via gRPC (only `wifi_get_firewall`, read). Done 2026-11-27: the router's `get_status` is read (IPv6 yes/no from `ipv6WanAddresses`, router→dish and router→PoP latency) plus `wifi_guest_info.isOnline`; shown in the Wi-Fi card and as an IPv6 hint in the guide.
- **Context:** Open Source, no hardcoded API key.
- **Decision:** Anthropic API key stored in the native Keyring (`keyring` crate). On Linux without Secret Service: clear message + optional fallback to a file with 600 permissions (explicit opt-in). Configurable model (default `claude-opus-5-5`; options `claude-sonnet-5-5`, `claude-haiku-5-5`). The backend aggregates the last 24h of metrics into compact JSON. No data sent without explicit user action; never send device ID, GPS location or MAC address.

## ADR-006: Write command safety
- **Context:** Reboot / stow / snow-melt change the antenna state of real users.
- **Decision:** Every write command requires explicit UI confirmation, is available only if supported (ADR-003) and can be disabled globally in settings ("Read-only mode", default ON at first launch).

## ADR-007: AI coding agents (GitHub Copilot custom agents)
- **Context:** The project is developed with AI coding agents. `CLAUDE.md` is local (not in the
  repo), so agents that run elsewhere (GitHub Copilot in the IDE, Copilot app, cloud agent) need
  the project rules and roles in tracked files.
- **Decision:** Four Copilot custom agents in `.github/agents/*.agent.md`:
  - `architect` (operator): plans, checks consistency with these ADRs, splits work and delegates
    to the other three via the `agent` tool. Does not write feature code itself.
  - `backend`: Rust / Tauri backend (`src-tauri/`).
  - `frontend`: React + TypeScript + Tailwind UI (`src/`).
  - `reviewer`: read-only review and test run; reports findings, never fixes.
  Shared rules live in `.github/copilot-instructions.md` (loaded by Copilot for every agent);
  decisions live here. Tool names are the portable ones (`read`, `edit`, `search`, `execute`,
  `agent`, `web`, `todo`) so the same files work in VS Code, the Copilot app and the cloud agent.
  No `handoffs` / `agents` fields: they are VS Code-only and ignored or rejected elsewhere.
- **Consequences:** The Claude Code agents in `.claude/agents/` stay for Claude Code; both sets
  follow the same ADRs. A rule that changes must be updated in `.github/copilot-instructions.md`
  and here, not only in a local file.
