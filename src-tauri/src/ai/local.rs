//! Local model servers (Phase 4.6): Ollama (`/api/chat`) and OpenAI-compatible servers
//! such as LM Studio or llama.cpp (`/v1/chat/completions`). Raw `reqwest`, no API key.
//! Output is parsed and sanitized with the same schema as the Claude path.

use std::time::Duration;

use serde_json::{Value, json};

use super::anthropic::{AiOutput, SYSTEM_PROMPT, output_schema, parse_output};
use crate::error::AppError;
use crate::models::LocalAiKind;

pub const TIMEOUT: Duration = Duration::from_secs(180);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const SCHEMA_NAME: &str = "starlink_report";

/// Ollama chat request: non-streaming, structured output via `format` (JSON schema).
pub fn ollama_body(model: &str, user_text: &str) -> Value {
    json!({
        "model": model,
        "stream": false,
        "format": output_schema(),
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_text }
        ]
    })
}

/// OpenAI-compatible chat request with strict JSON-schema output.
pub fn openai_body(model: &str, user_text: &str) -> Value {
    json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_text }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": SCHEMA_NAME, "schema": output_schema(), "strict": true }
        }
    })
}

/// Parses an Ollama `/api/chat` response.
pub fn parse_ollama(body: &str) -> Result<AiOutput, AppError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AppError::AiInvalidResponse("response is not JSON".into()))?;
    if v.get("done_reason").and_then(Value::as_str) == Some("length") {
        return Err(AppError::AiInvalidResponse(
            "the answer was truncated (context or token limit)".into(),
        ));
    }
    let text = v
        .pointer("/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::AiInvalidResponse("no message content".into()))?;
    parse_output(text)
}

/// Parses an OpenAI-compatible `/v1/chat/completions` response.
pub fn parse_openai(body: &str) -> Result<AiOutput, AppError> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| AppError::AiInvalidResponse("response is not JSON".into()))?;
    let choice = v
        .pointer("/choices/0")
        .ok_or_else(|| AppError::AiInvalidResponse("no choices".into()))?;
    if choice
        .pointer("/message/refusal")
        .and_then(Value::as_str)
        .is_some_and(|r| !r.is_empty())
    {
        return Err(AppError::AiRefused);
    }
    if choice.get("finish_reason").and_then(Value::as_str) == Some("length") {
        return Err(AppError::AiInvalidResponse(
            "the answer was truncated (context or token limit)".into(),
        ));
    }
    let text = choice
        .pointer("/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::AiInvalidResponse("no message content".into()))?;
    parse_output(text)
}

/// Model names from Ollama `/api/tags` or OpenAI-compatible `/v1/models`.
pub fn parse_models(kind: LocalAiKind, body: &str) -> Result<Vec<String>, AppError> {
    let v: Value = serde_json::from_str(body).map_err(|_| {
        AppError::AiUnavailable("the local server returned an invalid model list".into())
    })?;
    let (list, key) = match kind {
        LocalAiKind::Ollama => (v.get("models"), "name"),
        LocalAiKind::OpenaiCompatible => (v.get("data"), "id"),
    };
    let mut names: Vec<String> = list
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get(key).and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    Ok(names)
}

fn server_label(kind: LocalAiKind) -> &'static str {
    match kind {
        LocalAiKind::Ollama => "Ollama",
        LocalAiKind::OpenaiCompatible => "LM Studio / llama.cpp",
    }
}

fn error_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("error")
        .and_then(|e| {
            e.as_str()
                .map(str::to_owned)
                .or_else(|| e.get("message")?.as_str().map(str::to_owned))
        })
        .map(|s| s.chars().take(300).collect())
}

/// Client for one local server.
#[derive(Debug, Clone)]
pub struct LocalClient {
    http: reqwest::Client,
    base_url: String,
    kind: LocalAiKind,
}

