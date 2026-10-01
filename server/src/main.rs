// Deck VPS backend — a bearer-guarded proxy in front of the host helper.
//
// GET  /health            unauthenticated liveness.
// GET  /status            bearer-guarded. Host stats + container list.
// POST /action            bearer-guarded. start/stop/restart a container.
// GET  /logs              bearer-guarded. Tail one container's log.
//
// The container is deliberately dumb: it has no docker socket and no vault access, so every
// one of these is proxied to the host helper (VPS_HELPER_URL), the localhost service on the
// VPS host that can actually run docker. This process contributes exactly one thing the helper
// does not: the bearer check, so the helper never has to be exposed.
//
// This used to also carry a phone relay (/desk/*), remote triggers (/trigger) and FCM push
// (/notify). All three went with the phone app — see docs/vps-plugin-plan.md. The VPS-target
// scheduler is untouched by that: it never went through here, reading its job list straight
// from the synced vault instead (host/deck-vps-scheduler.sh).

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;

pub struct AppState {
    bearer: String,
    // Host helper base URL — the localhost service on the VPS host that does the docker/stats
    // work the container cannot.
    pub vps_helper: String,
}

#[tokio::main]
async fn main() {
    let state = Arc::new(AppState {
        bearer: env_required("BEARER_TOKEN"),
        vps_helper: env_or("VPS_HELPER_URL", "http://host.docker.internal:8899"),
    });

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        // VPS status/control — proxied to the host helper (the container has no docker/ssh).
        .route("/status", get(vps_status))
        .route("/action", post(vps_action))
        .route("/logs", get(vps_logs))
        // Allow the Tauri webview (and any client) to call these cross-origin; bearer is the gate.
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn env_required(k: &str) -> String {
    match std::env::var(k) {
        Ok(v) if !v.is_empty() => v,
        _ => {
            eprintln!("missing required env {k}");
            std::process::exit(1);
        }
    }
}

fn env_or(k: &str, default: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn bearer_ok(headers: &HeaderMap, bearer: &str) -> bool {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    ct_eq(presented.as_bytes(), bearer.as_bytes())
}

// ---- VPS status/control: bearer-guarded proxies to the localhost host helper ----

async fn vps_status(State(st): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !bearer_ok(&headers, &st.bearer) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    proxy_get(&format!("{}/status", st.vps_helper)).await
}

async fn vps_action(State(st): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    if !bearer_ok(&headers, &st.bearer) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let client = reqwest::Client::new();
    match client.post(format!("{}/action", st.vps_helper)).header("content-type", "application/json").body(body).send().await {
        Ok(r) => {
            let code = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (code, r.text().await.unwrap_or_default()).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

#[derive(Deserialize)]
struct LogsQuery {
    name: String,
    tail: Option<u32>,
}

async fn vps_logs(State(st): State<Arc<AppState>>, headers: HeaderMap, axum::extract::Query(q): axum::extract::Query<LogsQuery>) -> impl IntoResponse {
    if !bearer_ok(&headers, &st.bearer) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let tail = q.tail.unwrap_or(200);
    proxy_get(&format!("{}/logs?name={}&tail={}", st.vps_helper, urlencode(&q.name), tail)).await
}

async fn proxy_get(url: &str) -> axum::response::Response {
    match reqwest::get(url).await {
        Ok(r) => {
            let code = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (code, r.text().await.unwrap_or_default()).into_response()
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// Minimal percent-encode for the container name in the logs query (alnum + . _ - pass through).
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

// Constant-time compare — one static token, so a hand-rolled fold is enough (no subtle crate).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
