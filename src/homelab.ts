// The homelab: a machine on the home network, read over SSH rather than through a backend.
//
// Nothing is installed on it. Each poll is one `ssh <host> <PROBE>` through Deck's `exec`, which
// prints `key=value` lines that `parseProbe` turns into the same shape the VPS backend returns,
// plus what only a laptop has (mains, battery, Wi-Fi signal). It needs key-based login, since
// BatchMode refuses to prompt; the host is an alias from ~/.ssh/config, set in Settings.
import { exec } from "../shim/bridge.js";
import { notify, dismissNotification } from "../shim/ui.js";
import { get, type HostStatus, type VpsContainer } from "./api";

const SOURCE = "Homelab";

// POSIX sh, run by the remote login shell. Kept free of double quotes: it travels as one
// command-line argument to ssh.exe, and single quotes are the only quoting it needs.
// CPU is two /proc/stat samples 0.3s apart (user nice system idle iowait irq softirq steal).
export const PROBE = [
  "read -r _ a b c d e f g h _ < /proc/stat; sleep 0.3; read -r _ A B C D E F G H _ < /proc/stat",
  "busy=$((A+B+C+F+G+H-a-b-c-f-g-h)); idle=$((D+E-d-e)); echo cpu=$((100*busy/(busy+idle+1)))",
  "echo nproc=$(nproc)",
  "echo load=$(cut -d' ' -f1-3 /proc/loadavg)",
  "echo mem=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print int(t/1024), int((t-a)/1024)}' /proc/meminfo)",
  "echo disk=$(df -Pk / | awk 'NR==2{print int($2/1024), int($3/1024)}')",
  "echo uptime=$(uptime -p)",
  "i=$(ip route show default | awk '{print $5; exit}')",
  "if [ ${#i} -gt 0 ]; then echo net=$(cat /sys/class/net/$i/statistics/rx_bytes) $(cat /sys/class/net/$i/statistics/tx_bytes); fi",
  // "wlp13s0: 0000   56.  -54.  -256 …": the interface and the signal level, colon and dots cut.
  "echo wifi=$(awk 'NR>2{print $1, $4; exit}' /proc/net/wireless | tr -d :.)",
  "for p in /sys/class/power_supply/*; do case $(cat $p/type) in Mains) echo ac=$(cat $p/online);; Battery) echo battery=$(cat $p/capacity) $(cat $p/status);; esac; done",
  "echo guard=$(systemctl is-active battery-guard.timer)",
  "docker ps -a --format 'c={{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null",
  "true",
].join("\n");

/** The probe's output as a status. Lines it does not know are skipped, so it reads an older probe. */
export function parseProbe(text: string): HostStatus {
  const s: HostStatus = {
    host: { nproc: 0, load: [], mem_total_used: [0, 0], disk_total_used_mb: [0, 0], uptime: "", net_rx_tx: [0, 0] },
    containers: [],
    extra: { ac: null, battery: null, guard: "", wifi: null },
  };
  const x = s.extra!;
  const nums = (v: string) => v.trim().split(/\s+/).map(Number);
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq), v = line.slice(eq + 1).trim();
    switch (k) {
      case "cpu": s.host.cpu_pct = Number(v); break;
      case "nproc": s.host.nproc = Number(v); break;
      case "load": s.host.load = nums(v); break;
      case "mem": s.host.mem_total_used = nums(v); break;
      case "disk": s.host.disk_total_used_mb = nums(v); break;
      // "up 2 hours, 5 minutes", the same "up …" text the VPS backend sends.
      case "uptime": s.host.uptime = v.replace(/^up\s+/, ""); break;
      case "net": s.host.net_rx_tx = nums(v); break;
      // Empty when no interface is wireless.
      case "wifi": { const [iface, dbm] = v.split(/\s+/); if (iface && dbm) x.wifi = { iface, dbm: Number(dbm) }; break; }
      case "ac": x.ac = v === "1"; break;
      case "battery": { const [pct, ...state] = v.split(/\s+/); x.battery = { pct: Number(pct), state: state.join(" ") }; break; }
      case "guard": x.guard = v; break;
      case "c": {
        const [name, state, ...status] = v.split("|");
        s.containers.push({ name, state, status: status.join("|"), cpu: "—", mem: "" });
        break;
      }
    }
  }
  return s;
}

/** One command on the homelab. Throws with ssh's own message on a failure. */
async function ssh(command: string): Promise<string> {
  const host = get().homelab;
  if (!host) throw new Error("not configured — set the homelab's SSH host in Settings");
  const r = await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `ssh exited with ${r.code}`);
  return r.stdout;
}

export const homelabStatus = () => ssh(PROBE).then((out) => {
  const s = parseProbe(out);
  try { watchPower(s); } catch (e) { console.warn("[vps] homelab power watch failed", e); }
  return s;
});

// Mains on the last read; null until the first, which is the baseline. Memory only.
let mains: boolean | null = null;

/**
 * Losing mains is a notification, and getting it back takes it down. Fed by every status read:
 * the footer's minute poll in the background, the panel's poll while it is open.
 */
export function watchPower(s: HostStatus) {
  const ac = s.extra?.ac;
  if (ac == null) return;
  if (mains === true && !ac) {
    const b = s.extra?.battery;
    notify({ kind: "error", source: SOURCE, key: "power", title: "Homelab is on battery",
      body: b ? `Battery at ${b.pct}%` : "Mains power is off" });
  } else if (mains === false && ac) {
    dismissNotification(SOURCE, "power");
  }
  mains = ac;
}

// A container name goes into a shell command, so only docker's own name characters pass.
const safe = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`not a container name: ${name}`);
  return name;
};

export const homelabAction = (name: string, action: "start" | "stop" | "restart") =>
  ssh(`docker ${action} ${safe(name)}`).then(() => undefined);

export const homelabLogs = (name: string) =>
  ssh(`docker logs --tail 200 ${safe(name)} 2>&1`).catch((e) => String(e));

export type { VpsContainer };
