//! Manual check against a real local Ollama server (no network beyond localhost).
//! Run: STARLINKPULSE_LOCAL_AI_MODEL=qwen3.5:9b cargo test --test real_local_ai -- --ignored --nocapture
use std::time::Instant;

#[tokio::test]
#[ignore]
async fn ollama_real_roundtrip() {
    let model = std::env::var("STARLINKPULSE_LOCAL_AI_MODEL").expect("set model");
    let payload = std::fs::read_to_string(std::env::var("STARLINKPULSE_PAYLOAD").expect("payload file")).unwrap();
    let summary: starlinkpulse_lib::models::DiagnosticSummary = serde_json::from_str(&payload).unwrap();
    let text = starlinkpulse_lib::ai::anthropic::user_message(&summary);
    let c = starlinkpulse_lib::ai::local::LocalClient::new("http://localhost:11434", starlinkpulse_lib::models::LocalAiKind::Ollama).unwrap();
    let t = Instant::now();
    let r = c.analyze(&model, &text).await;
    println!("elapsed {:?}\n{:#?}", t.elapsed(), r);
}
