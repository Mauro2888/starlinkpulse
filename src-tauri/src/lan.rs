//! Read-only LAN dashboard for phones and TVs (opt-in, default off).
//!
//! A tiny HTTP/1.1 server on `0.0.0.0:<port>` serving one self-contained page and a JSON
//! status endpoint. Every request needs the short access code (`?k=`), compared in constant
//! time. It never accepts commands and never exposes device names, IDs, MACs or location.
//! The access code and URLs are never logged.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::models::{ConnectionState, LanDashboardInfo, Readiness};
use crate::state::{AppState, lock_db};
use crate::time::now_ms;

pub const TOKEN_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
pub const TOKEN_LEN: usize = 6;
const MAX_CONNECTIONS: usize = 32;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// Uptime / last outage are read from SQLite at most this often.
const SLOW_CACHE_MS: i64 = 60_000;
const PAGE: &str = include_str!("lan_page.html");

/// New random access code (6 characters, no look-alike characters).
pub fn generate_token() -> String {
    let mut out = String::with_capacity(TOKEN_LEN);
    // Rejection sampling keeps the distribution uniform.
    let limit = (256 / TOKEN_ALPHABET.len() * TOKEN_ALPHABET.len()) as u8;
    while out.len() < TOKEN_LEN {
        let mut buf = [0u8; 16];
        if getrandom::fill(&mut buf).is_err() {
            // Extremely unlikely; fall back to the OS-seeded SipHash keys.
            use std::hash::{BuildHasher, Hasher};
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_i64(now_ms());
            buf[..8].copy_from_slice(&h.finish().to_le_bytes());
            buf[8..].copy_from_slice(&h.finish().rotate_left(29).to_le_bytes());
        }
        for b in buf {
            if b < limit && out.len() < TOKEN_LEN {
                out.push(TOKEN_ALPHABET[(b as usize) % TOKEN_ALPHABET.len()] as char);
            }
        }
    }
    out
}

pub fn is_valid_token(t: &str) -> bool {
    (TOKEN_LEN..=32).contains(&t.len()) && t.bytes().all(|b| TOKEN_ALPHABET.contains(&b))
}

/// Constant-time comparison (for equal lengths); an empty expected code never matches.
pub fn token_matches(given: &str, expected: &str) -> bool {
    let (g, e) = (given.as_bytes(), expected.as_bytes());
    if e.is_empty() {
        return false;
    }
    let mut diff = g.len() ^ e.len();
    for (i, b) in e.iter().enumerate() {
        // Case-insensitive: TV keyboards often capitalize the first letter.
        let gb = g.get(i).copied().unwrap_or(0).to_ascii_lowercase();
        diff |= (b.to_ascii_lowercase() ^ gb) as usize;
    }
    diff == 0
}

fn query_token(query: Option<&str>) -> &str {
    query
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("k="))
        .unwrap_or("")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Page,
    Status,
    Forbidden,
    NotFound,
    MethodNotAllowed,
}

/// Pure routing decision: the access code is checked before anything else is revealed.
pub fn route(method: &Method, path: &str, query: Option<&str>, expected: &str) -> Route {
    if method != Method::GET {
        return Route::MethodNotAllowed;
    }
    if !token_matches(query_token(query), expected) {
        return Route::Forbidden;
    }
    match path {
        "/" | "/index.html" => Route::Page,
        "/api/status" => Route::Status,
        _ => Route::NotFound,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanOutage {
    pub start_ms: i64,
    pub duration_s: f64,
    pub cause: String,
}

/// `/api/status` payload: aggregated metrics only (no names, IDs or location).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub now_ms: i64,
    pub lang: &'static str,
    pub state: ConnectionState,
    pub simulated: bool,
    pub down_mbps: Option<f64>,
    pub up_mbps: Option<f64>,
    pub latency_ms: Option<f64>,
    pub loss_pct: Option<f64>,
    pub obstruction_pct: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub readiness: Option<Readiness>,
    #[serde(rename = "uptime24hPct")]
    pub uptime_24h_pct: Option<f64>,
    pub last_outage: Option<LanOutage>,
    pub alerts: Vec<String>,
}

#[derive(Default)]
struct SlowCache {
    at_ms: i64,
    uptime_24h_pct: Option<f64>,
    last_outage: Option<LanOutage>,
}

struct Ctx {
    state: Weak<AppState>,
    slow: Mutex<Option<SlowCache>>,
}

async fn slow_values(ctx: &Ctx, state: &AppState) -> (Option<f64>, Option<LanOutage>) {
    let now = now_ms();
    if let Some(c) = ctx.slow.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
        && now - c.at_ms < SLOW_CACHE_MS
    {
        return (c.uptime_24h_pct, c.last_outage.clone());
    }
    let uptime = crate::commands::uptime_stats(state)
        .await
        .ok()
        .and_then(|u| u.windows.into_iter().find(|w| w.label == "24h"))
        .and_then(|w| w.uptime_pct);
    let db = state.current_db().await;
    let last = tokio::task::spawn_blocking(move || lock_db(&db).outages(48 * 60, now))
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|v| v.into_iter().max_by_key(|o| o.start_ms))
        .map(|o| LanOutage {
            start_ms: o.start_ms,
            duration_s: o.duration_ms.max(0) as f64 / 1000.0,
            cause: o.cause,
        });
    *ctx.slow.lock().unwrap_or_else(|p| p.into_inner()) = Some(SlowCache {
        at_ms: now,
        uptime_24h_pct: uptime,
        last_outage: last.clone(),
    });
    (uptime, last)
}

