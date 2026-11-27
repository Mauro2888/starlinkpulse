//! Anthropic Messages API call for the AI advisor (contract: docs/api.md, "Phase 4").
//!
//! Raw `reqwest` (rustls). Request building, response parsing and error mapping are pure
//! functions so they can be tested without network access. The API key lives only in the
//! request headers; neither the key nor response bodies are logged above debug level.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::AppError;
use crate::models::{AiFinding, AiOverallHealth, DiagnosticSummary};

pub const API_BASE: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2026-10-21";
pub const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
pub const MAX_TOKENS: u32 = 16_000;
/// Non-streaming request timeout (large models with effort "medium" can take minutes).
pub const TIMEOUT: Duration = Duration::from_secs(300);
const RETRY_BACKOFF: Duration = Duration::from_secs(2);
const MAX_FINDINGS: usize = 12;
const MAX_ACTIONS: usize = 6;
const MAX_TEXT: usize = 2_000;

pub const SYSTEM_PROMPT: &str = "\
You are the network advisor inside StarlinkPulse, a desktop monitor for a Starlink satellite \
internet connection. You receive a JSON object with an anonymized 24-hour diagnostic summary \
of one dish. It includes the number of minutes of history it is based on (`historyMinutes`) \
and the language to write in (`language`, an ISO 639-1 code).

Diagnose the connection and separate clearly between these root causes:
- Local Wi-Fi: weak client signal (`weakestWifiSignalDbm`, roughly below -70 dBm is weak) or \
in-home network problems, which do not show up as dish-side latency or drops.
- Physical obstruction: `fractionObstructed`, outages caused by OBSTRUCTED, and (for dishes \
without motors) a large aiming correction. `azimuthCorrectionDeg` and \
`elevationCorrectionDeg` are the correction to APPLY (recommended minus actual): a positive \
azimuth correction means rotate the dish clockwise seen from above, negative means \
counter-clockwise; a positive elevation correction means tilt up, negative means tilt down. \
Use these signs exactly; never invert them. \
Judge alignment on `pointingErrorDeg`, the combined angle between where the dish points and \
where Starlink recommends: up to 5° counts as aligned, even when one axis alone is off by more \
(azimuth offsets shrink at high elevation). Only suggest rotating or tilting above 5°.
- `isSimulated: true` means the data comes from the built-in simulator, not a real dish; \
say so in the headline.
- Starlink network or congestion: high latency or drop rate in evening hours (`worstHours`, \
local time), NO_DOWNLINK / NO_PINGS / NO_SCHEDULE outages without obstruction. \
`throttledMinutes` counts minutes with POLICY_LIMIT, which means the service plan is being \
deprioritized or limited by Starlink, not a fault of the equipment.
- Hardware or power: BOOTING outages (reboots), thermal issues, power problems.

The payload contains `ruleFindings`: the conclusions of the app's deterministic rule engine, \
computed from the same data. Explain them in plain language, order them by impact, and merge \
duplicates. Keep their numbers. Add a finding of your own only when the data clearly supports \
it, and never contradict a rule finding without citing the numbers that disprove it.

Rules:
- Use only the data in the payload. Never invent measurements, causes or device details. \
`null` means the value is not available for this dish.
- If the data is insufficient (for example `historyMinutes` below 60), say so in the headline \
and keep findings limited to what the data supports.
- Give practical, prioritized actions a non-expert can do (most impactful first). Do not \
recommend actions that need data you do not have.
- If everything looks healthy, say so; do not create problems.
- Write every text field in the requested language.
- Respond only with the JSON object required by the output schema.";

/// True for models that support server-side refusal fallbacks (Opus/Sonnet 5.x, Fable).
/// Models known to support the server-side fallback beta (explicit allow-list).
pub const FALLBACK_MODELS: &[&str] = &[
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-fable-5-2",
    "claude-fable-5-1",
];

/// True for models on [`FALLBACK_MODELS`].
pub fn supports_fallback(model: &str) -> bool {
    FALLBACK_MODELS.contains(&model)
}

/// JSON schema of the model output (`AiReport` minus the fields added by the backend).
pub fn output_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["overallHealth", "headline", "findings"],
        "properties": {
            "overallHealth": { "type": "string", "enum": ["good", "fair", "poor"] },
            "headline": { "type": "string" },
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["category", "severity", "title", "detail", "actions"],
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": ["wifi", "obstruction", "starlink_network", "hardware", "power", "configuration"]
                        },
                        "severity": { "type": "string", "enum": ["info", "warning", "critical"] },
                        "title": { "type": "string" },
                        "detail": { "type": "string" },
                        "actions": { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}

