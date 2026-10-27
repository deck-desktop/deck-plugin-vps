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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// Rolling CPU % (×100, fixed-point in an atomic so /status reads are lock-free). u64::MAX = "no
// reading yet". A background thread samples /proc/stat every 2s and keeps a trailing average
// over the last SMOOTH_N samples, so every client sees the SAME smoothed number no matter when
// it polls — kills both the jitter and the desktop-vs-mobile disagreement.
static CPU_X100: AtomicU64 = AtomicU64::new(u64::MAX);
const SMOOTH_N: usize = 5; // ~10s window at 2s cadence

// (total, idle) jiffies from /proc/stat line 1. None if unreadable.
fn proc_stat() -> Option<(u64, u64)> {
    let s = std::fs::read_to_string("/proc/stat").ok()?;
    let line = s.lines().next()?; // "cpu  user nice system idle iowait irq softirq steal ..."
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    let idle = v[3]; // 4th field = idle
    let total: u64 = v.iter().sum();
    Some((total, idle))
}

// Background sampler: delta busy/total each tick, trailing mean over SMOOTH_N ticks.
fn spawn_cpu_sampler() {
    std::thread::spawn(|| {
        let mut prev = proc_stat();
        let mut window: Vec<f64> = Vec::with_capacity(SMOOTH_N);
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let cur = proc_stat();
            if let (Some((t0, i0)), Some((t1, i1))) = (prev, cur) {
                let dt = t1.saturating_sub(t0) as f64;
                let di = i1.saturating_sub(i0) as f64;
                if dt > 0.0 {
                    let pct = (100.0 * (dt - di) / dt).clamp(0.0, 100.0);
                    if window.len() == SMOOTH_N {
                        window.remove(0);
                    }
                    window.push(pct);
                    let avg = window.iter().sum::<f64>() / window.len() as f64;
                    CPU_X100.store((avg * 100.0) as u64, Ordering::Relaxed);
                }
            }
            prev = cur;
        }
    });
}

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
// CPU % is NOT here — a background thread computes a rolling average from /proc/stat and the
// status handler injects it (see cpu_avg). An inline 0.3s sample was too twitchy and made two
// clients polling at different instants disagree wildly (14% vs 2%).
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
    spawn_cpu_sampler(); // start the rolling CPU average
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/status", get(status))
        .route("/action", post(action))
        .route("/logs", get(logs))
        .route("/access", get(access));
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
    let mut host: Value = serde_json::from_str(host_json).unwrap_or(json!({}));
    // Inject the rolling CPU average (omit until the sampler has a first reading).
    let raw = CPU_X100.load(Ordering::Relaxed);
    if raw != u64::MAX {
        host["cpu_pct"] = json!((raw as f64 / 100.0 * 10.0).round() / 10.0); // 1 decimal
    }
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

// ---- Caddy access log: per-site counts and recent errors over the last 24h ----
//
// The log lives in Caddy's `caddy_logs` volume as root:600, so it is read through the container
// rather than from the volume's mountpoint. Only the current file is read, not the rotated .gz
// ones.
// ponytail: current file only. Right after a roll it covers less than 24h; `since` says how far
// back the numbers actually go. Read the newest .gz too if that window turns out to matter.
async fn access() -> impl IntoResponse {
    match sh("docker exec caddy cat /var/log/caddy/access.log") {
        Ok(log) => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
            Json(summarize_access(&log, now)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

const ACCESS_WINDOW_SECS: f64 = 24.0 * 3600.0;
const ACCESS_MAX_ERRORS: usize = 100;

/// Per-site request and error counts, plus the newest error requests, for the 24h before `now`.
///
/// Requests carrying an Authorization header are left out: that is Deck itself polling the
/// backend every few seconds, and counting it would drown every real visitor.
fn summarize_access(log: &str, now: f64) -> Value {
    let cutoff = now - ACCESS_WINDOW_SECS;
    let mut first_ts: Option<f64> = None;
    // host -> (total, 4xx, 5xx); a BTreeMap so the sites come back in a stable order.
    let mut sites: std::collections::BTreeMap<String, (u64, u64, u64)> = Default::default();
    let mut errors: Vec<Value> = Vec::new();
    for line in log.lines() {
        // The last line can be mid-write; anything that is not a whole JSON object is skipped.
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(ts) = v["ts"].as_f64() else { continue };
        first_ts.get_or_insert(ts);
        if ts < cutoff {
            continue;
        }
        let req = &v["request"];
        if !req["headers"]["Authorization"].is_null() {
            continue;
        }
        let host = req["host"].as_str().unwrap_or("").to_string();
        let status = v["status"].as_u64().unwrap_or(0);
        let e = sites.entry(host.clone()).or_default();
        e.0 += 1;
        if (400..500).contains(&status) {
            e.1 += 1;
        } else if status >= 500 {
            e.2 += 1;
        }
        if status >= 400 {
            errors.push(json!({
                "ts": ts, "host": host, "status": status,
                "method": req["method"], "uri": req["uri"], "ip": req["client_ip"],
                "ms": (v["duration"].as_f64().unwrap_or(0.0) * 1000.0).round(),
            }));
        }
    }
    // The log is oldest-first; the newest errors are the ones worth showing.
    let errors: Vec<Value> = errors.into_iter().rev().take(ACCESS_MAX_ERRORS).collect();
    let sites: Vec<Value> = sites.into_iter().map(|(host, (total, s4xx, s5xx))| json!({ "host": host, "total": total, "s4xx": s4xx, "s5xx": s5xx })).collect();
    json!({ "since": first_ts.map_or(cutoff, |f| f.max(cutoff)), "sites": sites, "errors": errors })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: f64, host: &str, status: u64, auth: bool) -> String {
        let headers = if auth { json!({ "Authorization": ["REDACTED"] }) } else { json!({}) };
        json!({ "ts": ts, "status": status, "duration": 0.0123,
                "request": { "host": host, "method": "GET", "uri": "/x", "client_ip": "1.2.3.4", "headers": headers } })
        .to_string()
    }

    #[test]
    fn counts_sites_and_errors_in_the_window_without_deck_polling() {
        let now = 100_000.0;
        let log = [
            line(now - ACCESS_WINDOW_SECS - 10.0, "a.com", 500, false), // before the window
            line(now - 50.0, "a.com", 200, false),
            line(now - 40.0, "a.com", 404, false),
            line(now - 30.0, "status.com", 200, true), // Deck's own poll
            line(now - 20.0, "b.com", 502, false),
            "{\"ts\": 99999".to_string(), // a half-written last line
        ]
        .join("\n");
        let out = summarize_access(&log, now);

        assert_eq!(out["since"], json!(now - ACCESS_WINDOW_SECS));
        assert_eq!(out["sites"], json!([
            { "host": "a.com", "total": 2, "s4xx": 1, "s5xx": 0 },
            { "host": "b.com", "total": 1, "s4xx": 0, "s5xx": 1 },
        ]));
        let errors = out["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0]["status"], 502); // newest first
        assert_eq!(errors[0]["ms"], 12.0);
        assert_eq!(errors[1]["status"], 404);
    }

    #[test]
    fn since_is_the_first_line_when_the_log_is_younger_than_the_window() {
        let now = 100_000.0;
        let out = summarize_access(&line(now - 60.0, "a.com", 200, false), now);
        assert_eq!(out["since"], json!(now - 60.0));
    }
}
