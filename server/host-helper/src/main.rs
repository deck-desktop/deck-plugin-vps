// deck-host-helper — runs on the VPS HOST (systemd --user), bound to 0.0.0.0:8899 so the
// backend CONTAINER can reach it via host.docker.internal (the docker bridge gateway); a
// 127.0.0.1 bind wouldn't answer the gateway IP. Port 8899 is never published publicly (no
// Caddy route, no firewall opening) — only the docker bridge + host localhost reach it, and
// the only caller is the backend. So no auth here.
//
// Mirrors the desktop's src-tauri/src/vps.rs logic, but runs docker/stat commands LOCALLY
// instead of over ssh.

use std::collections::HashMap;
use std::process::Command;

use axum::{
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

// Same status bash the desktop runs over ssh (vps.rs). Emits a host-json line, then the
// container ps + stats blocks separated by markers.
const STATUS_SCRIPT: &str = r#"
read l1 l5 l15 _ < /proc/loadavg
mem=$(free -m | awk '/Mem:/{print $2","$3}')
disk=$(df -m / | awk 'NR==2{print $2","$3}')
up=$(uptime -p | sed 's/^up //')
iface=$(ip route | awk '/default/{print $5; exit}')
rx=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null||echo 0)
tx=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null||echo 0)
printf '{"nproc":%s,"load":[%s,%s,%s],"mem_total_used":[%s],"disk_total_used_mb":[%s],"uptime":"%s","net_rx_tx":[%s,%s]}\n' \
  "$(nproc)" "$l1" "$l5" "$l15" "$mem" "$disk" "$up" "$rx" "$tx"
echo '@@PS@@'
docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'
echo '@@STATS@@'
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
"#;

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/status", get(status))
        .route("/action", post(action))
        .route("/logs", get(logs));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8899").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn sh(cmd: &str) -> Result<String, String> {
    let out = Command::new("bash").arg("-c").arg(cmd).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// Container names: alnum plus . _ - (mirrors valid_name in vps.rs) — blocks shell injection.
fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 128 && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

async fn status() -> impl IntoResponse {
    let raw = match sh(STATUS_SCRIPT) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    };
    // Split host-json / ps / stats on the markers (same parse as vps.rs:57-85).
    let host_json = raw.lines().next().unwrap_or("{}");
    let ps_block = raw.split("@@PS@@").nth(1).unwrap_or("");
    let ps_block = ps_block.split("@@STATS@@").next().unwrap_or("");
    let stats_block = raw.split("@@STATS@@").nth(1).unwrap_or("");

    // name -> (cpu, mem)
    let mut stats: HashMap<&str, (&str, &str)> = HashMap::new();
    for line in stats_block.lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() >= 3 {
            stats.insert(p[0], (p[1], p[2]));
        }
    }
    let mut containers: Vec<Value> = Vec::new();
    for line in ps_block.lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() >= 3 {
            let (cpu, mem) = stats.get(p[0]).copied().unwrap_or(("-", "-"));
            containers.push(json!({ "name": p[0], "state": p[1], "status": p[2], "cpu": cpu, "mem": mem }));
        }
    }
    let host: Value = serde_json::from_str(host_json).unwrap_or(json!({}));
    Json(json!({ "host": host, "containers": containers })).into_response()
}

#[derive(Deserialize)]
struct ActionReq {
    name: String,
    action: String,
}

async fn action(Json(req): Json<ActionReq>) -> impl IntoResponse {
    if !valid_name(&req.name) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad name" }))).into_response();
    }
    if !matches!(req.action.as_str(), "start" | "stop" | "restart") {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad action" }))).into_response();
    }
    match sh(&format!("docker {} {}", req.action, req.name)) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

#[derive(Deserialize)]
struct LogsQuery {
    name: String,
    tail: Option<u32>,
}

async fn logs(Query(q): Query<LogsQuery>) -> impl IntoResponse {
    if !valid_name(&q.name) {
        return (StatusCode::BAD_REQUEST, "bad name").into_response();
    }
    let tail = q.tail.unwrap_or(200).min(2000);
    match sh(&format!("docker logs --tail {} {} 2>&1", tail, q.name)) {
        Ok(s) => (StatusCode::OK, s).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