/// Text of the single user message: exactly the `DiagnosticSummary` shown in the preview
/// (it carries `language` and `historyMinutes`).
pub fn user_message(summary: &DiagnosticSummary) -> String {
    format!(
        "Analyze this Starlink diagnostic data and return your assessment.\n\n{}",
        serde_json::to_string_pretty(summary).unwrap_or_default()
    )
}

/// Request body. No `thinking`, `temperature`, `top_p`, `top_k` or prefill (docs/api.md).
pub fn build_body(model: &str, user_text: &str) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_text }],
        "output_config": {
            "effort": "medium",
            "format": { "type": "json_schema", "schema": output_schema() }
        }
    });
    if supports_fallback(model) {
        body["fallbacks"] = json!("default");
    }
    body
}

/// Structured output produced by the model.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOutput {
    pub overall_health: AiOverallHealth,
    pub headline: String,
    pub findings: Vec<AiFinding>,
}

/// Parsed successful response.
#[derive(Debug, Clone, PartialEq)]
pub struct AiResponse {
    /// Model that actually answered (may differ after a fallback).
    pub model: String,
    pub output: AiOutput,
}

fn clip(s: &str) -> String {
    let t = s.trim();
    match t.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => format!("{}…", &t[..i]),
        None => t.to_string(),
    }
}

fn sanitize(mut out: AiOutput) -> Result<AiOutput, AppError> {
    out.headline = clip(&out.headline);
    if out.headline.is_empty() {
        return Err(AppError::AiInvalidResponse("empty headline".into()));
    }
    out.findings = sanitize_findings(std::mem::take(&mut out.findings));
    Ok(out)
}

/// Limits and clips findings (count, text length, actions); drops untitled ones.
pub fn sanitize_findings(mut findings: Vec<AiFinding>) -> Vec<AiFinding> {
    findings.truncate(MAX_FINDINGS);
    for f in &mut findings {
        f.title = clip(&f.title);
        f.detail = clip(&f.detail);
        f.actions = f
            .actions
            .iter()
            .map(|a| clip(a))
            .filter(|a| !a.is_empty())
            .take(MAX_ACTIONS)
            .collect();
    }
    findings.retain(|f| !f.title.is_empty());
    findings
}

/// Parses a 200 response body.
pub fn parse_success(body: &str) -> Result<AiResponse, AppError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AppError::AiInvalidResponse("response is not JSON".into()))?;
    match v.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => return Err(AppError::AiRefused),
        Some("max_tokens") => {
            return Err(AppError::AiInvalidResponse(
                "the answer was truncated (max_tokens)".into(),
            ));
        }
        _ => {}
    }
    let blocks = v
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::AiInvalidResponse("no content".into()))?;
    // Ignore thinking/fallback blocks; with a server-side fallback only the text after the
    // last `fallback` block belongs to the final answer.
    let after_fallback = blocks
        .iter()
        .rposition(|b| b.get("type").and_then(Value::as_str) == Some("fallback"))
        .map_or(0, |i| i + 1);
    let text: String = blocks[after_fallback..]
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    if text.trim().is_empty() {
        return Err(AppError::AiInvalidResponse("no text block".into()));
    }
    let output = parse_output(&text)?;
    let model = v
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(AiResponse { model, output })
}

/// Parses and sanitizes model output text against the report schema (shared by all
/// providers).
pub fn parse_output(text: &str) -> Result<AiOutput, AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::AiInvalidResponse("empty answer".into()));
    }
    let output: AiOutput = serde_json::from_str(text)
        .map_err(|e| AppError::AiInvalidResponse(format!("output does not match schema: {e}")))?;
    sanitize(output)
}

fn api_error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.pointer("/error/message")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(300).collect())
}