pub async fn status(
    state: &AppState,
    uptime_24h_pct: Option<f64>,
    last_outage: Option<LanOutage>,
) -> LanStatus {
    let conn = state.status.read().await.state;
    let snap = state.snapshot.read().await.clone();
    let simulated = state.capabilities.read().await.is_mock || conn == ConnectionState::Mock;
    let s = snap.as_ref();
    let mbps = |v: Option<f64>| v.filter(|x| x.is_finite()).map(|b| b / 1e6);
    let pct = |v: Option<f64>| v.filter(|x| x.is_finite()).map(|f| f * 100.0);
    LanStatus {
        now_ms: now_ms(),
        lang: crate::i18n::current().code(),
        state: conn,
        simulated,
        down_mbps: mbps(s.and_then(|s| s.downlink_bps)),
        up_mbps: mbps(s.and_then(|s| s.uplink_bps)),
        latency_ms: s.and_then(|s| s.pop_ping_latency_ms),
        loss_pct: pct(s.and_then(|s| s.pop_ping_drop_rate)),
        obstruction_pct: pct(s.and_then(|s| s.obstruction.fraction_obstructed)),
        jitter_ms: s.and_then(|s| s.jitter_ms),
        readiness: s.and_then(|s| s.readiness),
        uptime_24h_pct,
        last_outage,
        alerts: s.map(|s| s.alerts.clone()).unwrap_or_default(),
    }
}

fn response(
    code: StatusCode,
    content_type: &'static str,
    body: impl Into<Bytes>,
) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(body.into()));
    *r.status_mut() = code;
    let h = r.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    );
    r
}

async fn handle(req: Request<hyper::body::Incoming>, ctx: Arc<Ctx>) -> Response<Full<Bytes>> {
    let text = "text/plain; charset=utf-8";
    let Some(state) = ctx.state.upgrade() else {
        return response(StatusCode::SERVICE_UNAVAILABLE, text, "Unavailable");
    };
    let expected = {
        let s = state.settings.read().await;
        if s.lan_dashboard.enabled {
            s.lan_dashboard.token.clone()
        } else {
            String::new()
        }
    };
    match route(req.method(), req.uri().path(), req.uri().query(), &expected) {
        Route::MethodNotAllowed => {
            let mut r = response(StatusCode::METHOD_NOT_ALLOWED, text, "Method not allowed");
            r.headers_mut()
                .insert("allow", HeaderValue::from_static("GET"));
            r
        }
        Route::Forbidden => response(StatusCode::FORBIDDEN, text, "Forbidden"),
        Route::NotFound => response(StatusCode::NOT_FOUND, text, "Not found"),
        Route::Page => response(StatusCode::OK, "text/html; charset=utf-8", PAGE),
        Route::Status => {
            let (uptime, outage) = slow_values(&ctx, &state).await;
            let body = status(&state, uptime, outage).await;
            match serde_json::to_vec(&body) {
                Ok(json) => response(StatusCode::OK, "application/json", json),
                Err(_) => response(StatusCode::INTERNAL_SERVER_ERROR, text, "Error"),
            }
        }
    }
}

