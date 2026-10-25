// The Servers panel — host stats and container control, for the VPS and the homelab.
//
// Moved out of src/modules/vps/ when the VPS became a plugin. The homelab came later and is read
// over SSH rather than through the VPS's backend, so the panel takes a `Source`: the same stats
// and container list either way, plus the power and Wi-Fi cards only the homelab reports.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Server, Cpu, MemoryStick, HardDrive, Clock, Plug, BatteryLow, Wifi,
  Play, Square, RotateCw, FileText, X, Loader2,
} from "lucide-react";
import { ConfirmDialog, type ConfirmState } from "../shim/ui.js";
import { configured, get, vpsStatus, vpsAction, vpsLogs, type HostStatus, type VpsContainer } from "./api";
import { homelabStatus, homelabAction, homelabLogs } from "./homelab";

const POLL_MS = 5000;

export type SourceId = "vps" | "homelab";

/** Where a panel's numbers come from and where its actions go. */
interface Source {
  id: SourceId;
  label: string;
  /** Finishes "… runs on {where}." in the stop and restart confirmation. */
  where: string;
  status: () => Promise<HostStatus>;
  action: (name: string, action: "start" | "stop" | "restart") => Promise<void>;
  logs: (name: string) => Promise<string>;
}

const SOURCES: Record<SourceId, Source> = {
  vps: { id: "vps", label: "VPS", where: "the production VPS", status: vpsStatus, action: vpsAction, logs: vpsLogs },
  homelab: { id: "homelab", label: "Homelab", where: "the homelab", status: homelabStatus, action: homelabAction, logs: homelabLogs },
};

/**
 * The panel the overlay shows: one host at a time, with a switch between them once a homelab is
 * set. Keyed by host, so switching starts the other one's poll fresh rather than mixing the two.
 */
export default function ServersPanel({ initial }: { initial: SourceId }) {
  const hasHomelab = Boolean(get().homelab);
  const [id, setId] = useState<SourceId>(initial === "homelab" && hasHomelab ? "homelab" : "vps");
  const tabs = hasHomelab && (
    <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: "var(--bg-elev)" }}>
      {(["vps", "homelab"] as const).map((t) => (
        <button key={t} onClick={() => setId(t)}
          className={"h-6 rounded-md px-2.5 text-[12px] font-medium transition-colors " +
            (t === id ? "text-text-primary" : "text-text-muted hover:text-text-secondary")}
          style={t === id ? { background: "var(--bg-card)" } : undefined}>
          {SOURCES[t].label}
        </button>
      ))}
    </div>
  );
  return <HostPanel key={id} source={SOURCES[id]} tabs={tabs} />;
}

const GREEN = "rgb(var(--tone-green-400))";
const RED = "rgb(var(--tone-red-400))";
const AMBER = "rgb(var(--tone-amber-400))";

/** A state in its colour: Connected, Reconnecting. */
function Chip({ color, title, children }: { color: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className="shrink-0 rounded-full px-1.5 py-px text-[10.5px]"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
      {children}
    </span>
  );
}

// Bytes → human rate string.
const fmtRate = (bytesPerSec: number): string => {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
};
const gib = (mb: number) => (mb / 1024).toFixed(1);