impl LocalClient {
    /// `base_url` like `http://localhost:11434`; a trailing `/v1` is tolerated for
    /// OpenAI-compatible servers.
    pub fn new(base_url: &str, kind: LocalAiKind) -> Result<Self, AppError> {
        let mut base = base_url.trim().trim_end_matches('/').to_string();
        if kind == LocalAiKind::OpenaiCompatible
            && let Some(stripped) = base.strip_suffix("/v1")
        {
            base = stripped.to_string();
        }
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::Internal(format!("http client: {e}")))?;
        Ok(Self {
            http,
            base_url: base,
            kind,
        })
    }

    fn unreachable(&self, timeout: bool) -> AppError {
        if timeout {
            AppError::AiUnavailable(format!(
                "The local model at {} did not answer in time. Try a smaller model.",
                self.base_url
            ))
        } else {
            AppError::AiUnavailable(format!(
                "Cannot reach the local AI server. Is {} running at {}?",
                server_label(self.kind),
                self.base_url
            ))
        }
    }

    fn map_status(&self, status: u16, body: &str, model: &str) -> AppError {
        let msg = error_message(body);
        match status {
            404 => AppError::InvalidInput(format!(
                "The model \"{model}\" is not available on the local server; pick one from the model list."
            )),
            400 | 422 => {
                let m = msg.unwrap_or_else(|| "bad request".into());
                if m.to_lowercase().contains("not found") {
                    AppError::InvalidInput(format!(
                        "The model \"{model}\" is not available on the local server; pick one from the model list."
                    ))
                } else {
                    AppError::InvalidInput(format!("The local server rejected the request: {m}"))
                }
            }
            other => AppError::AiUnavailable(format!(
                "The local AI server returned status {other}{}.",
                msg.map(|m| format!(": {m}")).unwrap_or_default()
            )),
        }
    }

    /// Sends the analysis request. The model name is the configured one.
    pub async fn analyze(&self, model: &str, user_text: &str) -> Result<AiOutput, AppError> {
        if model.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "Choose a local model in the AI settings first.".into(),
            ));
        }
        let (url, body) = match self.kind {
            LocalAiKind::Ollama => (
                format!("{}/api/chat", self.base_url),
                ollama_body(model, user_text),
            ),
            LocalAiKind::OpenaiCompatible => (
                format!("{}/v1/chat/completions", self.base_url),
                openai_body(model, user_text),
            ),
        };
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| self.unreachable(e.is_timeout()))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| self.unreachable(e.is_timeout()))?;
        tracing::debug!(status, "local AI response");
        if !(200..300).contains(&status) {
            return Err(self.map_status(status, &text, model));
        }
        match self.kind {
            LocalAiKind::Ollama => parse_ollama(&text),
            LocalAiKind::OpenaiCompatible => parse_openai(&text),
        }
    }

    /// Models available on the server.
    pub async fn list_models(&self) -> Result<Vec<String>, AppError> {
        let url = match self.kind {
            LocalAiKind::Ollama => format!("{}/api/tags", self.base_url),
            LocalAiKind::OpenaiCompatible => format!("{}/v1/models", self.base_url),
        };
        let resp = self
            .http
            .get(&url)
            .timeout(LIST_TIMEOUT)
            .send()
            .await
            .map_err(|e| self.unreachable(e.is_timeout()))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| self.unreachable(e.is_timeout()))?;
        if !(200..300).contains(&status) {
            return Err(AppError::AiUnavailable(format!(
                "The local AI server returned status {status} for the model list."
            )));
        }
        parse_models(self.kind, &text)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::models::AiOverallHealth;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub(crate) fn output_json() -> String {
        json!({
            "overallHealth": "fair",
            "headline": "Obstruction is the main issue",
            "findings": [{
                "category": "obstruction", "severity": "warning", "title": "Tree to the south-west",
                "detail": "2.1 % of the sky is blocked.", "actions": ["Move the dish"]
            }]
        })
        .to_string()
    }

    /// Minimal HTTP server: answers each connection with the next canned response and
    /// records `METHOD PATH` + body.
    pub(crate) async fn server(responses: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
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
                let mut chunk = [0u8; 16384];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let t = String::from_utf8_lossy(&buf).to_string();
                    if let Some(h) = t.find("\r\n\r\n") {
                        let len = t[..h]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= h + 4 + len {
                            break;
                        }
                    }
                }
                seen2
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf).to_string());
                let resp = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    #[test]
    fn request_bodies() {
        let o = ollama_body("llama3.2", "data");
        assert_eq!(o["stream"], false);
        assert_eq!(o["format"]["additionalProperties"], false);
        assert_eq!(o["messages"][0]["role"], "system");
        assert_eq!(o["messages"][1]["content"], "data");
        let c = openai_body("qwen2.5-7b", "data");
        assert_eq!(c["response_format"]["type"], "json_schema");
        assert_eq!(c["response_format"]["json_schema"]["strict"], true);
        assert_eq!(c["response_format"]["json_schema"]["name"], SCHEMA_NAME);
        assert_eq!(c["model"], "qwen2.5-7b");
        assert!(c.get("format").is_none() && o.get("response_format").is_none());
    }

    #[test]
    fn response_parsing() {
        let ok = json!({"model": "llama3.2", "message": {"role": "assistant", "content": output_json()}, "done": true, "done_reason": "stop"});
        assert_eq!(
            parse_ollama(&ok.to_string()).unwrap().overall_health,
            AiOverallHealth::Fair
        );
        let cut = json!({"message": {"content": "{\"overall"}, "done_reason": "length"});
        assert_eq!(
            parse_ollama(&cut.to_string()).unwrap_err().kind(),
            "ai_invalid_response"
        );
        let bad = json!({"message": {"content": "Sure! Here is the report"}});
        assert_eq!(
            parse_ollama(&bad.to_string()).unwrap_err().kind(),
            "ai_invalid_response"
        );

        let oa = json!({"choices": [{"message": {"role": "assistant", "content": output_json()}, "finish_reason": "stop"}]});
        assert_eq!(parse_openai(&oa.to_string()).unwrap().findings.len(), 1);
        let refusal = json!({"choices": [{"message": {"content": null, "refusal": "I can't"}, "finish_reason": "stop"}]});
        assert_eq!(
            parse_openai(&refusal.to_string()).unwrap_err().kind(),
            "ai_refused"
        );
        let len = json!({"choices": [{"message": {"content": "{"}, "finish_reason": "length"}]});
        assert_eq!(
            parse_openai(&len.to_string()).unwrap_err().kind(),
            "ai_invalid_response"
        );
        assert_eq!(
            parse_openai(r#"{"choices": []}"#).unwrap_err().kind(),
            "ai_invalid_response"
        );
    }

    #[test]
    fn model_lists() {
        let ollama = r#"{"models":[{"name":"qwen2.5:7b","size":1},{"name":"llama3.2:3b"}]}"#;
        assert_eq!(
            parse_models(LocalAiKind::Ollama, ollama).unwrap(),
            vec!["llama3.2:3b", "qwen2.5:7b"]
        );
        let openai = r#"{"object":"list","data":[{"id":"phi-4","object":"model"}]}"#;
        assert_eq!(
            parse_models(LocalAiKind::OpenaiCompatible, openai).unwrap(),
            vec!["phi-4"]
        );
        assert!(parse_models(LocalAiKind::Ollama, "{}").unwrap().is_empty());
    }

    #[tokio::test]
    async fn ollama_over_http() {
        let body =
            json!({"message": {"content": output_json()}, "done_reason": "stop"}).to_string();
        let (url, seen) = server(vec![(200, body)]).await;
        let c = LocalClient::new(&url, LocalAiKind::Ollama).unwrap();
        let out = c.analyze("llama3.2:3b", "payload").await.unwrap();
        assert_eq!(out.headline, "Obstruction is the main issue");
        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /api/chat "));
        assert!(req.contains("\"stream\":false"));
        assert!(!req.to_lowercase().contains("authorization"), "no key sent");
    }

    #[tokio::test]
    async fn openai_compatible_over_http_with_v1_suffix() {
        let body =
            json!({"choices": [{"message": {"content": output_json()}, "finish_reason": "stop"}]})
                .to_string();
        let (url, seen) =
            server(vec![(200, body), (200, r#"{"data":[{"id":"m1"}]}"#.into())]).await;
        let c = LocalClient::new(&format!("{url}/v1/"), LocalAiKind::OpenaiCompatible).unwrap();
        c.analyze("m1", "payload").await.unwrap();
        assert_eq!(c.list_models().await.unwrap(), vec!["m1"]);
        let reqs = seen.lock().unwrap().clone();
        assert!(reqs[0].starts_with("POST /v1/chat/completions "));
        assert!(reqs[0].contains("\"strict\":true"));
        assert!(reqs[1].starts_with("GET /v1/models "));
    }

    #[tokio::test]
    async fn errors() {
        let (url, _) = server(vec![
            (404, r#"{"error":"model 'nope' not found"}"#.into()),
            (500, r#"{"error":"out of memory"}"#.into()),
        ])
        .await;
        let c = LocalClient::new(&url, LocalAiKind::Ollama).unwrap();
        let e = c.analyze("nope", "p").await.unwrap_err();
        assert_eq!(e.kind(), "invalid_input");
        assert!(e.to_string().contains("\"nope\""));
        let e = c.analyze("m", "p").await.unwrap_err();
        assert_eq!(e.kind(), "ai_unavailable");
        assert!(e.to_string().contains("out of memory"));
        assert_eq!(
            c.analyze(" ", "p").await.unwrap_err().kind(),
            "invalid_input"
        );

        let port = {
            let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            l.local_addr().unwrap().port()
        };
        let down =
            LocalClient::new(&format!("http://127.0.0.1:{port}"), LocalAiKind::Ollama).unwrap();
        let e = down.analyze("m", "p").await.unwrap_err();
        assert_eq!(e.kind(), "ai_unavailable");
        assert!(
            e.to_string()
                .contains("Is Ollama running at http://127.0.0.1:")
        );
        assert_eq!(
            down.list_models().await.unwrap_err().kind(),
            "ai_unavailable"
        );
    }
}
