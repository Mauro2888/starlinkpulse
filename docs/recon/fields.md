# Dish reconnaissance (read-only)

Captured 2026-11-22 from a **Starlink Mini** (`hardwareVersion: mini1_pez_proto1`), firmware `2026.10.17.cr89322.2.58167.1`, `apiVersion` 44.
Only read-only requests were used. Device IDs, router IDs, MAC/IP addresses, client names and GPS data are intentionally omitted.

## Services (reflection `list`)
- `SpaceX.API.Device.Device` — single RPC `Handle(Request) returns (Response)`
- `grpc.reflection.v1.ServerReflection`, `grpc.reflection.v1alpha.ServerReflection` — both available

## `get_status` → `dishGetStatus`
| Field | Type / example | Notes |
|---|---|---|
| `deviceInfo.hardwareVersion` | `mini1_pez_proto1` | model detection |
| `deviceInfo.softwareVersion` | string | schema cache key |
| `deviceInfo.bootcount` | int | |
| `deviceInfo.id` | string | **PII – never store/log** |
| `deviceState.uptimeS` | string (uint64 as JSON string) | reboot detection |
| `popPingLatencyMs` | float | |
| `popPingDropRate` | float | **omitted when 0** |
| `downlinkThroughputBps`, `uplinkThroughputBps` | float | current usage, not capacity |
| `obstructionStats.fractionObstructed` | float 0..1 | |
| `obstructionStats.timeObstructed` | float 0..1 | |
| `obstructionStats.validS` | int | low = unreliable stats |
| `obstructionStats.avgProlongedObstructionIntervalS` | `"NaN"` possible | **parse NaN safely** |
| `obstructionStats.currentlyObstructed` | bool | omitted when false |
| `isSnrAboveNoiseFloor` | bool | no numeric SNR |
| `signalQuality` | float 0..1 | |
| `readyStates.{scp,l1l2,xphy,aap,rf}` | bool | |
| `hasActuators` | enum `HAS_ACTUATORS_NO` / `_YES` | stow capability |
| `alignmentStats.{boresightAzimuthDeg,boresightElevationDeg,desiredBoresightAzimuthDeg,desiredBoresightElevationDeg,tiltAngleDeg,attitudeUncertaintyDeg,attitudeEstimationState}` | float/enum | alignment helper |
| `gpsStats.{gpsValid,gpsSats}` | bool/int | no coordinates |
| `dlBandwidthRestrictedReason`, `ulBandwidthRestrictedReason` | enum `POLICY_LIMIT` / `NO_LIMIT` | throttling |
| `softwareUpdateState` | enum `IDLE`… | |
| `disablementCode` | enum `OKAY`… | |
| `classOfService` | enum `CONSUMER`… | |
| `ethSpeedMbps` | int | |
| `alerts` | object | **absent when no alerts** |
| `config.*` | dish config (snow melt, power save, swupdate hour…) | also via `dish_get_config` |
| `connectedRouters[]`, `downstreamRouters{}` | router IDs as keys | **PII** |
| `initializationDurationSeconds.*` | ints | boot timings |

## `get_history` → `dishGetHistory`
- Ring buffers, length 900 (1 s/sample): `popPingDropRate`, `popPingLatencyMs`, `downlinkThroughputBps`, `uplinkThroughputBps`, `powerIn`, `powerConsumptionW` (same values on this firmware; prefer `powerIn`, fall back to `powerConsumptionW`).
- `current`: monotonically increasing sample counter; index = `current % 900`. When `current < 900` buffer is partially filled.
- `outages[]`: `cause` (seen: `BOOTING`, `NO_DOWNLINK`, `SKY_SEARCH`; also known: `OBSTRUCTED`, `NO_SCHEDULE`, `NO_PINGS`, …), `startTimestampNs` (GPS-epoch ns, string), `durationNs`, `didSwitch`.
- `eventLog.events[]`: `severity` (`EVENT_SEVERITY_ADVISORY`/`WARNING`…), `reason` (`EVENT_REASON_OUTAGE_*`), `startTimestampNs`, `durationNs`, `deviceId` (**PII**); plus `eventLog.startTimestampNs`, `currentTimestampNs`.

## `dish_get_obstruction_map` → `dishGetObstructionMap`
- `numRows` = `numCols` = 123, `snr[]` flat row-major (15129 values), `-1` = no data, `0..1` = quality.
- `minElevationDeg` = 10, `maxThetaDeg` = 80, `mapReferenceFrame` = `FRAME_EARTH`.

## `get_diagnostics` → `dishGetDiagnostics`
- `hardwareSelfTest` (`PASSED`…), `disablementCode`, `alignmentStats` (subset), `alerts`.

## `dish_get_config` → `dishGetConfig.dishConfig`
- `swupdateRebootHour`, `lossOfExtPowerAutoOffTimeoutSeconds`, `noBurstAutoOffTimeoutSeconds`, many `apply*` booleans. `snowMeltMode` omitted = default (AUTO).

## Router `192.168.1.1:9000` — `wifi_get_clients` → `wifiGetClients.clients[]`
Useful non-PII fields: `iface`, `role`, `signalStrength` (dBm, not present on wired/mesh entries), `snr`, `channelWidth`, `estRxRateMbpsFromController`, `estTxRateMbpsFromController`, `associatedTimeS`, `hopsFromController`, `rxStats`, `txStats`.
**PII** (never send to AI/logs): `name`, `macAddress`, `ipAddress`, `ipv6Addresses`, `deviceId`, `clientId`, `upstreamMacAddress`, `domain`.

## Router `192.168.1.1:9000` — `get_status` → `wifiGetStatus` (checked 2026-11-27)
Used: `dishPingLatencyMs`, `popPingLatencyMs`, `ipv6WanAddresses` (reduced to a bool). Also present: `pingLatencyMs`, `popIpv6PingLatencyMs`, `ipv4WanAddress` (CGNAT 100.64/10), `publicIpv4`, `secsSinceLastPublicIpv4Change`, `deviceState.uptimeS`, `alerts`, `clients`.
`wifi_guest_info` → `wifiGuestInfo`: `isOnline`, `routerHardwareVersion`, `dishHardwareVersion`.
`PermissionDenied` on the router: `wifi_get_ping_metrics`, `wifi_backhaul_stats`, `wifi_get_channels`. On the dish (Mini, same date): `get_location` (policy), `dish_get_context`, `dish_get_data`, `dish_get_emc`; `Unimplemented`: `get_ping`, `get_radio_stats`, `get_network_interfaces`, `get_connections`, `get_persistent_stats`, `get_gnss_measurement`.

## Request oneof (schema)
The `Request` message lists ~100 request types **regardless of model** (e.g. `dish_stow` is present on a Mini without actuators; `start_speedtest`/`get_speedtest_status` present, but the skill notes `speed_test` returns `Unimplemented`).
→ Presence in schema is **not** sufficient for capability detection. Combine with status fields (`hasActuators`) and handle `Unimplemented` / `PermissionDenied` at runtime.
