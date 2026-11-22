//! AI advisor (ADR-005): anonymized 24 h summary -> Anthropic Messages API -> `AiReport`.
//! Nothing is sent without an explicit user action (`analyze_network_with_ai`).

pub mod anthropic;
pub mod summary;

use crate::error::AppError;
use crate::keyring_store;
use crate::models::{AiReport, DiagnosticSummary};
use crate::state::{AppState, lock_db};
use crate::time::now_ms;

/// Output language passed to the model (UI is English for now).
pub const LANGUAGE: &str = "en";

/// Local UTC offset in seconds.
pub fn local_utc_offset_s() -> i64 {
    chrono::Local::now().offset().local_minus_utc() as i64
}

/// Minimum minutes of history required before calling the API.
pub const MIN_HISTORY_MINUTES: u32 = 60;

/// Builds the summary from the active data source (exactly what `analyze` sends).
pub async fn current_summary(state: &AppState) -> Result<DiagnosticSummary, AppError> {
    let now = now_ms();
    let range = summary::WINDOW_HOURS * 60;
    let db = state.current_db().await;
    let (minutes, outages, throttled) = tokio::task::spawn_blocking(move || {
        let db = lock_db(&db);
        Ok::<_, rusqlite::Error>((
            db.history(range, now)?,
            db.outages(range, now)?,
            db.throttled_minutes(range, now)?,
        ))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;
    let caps = state.capabilities.read().await.clone();
    let snapshot = state.snapshot.read().await.clone();
    let wifi = state.wifi_clients.read().await.clone();
    Ok(summary::build_summary(&summary::SummaryInputs {
        now_ms: now,
        minutes: &minutes,
        outages: &outages,
        throttled_minutes: throttled,
        capabilities: Some(&caps),
        snapshot: snapshot.as_ref(),
        wifi_clients: &wifi,
        utc_offset_s: local_utc_offset_s(),
        language: LANGUAGE,
    }))
}

/// Runs the analysis and persists the report. Fails with `insufficient_data` (without any
/// network call or keyring access) when less than an hour of history exists. `api_key` is
/// read from the keyring when `None`.
pub async fn analyze(
    state: &AppState,
    client: &anthropic::AnthropicClient,
    api_key: Option<&str>,
) -> Result<AiReport, AppError> {
    let _busy = state
        .ai_lock
        .try_lock()
        .map_err(|_| AppError::InvalidInput("an analysis is already running".into()))?;
    let payload = current_summary(state).await?;
    if payload.history_minutes < MIN_HISTORY_MINUTES {
        return Err(AppError::InsufficientData);
    }
    let stored_key;
    let key = match api_key {
        Some(k) => k,
        None => {
            stored_key = self::api_key().await?;
            stored_key.as_str()
        }
    };
    let model = state.settings.read().await.claude_model.clone();
    let text = anthropic::user_message(&payload);
    tracing::info!(model = %model, history_minutes = payload.history_minutes, "requesting AI analysis");
    let resp = client.analyze(key, &model, &text).await?;
    let report = AiReport {
        generated_at_ms: now_ms(),
        model: if resp.model.is_empty() {
            model
        } else {
            resp.model
        },
        overall_health: resp.output.overall_health,
        headline: resp.output.headline,
        findings: resp.output.findings,
        payload,
    };
    let db = state.current_db().await;
    let to_store = report.clone();
    tokio::task::spawn_blocking(move || lock_db(&db).save_ai_report(&to_store))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    Ok(report)
}

/// Reads the API key from the keyring (kept in memory only for this request).
pub async fn api_key() -> Result<String, AppError> {
    tokio::task::spawn_blocking(keyring_store::get_api_key)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??
        .ok_or(AppError::NoApiKey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Settings;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot HTTP server answering with a valid model response.
    async fn one_shot_ok() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut total = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap_or(0);
                total.extend_from_slice(&buf[..n]);
                if n == 0 || String::from_utf8_lossy(&total).contains("\"output_config\"") {
                    break;
                }
            }
            let output = serde_json::json!({
                "overallHealth": "good", "headline": "All good", "findings": []
            })
            .to_string();
            let body = serde_json::json!({
                "model": "claude-opus-5-5", "stop_reason": "end_turn",
                "content": [{"type": "text", "text": output}]
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }

    /// Seeds `minutes` minutes of history ending now.
    fn seed(state: &AppState, minutes: i64) {
        let now = now_ms();
        let pts: Vec<crate::models::HistoryPoint> = (1..=minutes)
            .map(|i| crate::models::HistoryPoint {
                minute_ms: crate::time::minute_floor(now) - i * crate::time::MINUTE_MS,
                samples: 60,
                latency_avg_ms: Some(30.0),
                ..Default::default()
            })
            .collect();
        lock_db(&state.db).insert_backfill(&pts, &[], now).unwrap();
    }

    #[tokio::test]
    async fn insufficient_history_fails_without_network() {
        let state = AppState::in_memory(Settings::default()).unwrap();
        seed(&state, 59);
        // Closed port: any network attempt would fail with "offline" instead.
        let client = anthropic::AnthropicClient::with_base_url(
            "http://127.0.0.1:1",
            Duration::from_millis(1),
        )
        .unwrap();
        let err: crate::models::CommandError = analyze(&state, &client, Some("k"))
            .await
            .unwrap_err()
            .into();
        assert_eq!(err.kind, "insufficient_data");
        assert_eq!(
            err.message,
            "Not enough history yet: StarlinkPulse needs at least 1 hour of data. Keep the app running and try again."
        );
        assert_eq!(lock_db(&state.db).last_ai_report().unwrap(), None);
    }

    #[tokio::test]
    async fn analyze_persists_report_with_exact_payload() {
        let state = Arc::new(AppState::in_memory(Settings::default()).unwrap());
        seed(&state, 90);
        let preview = current_summary(&state).await.unwrap();
        assert_eq!(preview.history_minutes, 90);
        assert_eq!(preview.language, "en");
        let client = anthropic::AnthropicClient::with_base_url(
            &one_shot_ok().await,
            Duration::from_millis(1),
        )
        .unwrap();
        let report = analyze(&state, &client, Some("k")).await.unwrap();
        assert_eq!(report.headline, "All good");
        assert_eq!(report.model, "claude-opus-5-5");
        assert_eq!(report.payload, preview);
        let stored = lock_db(&state.db).last_ai_report().unwrap();
        assert_eq!(stored, Some(report));
    }
}
