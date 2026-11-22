# Built-in diagnosis rules (`rules-v1`)

StarlinkPulse diagnoses the connection with a deterministic rule engine
(`src-tauri/src/rules.rs`). It runs offline, needs no API key, and gives the same output for
the same data. Optional AI providers (Claude or a local model) only explain and prioritize
these findings (`ruleFindings` in the payload).

**Input:** the anonymized 24 h `DiagnosticSummary`, plus three extra inputs: whether the dish
has motors (`hasActuators`), the active alerts from the latest live snapshot, and the number
of reboots (BOOTING outages) in the window.

**No diagnosis** with less than 60 minutes of history: `run_diagnostics` returns
`insufficient_data`.

## Rules and thresholds

| Rule | Category | Condition | Severity |
|---|---|---|---|
| Limited data | configuration | `historyMinutes` < 720 (12 h) | info |
| Dish view obstructed | obstruction | `fractionObstructed` > 1 % **or** OBSTRUCTED outages ≥ 30 s | warning |
| | | `fractionObstructed` > 3 % **or** OBSTRUCTED outages ≥ 300 s | critical |
| Dish not aimed where Starlink recommends | configuration | dishes without motors only; \|`azimuthCorrectionDeg`\| > 2° or \|`elevationCorrectionDeg`\| > 1° (correction = recommended − actual) | warning |
| Speed limited by your plan | starlink_network | `throttledMinutes` > 0 (POLICY_LIMIT = plan deprioritization or data limit). Detail adds "almost all the time" when ≥ 90 % of recorded minutes, and the worst hours | info |
| Outages on the Starlink side | starlink_network | no significant obstruction (see above) and NO_SCHEDULE + NO_DOWNLINK + NO_PINGS + SKY_SEARCH + NETWORK_ISSUE ≥ 60 s | warning |
| | | same, ≥ 600 s | critical |
| Frequent dish restarts | hardware | reboots in 24 h ≥ 2 (one nightly update reboot is normal) | warning |
| | | reboots ≥ 4 | critical |
| Slow or unstable Starlink connection | starlink_network | no significant obstruction and (latency p95 > 100 ms or drop rate > 1 %) | warning |
| | | p95 > 200 ms or drop rate > 5 % | critical |
| Weak Wi-Fi signal | wifi | weakest Wi-Fi client < -70 dBm (Starlink router only) | warning |
| | | < -80 dBm | critical |
| Dish overheating / shut down from heat | hardware | live alert `thermalThrottle` / `thermalShutdown` | warning / critical |
| Connection healthy | starlink_network | no other finding at all | info |

Boundaries are exclusive: exactly 1 %, 100 ms or -70 dBm do **not** trigger a finding.

## Alignment guidance

Same convention as the UI alignment helper:

- **Rotation:** `azimuthCorrectionDeg` = recommended − actual azimuth, wrapped to
  (−180°, 180°]. Positive means rotate clockwise, seen from above.
- **Tilt:** `elevationCorrectionDeg` = recommended − actual elevation. Positive means tilt up.
- The AI system prompt states the same signs, so models never invert the direction.
- Values ≥ 10° are rounded to whole degrees; smaller values to 0.1°.

## Output

- Findings are sorted by severity: critical, then warning, then info.
- `overallHealth` is `poor` if any finding is critical, `fair` if any is a warning, otherwise
  `good`.
- The headline counts the warning and critical findings and names the most important one.
- Latency and drop rate are measured by the dish, so they are never blamed on local Wi-Fi.
- When obstruction is significant, the network-outage and latency rules stay silent, because
  obstruction explains those symptoms.

## Changing thresholds

The thresholds are named constants at the top of `src-tauri/src/rules.rs`. When you change
one, update this table and the boundary tests in the same file.