async fn serve(listener: TcpListener, state: Weak<AppState>) {
    let ctx = Arc::new(Ctx {
        state,
        slow: Mutex::new(None),
    });
    // Dropping the set (server stopped / restarted) aborts every open connection.
    let mut conns = JoinSet::new();
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _peer)) => stream,
            Err(e) => {
                tracing::debug!(error = %e, "LAN dashboard accept failed");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        while conns.try_join_next().is_some() {}
        if conns.len() >= MAX_CONNECTIONS {
            continue;
        }
        let ctx = ctx.clone();
        conns.spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let ctx = ctx.clone();
                async move { Ok::<_, Infallible>(handle(req, ctx).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), svc)
                .await;
        });
    }
}

/// Server state kept in [`AppState`].
#[derive(Default)]
pub struct LanServer {
    task: Option<JoinHandle<()>>,
    port: u16,
    error: Option<String>,
}

impl LanServer {
    fn stop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }

    fn running(&self) -> bool {
        self.task.as_ref().is_some_and(|t| !t.is_finished())
    }
}

/// Starts, restarts or stops the server to match the settings. Bind errors are reported in
/// [`LanDashboardInfo::error`], never as a crash.
pub async fn apply(state: &Arc<AppState>) {
    let cfg = state.settings.read().await.lan_dashboard.clone();
    let mut srv = state.lan.lock().await;
    if !cfg.enabled {
        if srv.running() {
            tracing::info!("LAN dashboard stopped");
        }
        srv.stop();
        srv.error = None;
        return;
    }
    if srv.running() && srv.port == cfg.port {
        return;
    }
    srv.stop();
    srv.port = cfg.port;
    match TcpListener::bind((Ipv4Addr::UNSPECIFIED, cfg.port)).await {
        Ok(listener) => {
            srv.error = None;
            srv.task = Some(tokio::spawn(serve(listener, Arc::downgrade(state))));
            tracing::info!(port = cfg.port, "LAN dashboard started");
        }
        Err(e) => {
            tracing::warn!(port = cfg.port, error = %e, "LAN dashboard could not start");
            srv.error = Some(format!("Port {} is not available: {e}", cfg.port));
        }
    }
}

/// Non-loopback, non-link-local IPv4 addresses, private ranges first.
fn lan_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() => {
                Some(v4)
            }
            _ => None,
        })
        .collect();
    ips.sort_by_key(|ip| (!ip.is_private(), *ip));
    ips.dedup();
    ips
}

pub fn urls(ips: &[Ipv4Addr], port: u16, token: &str) -> Vec<String> {
    ips.iter()
        .map(|ip| format!("http://{ip}:{port}/?k={token}"))
        .collect()
}

pub fn qr_svg(data: &str) -> Option<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::new(data.as_bytes()).ok()?;
    let svg = code
        .render::<svg::Color<'_>>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .build();
    // Drop the XML declaration so the markup can be inlined in HTML.
    Some(
        svg.find("<svg")
            .map_or(svg.clone(), |i| svg[i..].to_string()),
    )
}

