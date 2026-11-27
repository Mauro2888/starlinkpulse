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
| Dish not aimed where Starlink recommends | configuration | dishes known to have **no motors** (`hasActuators = NO`); \|`azimuthCorrectionDeg`\| > 2° or \|`elevationCorrectionDeg`\| > 1° (correction = recommended − actual); gives exact rotate/tilt actions | warning |
| Dish orientation differs from the recommendation | configuration | motors **unknown**, same thresholds: numbers only, no rotate/tilt instruction ("if your dish has no motors, use the alignment helper"). Dishes with motors: nothing | info |
| Speed limited by your plan | starlink_network | `throttledMinutes` > 0 (POLICY_LIMIT = plan deprioritization or data limit). Detail adds "almost all the time" when ≥ 90 % of recorded minutes (no hour list: deprioritization is not a congestion claim) | info |
| Outages on the Starlink side | starlink_network | no significant obstruction (see above) and NO_SCHEDULE + NO_DOWNLINK + NO_PINGS + SKY_SEARCH + NETWORK_ISSUE ≥ 60 s. Says "clear view" only when `fractionObstructed` was measured and is ≤ 1 %, otherwise "no significant obstruction was measured"; notes that SKY_SEARCH can follow a restart | warning |
| | | same, ≥ 600 s | critical |
| Frequent dish restarts | hardware | reboots in 24 h ≥ 2 (one nightly update reboot is normal) | warning |
| | | reboots ≥ 4 | critical |
| Slow or unstable Starlink connection | starlink_network | no significant obstruction and (latency p95 > 100 ms or drop rate > 1 %). Congestion is mentioned only when the worst local hour's p95 > 1.5 × the 24 h average latency | warning |
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

## Live readiness (videoCall / gaming / streaming)

Computed in Rust (`src-tauri/src/readiness.rs`) for every live snapshot, over the live
samples of the last 2 minutes:

- **Latency:** the mean of the samples that have a latency.
- **Jitter (`jitterMs`):** the mean |Δ latency| between consecutive samples. Reported only
  once there are at least 10 samples; until then it is `null`, and so is the readiness.
- **Drop rate:** the mean ping drop rate over the window.

| Use | Good | Fair | Poor |
|---|---|---|---|
| Gaming | latency < 50 ms, jitter < 10 ms, drop < 0.5 % | latency < 100 ms, jitter < 30 ms, drop < 2 % | otherwise |
| Video call | latency < 100 ms, jitter < 30 ms, drop < 1 % | latency < 200 ms, jitter < 50 ms, drop < 3 % | otherwise |
| Streaming (buffered) | drop < 2 % | drop < 5 % | otherwise |

- While `currentlyObstructed` is true, no use can be rated "good" (at most "fair").
- During an outage (no latency and drop rate 100 %), every use is "poor".
- The tray tooltip shows the rating, e.g. `Connected · 26 ms · Video ✓ · Gaming ~ · Streaming ✓`
  (✓ good, ~ fair, ✗ poor).

## Common problems (static guide)

Below the report, the Diagnose tab shows a short "Common problems" guide. It is static text in
the frontend (`src/components/advisor/common-problems.tsx`), shown even without enough history.
The only detection: with a Starlink router, the buffering entry says whether the router has a
global IPv6 address (read-only router `get_status`, see docs/api.md). No internet requests.

### Instagram / Facebook videos buffering on phones

- **Reported cause:** Starlink users reported in 2021–22 that Meta's apps load media badly
  over QUIC (HTTP/3 on UDP 443) through Starlink's IPv4 CGNAT, and that forcing the fallback to
  TCP fixes it ([O'Reilly](https://www.oreilly.ie/starlink-instagram-and-facebook-fix/),
  [Starlink Free](https://starlinkfree.com/starlink-facebook-issue-fixed/),
  [R. Bourlier](https://www.linkedin.com/pulse/starlink-%C3%A9pisode-2-ma-configuration-ronan-bourlier-)).
  Starlink also documents a cap on concurrent CGNAT sessions on Residential/Roam plans
  ([Starlink Help Center](https://starlink.com/support/article/bb372afe-7dd4-ae54-a2af-29cf63d24ddf)).
  None of this is confirmed as current; treat it as user reports.
- **IPv6:** Starlink hands out IPv6 (a /56 via DHCPv6-PD to third-party routers), and Meta's
  app and media hosts (`instagram.com`, `*.cdninstagram.com`, `*.fbcdn.net`) answer over IPv6
  (checked 2026-11-27). Traffic over IPv6 does not cross the IPv4 CGNAT, so enabling IPv6 on a
  third-party router is the first suggestion. This is an inference, not a confirmed fix.
- **Fallback:** block outgoing UDP 80/443 on a third-party router so apps switch to TCP. The
  Starlink router has no firewall rules (its gRPC API only offers `wifi_get_firewall`, read-only).
- **Without a router change:** a VPN on the phone, or on Android a firewall app. iOS has no
  setting for this.
- **Not built, on purpose:** a QUIC vs TCP probe (needs an HTTP/3 client, which adds weight to the
  app) and OS firewall rules on the computer (writes to the user's system, and do not help phones).

## Languages

All rule texts come from the EN/IT catalog in `src-tauri/src/i18n.rs` (`RuleTexts`). Numbers
use the locale's decimal separator: `4.1 %` in English, `4,1 %` in Italian. The thresholds are
the same in every language.