function StatCard({ icon: Icon, label, value, sub, pct }: {
  icon: any; label: string; value: string; sub?: string; pct?: number;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle p-3.5" style={{ background: "var(--bg-card-glass)" }}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
        <Icon size={13} className="text-text-muted" /> {label}
      </div>
      <div className="text-xl font-semibold tabular-nums text-text-primary">{value}</div>
      {pct != null && (
        <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-elev)" }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(100, pct)}%`, background: pct > 85 ? RED : "var(--accent)" }} />
        </div>
      )}
      {sub && <div className="text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}

// Seed from the last-known status so the panel paints instantly instead of "Connecting…".
// "deck-vps-cache" for the VPS, the key it has always had.
const cacheKey = (id: SourceId) => `deck-${id}-cache`;
function cachedStatus(id: SourceId): HostStatus | null {
  try { const t = localStorage.getItem(cacheKey(id)); return t ? JSON.parse(t) : null; } catch { return null; }
}

/** Signal strength in words, by the usual dBm bands. */
const signal = (dbm: number) => dbm >= -60 ? "good" : dbm >= -70 ? "fair" : "weak";

function HostPanel({ source, tabs }: { source: Source; tabs: React.ReactNode }) {
  const [s, setS] = useState<HostStatus | null>(() => cachedStatus(source.id));
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ name: string; action: "stop" | "restart" } | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logsText, setLogsText] = useState("");
  // Net rate: remember last counters + time to compute delta.
  const prevNet = useRef<{ rx: number; tx: number; t: number } | null>(null);
  const [rate, setRate] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const [next, setNext] = useState(POLL_MS / 1000); // seconds until the next poll (UI countdown)

  const poll = async () => {
    try {
      const data = await source.status();
      setS(data); setErr(""); setNext(POLL_MS / 1000);
      try { localStorage.setItem(cacheKey(source.id), JSON.stringify(data)); } catch { /* */ }
      const [rx, tx] = data.host.net_rx_tx;
      const now = Date.now();
      if (prevNet.current) {
        const dt = (now - prevNet.current.t) / 1000;
        if (dt > 0) setRate({ rx: Math.max(0, (rx - prevNet.current.rx) / dt), tx: Math.max(0, (tx - prevNet.current.tx) / dt) });
      }
      prevNet.current = { rx, tx, t: now };
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    poll();
    let id = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    // 1s countdown to the next poll (floors at 0; poll() resets it to POLL_MS/1000).
    const tick = setInterval(() => setNext((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => { clearInterval(id); clearInterval(tick); document.removeEventListener("visibilitychange", onVis); };
    /* eslint-disable-next-line */
  }, []);

  const doAction = async (name: string, action: "start" | "stop" | "restart") => {
    setBusy((b) => ({ ...b, [name]: true }));
    try { await source.action(name, action); await poll(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy((b) => ({ ...b, [name]: false })); setConfirm(null); }
  };
  const onAction = (name: string, action: "start" | "stop" | "restart") => {
    if (action === "start") doAction(name, action);
    else setConfirm({ name, action });
  };

  const openLogs = async (name: string) => {
    setLogsFor(name); setLogsText("");
    try { setLogsText(await source.logs(name)); } catch (e) { setLogsText(String(e)); }
  };

  const host = s?.host;
  const memPct = host ? (host.mem_total_used[1] / host.mem_total_used[0]) * 100 : 0;
  const diskPct = host ? (host.disk_total_used_mb[1] / host.disk_total_used_mb[0]) * 100 : 0;
  // Real CPU utilization from the helper (double /proc/stat sample). Fall back to load/nproc
  // only if an older helper response lacks cpu_pct (load is NOT utilization — it overshoots).
  const cpuPct = host ? (host.cpu_pct ?? Math.min(100, (host.load[0] / host.nproc) * 100)) : 0;

  // Built once per question, not per render: the panel re-renders every second for the countdown,
  // and a fresh state object each time would re-run the dialog's focus effect with it.
  const confirmState = useMemo<ConfirmState | null>(() => confirm && {
    title: `${confirm.action === "stop" ? "Stop" : "Restart"} ${confirm.name}?`,
    body: (
      <>
        <span className="font-mono text-text-primary">{confirm.name}</span> runs on {source.where}.
        {confirm.name === "caddy" && " This is the reverse proxy — every site goes down."}
      </>
    ),
    confirmLabel: confirm.action === "stop" ? "Stop" : "Restart",
    onConfirm: () => void doAction(confirm.name, confirm.action),
    /* eslint-disable-next-line */
  }, [confirm]);

  // Nothing to poll without a backend. Said here rather than left as a failing request, because
  // "status 0" in the corner is not an instruction and this is the one state a fresh install
  // is guaranteed to be in.
  if (source.id === "vps" && !configured()) {
    return (
      <div className="grid h-full w-full place-items-center p-8">
        <div className="flex max-w-md items-start gap-3 rounded-lg border border-subtle px-4 py-4"
          style={{ background: "var(--bg-elev)" }}>
          <Server size={16} className="mt-0.5 shrink-0 text-text-muted" />
          <div className="space-y-2">
            <h2 className="text-[13px] font-medium text-text-primary">No backend configured</h2>
            <p className="text-[12px] leading-relaxed text-text-muted">
              This panel reads a small service on your own VPS. Settings &gt; Plugins &gt; VPS has the
              URL and token boxes, and the deploy steps for standing one up.
            </p>
            <button onClick={() => window.dispatchEvent(new CustomEvent("deck-navigate", { detail: "plugin-settings:vps" }))}
              className="h-8 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110"
              style={{ background: "var(--accent)" }}>
              Open VPS settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // No max-width: this fills whatever it is given. It is rendered inside the VPS modal, which
    // already sets the width it should occupy — capping again here left the extra space as empty
    // margin on a wide window.
    <div className="mx-auto flex h-full w-full flex-col overflow-hidden">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Server size={16} className="text-text-muted" />
          <h1 className="text-[15px] font-semibold text-text-primary">{tabs ? "Servers" : source.label}</h1>
          {tabs}
          {err ? <Chip color={AMBER} title={err}>Reconnecting…</Chip>
               : s && <Chip color={GREEN}>Connected</Chip>}
          {!err && s && <span className="text-[11.5px] tabular-nums text-text-muted" title="next refresh">refresh {next}s</span>}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {/* Host stats */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard icon={Cpu} label="CPU" value={host ? `${cpuPct.toFixed(0)}%` : "—"}
            pct={cpuPct} sub={host ? `load ${host.load.join(" / ")} · ${host.nproc} cores` : undefined} />
          <StatCard icon={MemoryStick} label="Memory" value={host ? `${memPct.toFixed(0)}%` : "—"}
            pct={memPct} sub={host ? `${gib(host.mem_total_used[1])} / ${gib(host.mem_total_used[0])} GiB` : undefined} />
          <StatCard icon={HardDrive} label="Disk /" value={host ? `${diskPct.toFixed(0)}%` : "—"}
            pct={diskPct} sub={host ? `${gib(host.disk_total_used_mb[1])} / ${gib(host.disk_total_used_mb[0])} GiB` : undefined} />
          <StatCard icon={Clock} label="Uptime" value={host?.uptime?.split(",")[0] ?? "—"}
            sub={host ? `↓ ${fmtRate(rate.rx)}  ↑ ${fmtRate(rate.tx)}` : undefined} />
        </div>

        {/* What only the homelab reports: it is a laptop on Wi-Fi. */}
        {s?.extra && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard icon={s.extra.ac === false ? BatteryLow : Plug} label="Power"
              value={s.extra.ac == null ? "—" : s.extra.ac ? "Mains" : "On battery"}
              sub={[
                s.extra.battery && `battery ${s.extra.battery.pct}% · ${s.extra.battery.state.toLowerCase()}`,
                s.extra.guard && `battery guard ${s.extra.guard}`,
              ].filter(Boolean).join(" · ")} />
            <StatCard icon={Wifi} label="Wi-Fi"
              value={s.extra.wifi ? `${s.extra.wifi.dbm} dBm` : "Not on Wi-Fi"}
              sub={s.extra.wifi ? `${s.extra.wifi.iface} · ${signal(s.extra.wifi.dbm)} signal` : undefined} />
          </div>
        )}

        {/* Containers */}
        <div className="rounded-lg border border-subtle p-1.5" style={{ background: "var(--bg-card-glass)" }}>
          <div className="flex h-7 items-center gap-1.5 px-2">
            <span className="text-[12px] font-medium text-text-secondary">Containers</span>
            {s && (
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10.5px] text-text-secondary"
                style={{ background: "var(--bg-elev)" }}>{s.containers.length}</span>
            )}
          </div>
          {!s && !err && <div className="flex items-center gap-2 px-2 py-6 text-[12.5px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Connecting to {source.label}…</div>}
          {s?.containers.length === 0 && <div className="px-2 py-3 text-[12.5px] text-text-muted">No containers</div>}
          <div className="space-y-px">
            {s?.containers.map((c) => <ContainerRow key={c.name} c={c} busy={!!busy[c.name]}
              onAction={onAction} onLogs={openLogs} />)}
          </div>
        </div>
      </div>

      {/* Confirm dialog for stop/restart (production actions) */}
      <ConfirmDialog state={confirmState} onClose={() => setConfirm(null)} />

      {/* Logs slide-over */}
      <AnimatePresence>
        {logsFor && (
          <motion.div className="fixed inset-0 z-50 flex justify-end bg-black/40"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setLogsFor(null)}>
            <motion.div className="flex h-full w-[560px] flex-col overflow-hidden border-l border-subtle p-4 shadow-2xl"
              style={{ background: "var(--bg-card)" }}
              initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }} onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
                <h3 className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-mono text-[12.5px] font-medium text-text-primary">{logsFor}</span>
                  <span className="shrink-0 text-[11.5px] text-text-muted">Logs</span>
                </h3>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button onClick={() => openLogs(logsFor)} className={toolBtn} title="Refresh"><RotateCw size={14} /></button>
                  <button onClick={() => setLogsFor(null)} className={toolBtn} title="Close"><X size={15} /></button>
                </div>
              </div>
              <pre className="scroll-thin min-h-0 flex-1 overflow-auto rounded-lg border border-subtle p-3 font-mono text-[11px] leading-relaxed text-text-secondary" style={{ background: "var(--bg-app)" }}>
                {logsText || "Loading…"}
              </pre>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const toolBtn = "grid size-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary";

function ContainerRow({ c, busy, onAction, onLogs }: {
  c: VpsContainer; busy: boolean;
  onAction: (name: string, action: "start" | "stop" | "restart") => void;
  onLogs: (name: string) => void;
}) {
  const running = c.state === "running";
  return (
    <div className="group flex h-8 items-center gap-3 rounded-md px-2 text-[12.5px] transition-colors hover:bg-white/5">
      <span className="size-2 shrink-0 rounded-full" style={{ background: running ? GREEN : "var(--text-muted)" }} title={c.status} />
      <span className="w-40 shrink-0 truncate font-mono text-text-primary">{c.name}</span>
      <span className="hidden flex-1 truncate text-[11.5px] text-text-muted sm:block">{c.status}</span>
      <span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-text-secondary">{running ? c.cpu : "—"}</span>
      <span className="hidden w-32 shrink-0 truncate text-right font-mono text-[11.5px] tabular-nums text-text-muted md:block">{running ? c.mem : ""}</span>
      {/* Hidden until hovered, but still taking their room, so the columns do not shift. */}
      <div className={"flex w-[76px] shrink-0 items-center justify-end gap-0.5 transition-opacity " +
        (busy ? "" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100")}>
        {busy ? <Loader2 size={14} className="mx-1.5 animate-spin text-text-muted" /> : running ? (
          <>
            <IconBtn title="Stop" danger onClick={() => onAction(c.name, "stop")}><Square size={12} /></IconBtn>
            <IconBtn title="Restart" onClick={() => onAction(c.name, "restart")}><RotateCw size={12} /></IconBtn>
          </>
        ) : (
          <IconBtn title="Start" onClick={() => onAction(c.name, "start")}><Play size={12} /></IconBtn>
        )}
        <IconBtn title="Logs" onClick={() => onLogs(c.name)}><FileText size={12} /></IconBtn>
      </div>
    </div>
  );
}

const IconBtn = ({ children, title, onClick, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; danger?: boolean;
}) => (
  <button title={title} onClick={onClick}
    className={"grid size-6 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 " +
      (danger ? "hover:text-red-400" : "hover:text-text-primary")}>
    {children}
  </button>
);