/// Maps a non-success HTTP status to an application error.
pub fn map_error_status(
    status: u16,
    retry_after: Option<&str>,
    body: &str,
    model: &str,
) -> AppError {
    match status {
        401 | 403 => AppError::AiAuth(
            "The Anthropic API key was rejected (invalid, revoked or without permission).".into(),
        ),
        402 => AppError::AiAuth(
            "Anthropic billing problem: check the credit balance and billing settings of the account."
                .into(),
        ),
        404 => AppError::InvalidInput(format!(
            "The model \"{model}\" is not available for this API key; choose another model in settings."
        )),
        429 => AppError::AiRateLimit(match retry_after.and_then(|s| s.trim().parse::<u64>().ok()) {
            Some(s) => format!("Rate limited by the Anthropic API; try again in {s} s."),
            None => "Rate limited by the Anthropic API; try again later.".into(),
        }),
        400 => AppError::InvalidInput(format!(
            "The Anthropic API rejected the request: {}",
            api_error_message(body).unwrap_or_else(|| "bad request".into())
        )),
        500 | 529 => AppError::AiUnavailable(
            "The Anthropic API is temporarily overloaded or unavailable; try again later.".into(),
        ),
        other => AppError::AiUnavailable(format!("Unexpected Anthropic API status {other}.")),
    }
}

/// HTTP client for the Messages API.
#[derive(Debug, Clone)]
pub struct AnthropicClient {
    http: reqwest::Client,
    base_url: String,
    retry_backoff: Duration,
}

impl AnthropicClient {
    pub fn new() -> Result<Self, AppError> {
        Self::with_base_url(API_BASE, RETRY_BACKOFF)
    }

