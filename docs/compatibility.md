# Dish compatibility notes

StarlinkPulse must work on every Starlink dish model and firmware. Rules derived from reconnaissance and community knowledge:

| Topic | Behaviour | Implementation rule |
|---|---|---|
| Schema | Differs by firmware; public .proto files are outdated | Load schema via server reflection, decode dynamically, cache per `softwareVersion` |
| Missing fields | proto3 JSON/binary omits zero/false/empty | Every telemetry field is `Option<T>`; absent = default |
| NaN values | e.g. `avgProlongedObstructionIntervalS` | Treat NaN/Inf as `None` |
| Actuators | Gen1, Standard Actuated: motorized. Standard (Rev4), Mini, Flat, High Performance (non-actuated): manual | Show stow/unstow only if `hasActuators == HAS_ACTUATORS_YES`; show alignment helper otherwise |
| Request list | Schema lists requests not implemented on the device | Capability = status hints + runtime probe; map `Unimplemented`/`PermissionDenied` to "unsupported" |
| Numeric SNR | Deprecated; only `isSnrAboveNoiseFloor` + `signalQuality` | Never require numeric SNR |
| Power | `powerIn` and/or `powerConsumptionW` in history | Prefer `powerIn`, fallback; hide if neither |
| Location | `get_location` → `PermissionDenied` unless enabled in Starlink app | Never required; never stored |
| Router | Gen2/Gen3/Mini built-in routers expose `192.168.1.1:9000`; third-party routers or bypass mode do not | Router features optional; detect at runtime |
| Network path | With third-party router, `192.168.100.1` may need a static route | Document in README; dish address configurable |
| Speed test | Not reliably available via dish API | Optional, OS/external based (backlog v1.2) |
| History buffer | 900 × 1 s samples, `current` counter | Ingest every ≤ 5 min; dedupe by `current`; handle reboot (counter reset) |
