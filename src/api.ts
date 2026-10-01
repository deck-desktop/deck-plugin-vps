// The VPS plugin's settings, and the three calls it makes against them.
//
// At module scope rather than in a component, for the reason Deck's CLAUDE.md gives: the footer
// readout, the panel and the settings form are separate components that must agree on the same
// URL and token, and they are never all mounted at once. A shared store keeps them in step.
//
// Requests go through Deck's `httpSend` (Rust/reqwest) rather than the webview's fetch. The
// backend does send CORS headers, so fetch would work today — but it would break the moment the
// backend is reached through something that does not, and httpSend brings the size cap and
// timeout that http.rs already implements.
import { configRead, configWrite, httpSend } from "../shim/bridge.js";

const CFG = "plugin-vps";

export interface VpsSettings {
  /** The backend's base URL, e.g. https://deck.example.com. "" means not configured. */
  url: string;
  /** The BEARER_TOKEN install.sh printed. */
  token: string;
}

export const DEFAULTS: VpsSettings = { url: "", token: "" };

let settings: VpsSettings = { ...DEFAULTS };
let loaded = false;

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((f) => f()); };

export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getVersion = () => version;
export const get = () => settings;
/** Is there enough to make a call? Both halves are needed — the token alone reaches nothing. */
export const configured = () => Boolean(settings.url && settings.token);

/** Read the stored settings once. Safe to call from every component that needs them. */
export async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const t = await configRead(CFG);
    if (t.trim()) {
      // Field by field rather than a blind spread: a hand-edited file should not be able to put
      // a number where a string belongs and fail somewhere far from the cause.
      const raw = JSON.parse(t) as Partial<VpsSettings>;
      settings = {
        url: typeof raw.url === "string" ? raw.url : DEFAULTS.url,
        token: typeof raw.token === "string" ? raw.token : DEFAULTS.token,
      };
    }
  } catch { /* a corrupt file is not worth failing the readout for */ }
  emit();
}

export async function update(patch: Partial<VpsSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  emit();
  await configWrite(CFG, JSON.stringify(settings, null, 2)).catch(() => {});
}

/**
 * The hostname and stack name the deploy commands should use, from whatever is in the URL box.
 *
 * Both are derived rather than asked for a second time: the host is the URL without its scheme
 * or path, and the instance is its first label when that label already names an instance
 * ("deck-dev.example.com" installs the deck-dev stack). Everything else installs "deck", which
 * is install.sh's own default.
 *
 * Falls back to the placeholder host when the box is empty, so the commands read as an example
 * rather than as something broken.
 */
export function deployTarget(url: string): { host: string; instance: string } {
  const host = url.trim()
    .replace(/^[a-z]+:\/\//i, "")   // scheme
    .replace(/\/.*$/, "")           // path
    .replace(/:\d+$/, "")           // port — not part of a hostname for Caddy's purposes
    .toLowerCase();
  if (!host) return { host: "deck.example.com", instance: "deck" };
  // Only the first label, and only when it is deck-something: a host like "vps.example.com"
  // says nothing about which stack to install, and guessing "vps" there would be wrong.
  const first = host.split(".")[0];
  return { host, instance: /^deck-[a-z0-9-]+$/.test(first) ? first : "deck" };
}

// ---- the backend ------------------------------------------------------------------------

export interface VpsHost {
  nproc: number; cpu_pct?: number; load: number[]; mem_total_used: number[];
  disk_total_used_mb: number[]; uptime: string; net_rx_tx: number[];
}
export interface VpsContainer { name: string; state: string; status: string; cpu: string; mem: string; }
export interface VpsStatus { host: VpsHost; containers: VpsContainer[]; }

/** One call to the backend. Throws with the status line on anything but 2xx. */
async function call(
  method: string, path: string, body?: string,
): Promise<string> {
  const { url, token } = settings;
  if (!url || !token) throw new Error("not configured — set the URL and token in Settings");
  const headers: [string, string][] = [["Authorization", `Bearer ${token}`]];
  if (body) headers.push(["Content-Type", "application/json"]);
  const r = await httpSend({ method, url: `${url.replace(/\/$/, "")}${path}`, headers, body });
  // 401 is worth naming: it is what a stale token looks like, and "status 401" alone sends
  // people to the network rather than to the box they need to re-paste.
  if (r.status === 401) throw new Error("401 — the token does not match the backend's");
  if (r.status < 200 || r.status >= 300) throw new Error(`status ${r.status}`);
  return r.body;
}

/** Host stats + the container list, as raw JSON (the caller parses and caches it). */
export const vpsStatus = () => call("GET", "/status");

export const vpsAction = (name: string, action: "start" | "stop" | "restart") =>
  call("POST", "/action", JSON.stringify({ name, action })).then(() => undefined);

export const vpsLogs = (name: string) =>
  call("GET", `/logs?name=${encodeURIComponent(name)}&tail=200`).catch((e) => String(e));