    /// Custom endpoint (tests).
    pub fn with_base_url(base_url: &str, retry_backoff: Duration) -> Result<Self, AppError> {
        let http = super::http::client_builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("StarlinkPulse/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AppError::Internal(format!("http client: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            retry_backoff,
        })
    }

    /// Sends the analysis request. One retry on 500/529; no retry on 429.
    pub async fn analyze(
        &self,
        api_key: &str,
        model: &str,
        user_text: &str,
    ) -> Result<AiResponse, AppError> {
        let body = build_body(model, user_text);
        let url = format!("{}/v1/messages", self.base_url);
        for attempt in 0..2 {
            let mut req = self
                .http
                .post(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", API_VERSION)
                .header("content-type", "application/json")
                .json(&body);
            if supports_fallback(model) {
                req = req.header("anthropic-beta", FALLBACK_BETA);
            }
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) if e.is_timeout() => {
                    return Err(AppError::Network(
                        "The Anthropic API did not answer in time.".into(),
                    ));
                }
                Err(_) => {
                    return Err(AppError::Network(
                        "Cannot reach the Anthropic API; check the internet connection.".into(),
                    ));
                }
            };
            let status = resp.status().as_u16();
            let retry_after = resp
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned);
            let text = super::http::read_capped(resp, super::http::MAX_BODY_BYTES)
                .await
                .map_err(|e| match e {
                    super::http::BodyError::TooLarge => {
                        AppError::AiInvalidResponse("the API answer is too large".into())
                    }
                    super::http::BodyError::Timeout => {
                        AppError::Network("The Anthropic API did not answer in time.".into())
                    }
                    super::http::BodyError::Interrupted => {
                        AppError::Network("Connection to the Anthropic API was interrupted.".into())
                    }
                })?;
            tracing::debug!(status, attempt, "anthropic response");
            if (200..300).contains(&status) {
                return parse_success(&text);
            }
            if matches!(status, 500 | 529) && attempt == 0 {
                tracing::info!(status, "Anthropic API unavailable, retrying once");
                tokio::time::sleep(self.retry_backoff).await;
                continue;
            }
            return Err(map_error_status(
                status,
                retry_after.as_deref(),
                &text,
                model,
            ));
        }
        Err(AppError::AiUnavailable(
            "The Anthropic API is unavailable.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AiFindingCategory, AiSeverity};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn output_json() -> String {
        json!({
            "overallHealth": "fair",
            "headline": "Evening congestion",
            "findings": [{
                "category": "starlink_network",
                "severity": "warning",
                "title": "Slow evenings",
                "detail": "Latency rises at 21:00.",
                "actions": ["Schedule large downloads at night", ""]
            }]
        })
        .to_string()
    }

    fn success_body(content: Value, stop_reason: &str) -> String {
        json!({
            "id": "msg_x", "type": "message", "role": "assistant",
            "model": "claude-opus-5-5", "content": content,
            "stop_reason": stop_reason, "usage": {"input_tokens": 1, "output_tokens": 1}
        })
        .to_string()
    }

    #[test]
    fn body_has_schema_and_fallbacks_only_for_supported_models() {
        let b = build_body("claude-opus-5-5", "hi");
        assert_eq!(b["max_tokens"], 16_000);
        assert_eq!(b["fallbacks"], "default");
        assert_eq!(b["output_config"]["effort"], "medium");
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        let schema = &b["output_config"]["format"]["schema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["findings"]["items"]["additionalProperties"],
            false
        );
        // Every property is required at every level.
        let props: Vec<&String> = schema["properties"].as_object().unwrap().keys().collect();
        assert_eq!(schema["required"].as_array().unwrap().len(), props.len());
        let item = &schema["properties"]["findings"]["items"];
        assert_eq!(
            item["required"].as_array().unwrap().len(),
            item["properties"].as_object().unwrap().len()
        );
        for forbidden in ["thinking", "temperature", "top_p", "top_k"] {
            assert!(b.get(forbidden).is_none(), "{forbidden}");
        }
        assert_eq!(b["messages"].as_array().unwrap().len(), 1);
        assert_eq!(b["messages"][0]["role"], "user");

        assert_eq!(build_body("claude-sonnet-5-5", "x")["fallbacks"], "default");
        assert_eq!(build_body("claude-fable-5-2", "x")["fallbacks"], "default");
        assert!(
            build_body("claude-haiku-5-5", "x")
                .get("fallbacks")
                .is_none()
        );
        assert!(!supports_fallback("claude-haiku-5-5"));
        // Explicit allow-list: unknown variants get no beta header.
        assert!(supports_fallback("claude-opus-5"));
        assert!(supports_fallback("claude-fable-5-1"));
        assert!(!supports_fallback("claude-opus-5-9-preview"));
        assert!(!supports_fallback("claude-sonnet-5"));
        assert!(
            build_body("claude-sonnet-5", "x")
                .get("fallbacks")
                .is_none()
        );
    }

    #[test]
    fn user_message_contains_language_and_coverage() {
        let summary = DiagnosticSummary {
            language: "en".into(),
            history_minutes: 37,
            ..Default::default()
        };
        let text = user_message(&summary);
        assert!(text.contains("\"language\": \"en\""));
        assert!(text.contains("\"historyMinutes\": 37"));
        // No envelope: the JSON is the summary itself.
        let json_part = &text[text.find('{').unwrap()..];
        let back: DiagnosticSummary = serde_json::from_str(json_part).unwrap();
        assert_eq!(back, summary);
    }

    #[test]
    fn parses_text_block_among_thinking_and_fallback() {
        let body = success_body(
            json!([
                {"type": "thinking", "thinking": "...", "signature": "s"},
                {"type": "text", "text": "{\"partial\": "},
                {"type": "fallback", "from_model": "claude-opus-5-5"},
                {"type": "thinking", "thinking": "...", "signature": "s"},
                {"type": "text", "text": output_json()}
            ]),
            "end_turn",
        );
        let r = parse_success(&body).unwrap();
        assert_eq!(r.model, "claude-opus-5-5");
        assert_eq!(r.output.overall_health, AiOverallHealth::Fair);
        let f = &r.output.findings[0];
        assert_eq!(f.category, AiFindingCategory::StarlinkNetwork);
        assert_eq!(f.severity, AiSeverity::Warning);
        assert_eq!(
            f.actions,
            vec!["Schedule large downloads at night".to_string()]
        );
    }

    #[test]
    fn stop_reasons_and_invalid_output() {
        let refusal = success_body(json!([{"type": "text", "text": ""}]), "refusal");
        assert_eq!(parse_success(&refusal).unwrap_err().kind(), "ai_refused");
        let truncated = success_body(
            json!([{"type": "text", "text": "{\"overall"}]),
            "max_tokens",
        );
        assert_eq!(
            parse_success(&truncated).unwrap_err().kind(),
            "ai_invalid_response"
        );
        let bad_json = success_body(json!([{"type": "text", "text": "not json"}]), "end_turn");
        assert_eq!(
            parse_success(&bad_json).unwrap_err().kind(),
            "ai_invalid_response"
        );
        let wrong_enum = success_body(
            json!([{"type": "text", "text": "{\"overallHealth\":\"great\",\"headline\":\"x\",\"findings\":[]}"}]),
            "end_turn",
        );
        assert_eq!(
            parse_success(&wrong_enum).unwrap_err().kind(),
            "ai_invalid_response"
        );
        let no_text = success_body(json!([{"type": "thinking", "thinking": "t"}]), "end_turn");
        assert_eq!(
            parse_success(&no_text).unwrap_err().kind(),
            "ai_invalid_response"
        );
        assert_eq!(
            parse_success("<html>").unwrap_err().kind(),
            "ai_invalid_response"
        );
    }

    #[test]
    fn error_status_mapping() {
        let m = "claude-opus-5-5";
        assert_eq!(map_error_status(401, None, "", m).kind(), "ai_auth");
        assert_eq!(map_error_status(403, None, "", m).kind(), "ai_auth");
        let billing = map_error_status(402, None, "", m);
        assert_eq!(billing.kind(), "ai_auth");
        assert!(billing.to_string().contains("billing"));
        assert_eq!(map_error_status(404, None, "", m).kind(), "invalid_input");
        let rl = map_error_status(429, Some("17"), "", m);
        assert_eq!(rl.kind(), "ai_rate_limit");
        assert!(rl.to_string().contains("17 s"));
        assert_eq!(map_error_status(529, None, "", m).kind(), "ai_unavailable");
        let bad = map_error_status(
            400,
            None,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad schema"}}"#,
            m,
        );
        assert_eq!(bad.kind(), "invalid_input");
        assert!(bad.to_string().contains("bad schema"));
    }

    /// Minimal HTTP/1.1 server returning canned responses and recording requests.
    async fn mock_server(responses: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            for (status, body) in responses {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let len = text[..head_end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= head_end + 4 + len {
                            break;
                        }
                    }
                }
                seen2
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf).to_string());
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\nretry-after: 9\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn http_success_sends_expected_headers() {
        let ok = success_body(json!([{"type": "text", "text": output_json()}]), "end_turn");
        let (url, seen) = mock_server(vec![(200, ok)]).await;
        let client = AnthropicClient::with_base_url(&url, Duration::from_millis(10)).unwrap();
        let r = client
            .analyze("sk-test-key", "claude-opus-5-5", "payload")
            .await
            .unwrap();
        assert_eq!(r.output.headline, "Evening congestion");
        let req = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(req.starts_with("post /v1/messages"));
        assert!(req.contains("x-api-key: sk-test-key"));
        assert!(req.contains("anthropic-version: 2026-10-21"));
        assert!(req.contains("anthropic-beta: server-side-fallback-2026-07-01"));
        assert!(req.contains("\"fallbacks\":\"default\""));
    }

    #[tokio::test]
    async fn haiku_has_no_beta_header() {
        let ok = success_body(json!([{"type": "text", "text": output_json()}]), "end_turn");
        let (url, seen) = mock_server(vec![(200, ok)]).await;
        let client = AnthropicClient::with_base_url(&url, Duration::from_millis(10)).unwrap();
        client.analyze("k", "claude-haiku-5-5", "p").await.unwrap();
        let req = seen.lock().unwrap()[0].to_ascii_lowercase();
        assert!(!req.contains("anthropic-beta"));
        assert!(!req.contains("fallbacks"));
    }

    #[tokio::test]
    async fn retries_once_on_overload_then_fails() {
        let (url, seen) = mock_server(vec![(529, "{}".into()), (529, "{}".into())]).await;
        let client = AnthropicClient::with_base_url(&url, Duration::from_millis(10)).unwrap();
        let e = client
            .analyze("k", "claude-opus-5-5", "p")
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "ai_unavailable");
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn retry_succeeds_after_500() {
        let ok = success_body(json!([{"type": "text", "text": output_json()}]), "end_turn");
        let (url, seen) = mock_server(vec![(500, "{}".into()), (200, ok)]).await;
        let client = AnthropicClient::with_base_url(&url, Duration::from_millis(10)).unwrap();
        assert!(client.analyze("k", "claude-opus-5-5", "p").await.is_ok());
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn rate_limit_is_not_retried() {
        let (url, seen) = mock_server(vec![(429, "{}".into())]).await;
        let client = AnthropicClient::with_base_url(&url, Duration::from_millis(10)).unwrap();
        let e = client
            .analyze("k", "claude-opus-5-5", "p")
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "ai_rate_limit");
        assert!(e.to_string().contains("9 s"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unreachable_is_offline() {
        // Bind and drop to get a closed port.
        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let client = AnthropicClient::with_base_url(
            &format!("http://127.0.0.1:{port}"),
            Duration::from_millis(10),
        )
        .unwrap();
        let e = client
            .analyze("k", "claude-opus-5-5", "p")
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "offline");
    }
}