pub async fn info(state: &AppState) -> LanDashboardInfo {
    let cfg = state.settings.read().await.lan_dashboard.clone();
    let srv = state.lan.lock().await;
    let running = cfg.enabled && srv.running();
    let urls = if running {
        urls(&lan_ipv4s(), cfg.port, &cfg.token)
    } else {
        Vec::new()
    };
    LanDashboardInfo {
        running,
        port: cfg.port,
        qr_svg: urls.first().and_then(|u| qr_svg(u)),
        urls,
        error: if cfg.enabled { srv.error.clone() } else { None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Settings, TelemetrySnapshot};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn tokens() {
        for _ in 0..50 {
            let t = generate_token();
            assert_eq!(t.len(), TOKEN_LEN);
            assert!(is_valid_token(&t), "{t}");
        }
        assert_ne!(generate_token(), generate_token());
        assert!(token_matches("abc234", "abc234"));
        assert!(token_matches("Abc234", "abc234"));
        assert!(!token_matches("abc235", "abc234"));
        assert!(!token_matches("abc23", "abc234"));
        assert!(!token_matches("abc2345", "abc234"));
        assert!(!token_matches("", ""));
        assert!(!is_valid_token("ABCDEF") && !is_valid_token("abcde1") && !is_valid_token("abc"));
    }

    #[test]
    fn routing_checks_the_code_first() {
        let k = "k7qf2m";
        assert_eq!(route(&Method::GET, "/", Some("k=k7qf2m"), k), Route::Page);
        assert_eq!(
            route(&Method::GET, "/api/status", Some("x=1&k=k7qf2m"), k),
            Route::Status
        );
        assert_eq!(
            route(&Method::GET, "/api/status", Some("k=k7qf2n"), k),
            Route::Forbidden
        );
        assert_eq!(
            route(&Method::GET, "/api/status", None, k),
            Route::Forbidden
        );
        assert_eq!(route(&Method::GET, "/nope", None, k), Route::Forbidden);
        assert_eq!(
            route(&Method::GET, "/nope", Some("k=k7qf2m"), k),
            Route::NotFound
        );
        assert_eq!(
            route(&Method::POST, "/api/status", Some("k=k7qf2m"), k),
            Route::MethodNotAllowed
        );
        // Disabled server (empty expected code): always forbidden.
        assert_eq!(route(&Method::GET, "/", Some("k="), ""), Route::Forbidden);
    }

    #[test]
    fn qr_and_urls() {
        let u = urls(&[Ipv4Addr::new(192, 168, 1, 20)], 8787, "abc234");
        assert_eq!(u, ["http://192.168.1.20:8787/?k=abc234"]);
        let svg = qr_svg(&u[0]).unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("</svg>"));
    }

    #[test]
    fn page_is_es5_and_self_contained() {
        for banned in [
            "=>", "let ", "const ", "`", "http://", "https://", "<link", "src=\"",
        ] {
            assert!(!PAGE.contains(banned), "page contains {banned:?}");
        }
        assert!(PAGE.contains("/api/status"));
    }

    async fn request(port: u16, target: &str) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        s.write_all(
            format!("GET {target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn server_end_to_end() {
        let mut settings = Settings::default();
        settings.lan_dashboard.enabled = true;
        settings.lan_dashboard.token = "abc234".into();
        let state = Arc::new(AppState::in_memory(settings).unwrap());
        *state.snapshot.write().await = Some(TelemetrySnapshot {
            downlink_bps: Some(120e6),
            pop_ping_drop_rate: Some(0.01),
            alerts: vec!["thermalThrottle".into()],
            ..Default::default()
        });
        state
            .wifi_clients
            .write()
            .await
            .push(crate::dish::WifiClientInfo {
                name: Some(crate::dish::DeviceName("Secret Phone".into())),
                ..Default::default()
            });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(serve(listener, Arc::downgrade(&state)));

        let denied = request(port, "/api/status?k=abc235").await;
        assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
        assert!(!denied.contains("downMbps"));

        let ok = request(port, "/api/status?k=abc234").await;
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        let lower = ok.to_ascii_lowercase();
        for h in [
            "cache-control: no-store",
            "x-content-type-options: nosniff",
            "referrer-policy: no-referrer",
            "content-type: application/json",
        ] {
            assert!(lower.contains(h), "missing {h}");
        }
        let body = &ok[ok.find("\r\n\r\n").unwrap() + 4..];
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(v["downMbps"], 120.0);
        assert_eq!(v["lossPct"], 1.0);
        assert_eq!(v["alerts"][0], "thermalThrottle");
        assert!(v.get("uptime24hPct").is_some());
        for banned in ["name", "Secret", "mac", "gps", "lat\"", "deviceId", "id\""] {
            assert!(!body.contains(banned), "status leaks {banned}: {body}");
        }

        let page = request(port, "/?k=abc234").await;
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("<!DOCTYPE html>"));

        // Turning the dashboard off rejects requests even on open listeners.
        state.settings.write().await.lan_dashboard.enabled = false;
        assert!(
            request(port, "/?k=abc234")
                .await
                .starts_with("HTTP/1.1 403")
        );
        task.abort();
    }

    #[tokio::test]
    async fn apply_reports_bind_errors() {
        let blocker = std::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = blocker.local_addr().unwrap().port();
        let mut settings = Settings::default();
        settings.lan_dashboard.enabled = true;
        settings.lan_dashboard.port = port;
        settings.lan_dashboard.token = "abc234".into();
        let state = Arc::new(AppState::in_memory(settings).unwrap());
        apply(&state).await;
        let i = info(&state).await;
        assert!(!i.running);
        assert!(i.error.is_some());
        assert!(i.urls.is_empty() && i.qr_svg.is_none());
        drop(blocker);
        state.settings.write().await.lan_dashboard.enabled = false;
        apply(&state).await;
        assert_eq!(info(&state).await.error, None);
    }
}
