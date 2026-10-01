// The VPS panel — host stats and container control.
//
// Moved out of src/modules/vps/ when the VPS became a plugin; the body is unchanged apart from
// its imports and the not-configured state below, which the module never needed because the
// backend URL lived in Deck's own settings and the tab was hidden without one.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Server, Cpu, MemoryStick, HardDrive, Clock,
  Play, Square, RotateCw, FileText, X, Loader2, AlertTriangle,
} from "lucide-react";
import { configured, vpsStatus, vpsAction, vpsLogs, type VpsStatus, type VpsContainer } from "./api";

const POLL_MS = 5000;

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
    <div className="flex flex-col gap-2 rounded-xl border border-subtle p-4" style={{ background: "var(--bg-card-glass)" }}>
      <div className="flex items-center gap-2 text-[12px] font-medium text-text-muted">
        <Icon size={13} /> {label}
      </div>
      <div className="text-xl font-bold text-text-primary">{value}</div>
      {pct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-elev)" }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(100, pct)}%`, background: pct > 85 ? "var(--danger)" : "var(--accent)" }} />
        </div>
      )}
      {sub && <div className="text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}

// Seed from the last-known status so the panel paints instantly instead of "Connecting…".
function cachedStatus(): VpsStatus | null {
  try { const t = localStorage.getItem("deck-vps-cache"); return t ? JSON.parse(t) : null; } catch { return null; }
}

export default function VpsPanel() {
  const [s, setS] = useState<VpsStatus | null>(cachedStatus);
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
      const raw = await vpsStatus();
      const data: VpsStatus = JSON.parse(raw);
      setS(data); setErr(""); setNext(POLL_MS / 1000);
      try { localStorage.setItem("deck-vps-cache", raw); } catch { /* */ }
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
    try { await vpsAction(name, action); await poll(); }
    catch (e) { setErr(String(e)); }
    finally { setBusy((b) => ({ ...b, [name]: false })); setConfirm(null); }
  };
  const onAction = (name: string, action: "start" | "stop" | "restart") => {
    if (action === "start") doAction(name, action);
    else setConfirm({ name, action });
  };

  const openLogs = async (name: string) => {
    setLogsFor(name); setLogsText("");
    try { setLogsText(await vpsLogs(name)); } catch (e) { setLogsText(String(e)); }
  };

  const host = s?.host;
  const memPct = host ? (host.mem_total_used[1] / host.mem_total_used[0]) * 100 : 0;
  const diskPct = host ? (host.disk_total_used_mb[1] / host.disk_total_used_mb[0]) * 100 : 0;
  // Real CPU utilization from the helper (double /proc/stat sample). Fall back to load/nproc
  // only if an older helper response lacks cpu_pct (load is NOT utilization — it overshoots).
  const cpuPct = host ? (host.cpu_pct ?? Math.min(100, (host.load[0] / host.nproc) * 100)) : 0;

  // Nothing to poll without a backend. Said here rather than left as a failing request, because
  // "status 0" in the corner is not an instruction and this is the one state a fresh install
  // is guaranteed to be in.
  if (!configured()) {
    return (
      <div className="grid h-full w-full place-items-center p-8 text-center">
        <div className="max-w-md space-y-2">
          <Server size={28} className="mx-auto text-text-muted" />
          <h2 className="text-lg font-semibold text-text-primary">No backend configured</h2>
          <p className="text-sm text-text-secondary">
            This panel reads a small service on your own VPS. Settings &gt; Plugins &gt; VPS has the
            URL and token boxes, and the deploy steps for standing one up.
          </p>
        </div>
      </div>
    );
  }

  return (
    // No max-width: this fills whatever it is given. It is rendered inside the VPS modal, which
    // already sets the width it should occupy — capping again here left the extra space as empty
    // margin on a wide window.
    <div className="mx-auto flex h-full w-full flex-col overflow-hidden">
      <div className="mb-5 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <Server size={20} className="text-text-secondary" />
          <h1 className="text-2xl font-bold text-text-primary">VPS</h1>
          {err ? <span className="ml-2 flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} /> reconnecting…</span>
               : s && <span className="ml-2 h-2 w-2 rounded-full" style={{ background: "var(--ok)" }} title="connected" />}
          {!err && s && <span className="ml-1 text-xs tabular-nums text-text-muted" title="next refresh">refresh {next}s</span>}
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

        {/* Containers */}
        <div className="rounded-xl border border-subtle p-2" style={{ background: "var(--bg-card-glass)" }}>
          <div className="px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
            Containers {s && `(${s.containers.length})`}
          </div>
          {!s && !err && <div className="flex items-center gap-2 px-3 py-6 text-sm text-text-muted"><Loader2 size={15} className="animate-spin" /> Connecting to VPS…</div>}
          <div className="space-y-1">
            {s?.containers.map((c) => <ContainerRow key={c.name} c={c} busy={!!busy[c.name]}
              onAction={onAction} onLogs={openLogs} />)}
          </div>
        </div>
      </div>

      {/* Confirm dialog for stop/restart (production actions) */}
      <AnimatePresence>
        {confirm && (
          <motion.div className="fixed inset-0 z-50 grid place-items-center bg-black/50"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirm(null)}>
            <motion.div className="w-[360px] rounded-xl border border-strong p-5 shadow-card"
              style={{ background: "var(--bg-card)" }} initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}>
              <div className="mb-2 flex items-center gap-2 text-danger"><AlertTriangle size={18} /><span className="font-semibold">{confirm.action === "stop" ? "Stop" : "Restart"} container?</span></div>
              <p className="mb-4 text-sm text-text-secondary">
                <span className="font-mono text-text-primary">{confirm.name}</span> runs on the production VPS.
                {confirm.name === "caddy" && " This is the reverse proxy — every site goes down."}
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirm(null)} className="rounded-md border border-subtle bg-elev px-3 py-2 text-sm text-text-secondary transition hover:text-text-primary">Cancel</button>
                <button onClick={() => doAction(confirm.name, confirm.action)}
                  className="rounded-md px-3 py-2 text-sm font-semibold text-white" style={{ background: "var(--danger)" }}>
                  {confirm.action === "stop" ? "Stop" : "Restart"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logs slide-over */}
      <AnimatePresence>
        {logsFor && (
          <motion.div className="fixed inset-0 z-50 flex justify-end bg-black/40"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setLogsFor(null)}>
            <motion.div className="glass h-full w-[560px] overflow-hidden p-6"
              initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }} onClick={(e) => e.stopPropagation()}>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-mono text-sm font-semibold text-text-primary">{logsFor} · logs</h3>
                <div className="flex items-center gap-1">
                  <button onClick={() => openLogs(logsFor)} className="rounded-md p-1.5 text-text-muted transition hover:bg-elev hover:text-text-primary" title="Refresh"><RotateCw size={15} /></button>
                  <button onClick={() => setLogsFor(null)} className="rounded-md p-1.5 text-text-muted transition hover:bg-elev hover:text-text-primary"><X size={16} /></button>
                </div>
              </div>
              <pre className="scroll-thin h-[calc(100%-3rem)] overflow-auto rounded-lg p-3 text-[11px] leading-relaxed text-text-secondary" style={{ background: "var(--bg-elev)", fontFamily: "var(--font-mono)" }}>
                {logsText || "Loading…"}
              </pre>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ContainerRow({ c, busy, onAction, onLogs }: {
  c: VpsContainer; busy: boolean;
  onAction: (name: string, action: "start" | "stop" | "restart") => void;
  onLogs: (name: string) => void;
}) {
  const running = c.state === "running";
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.02]">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: running ? "var(--ok)" : "var(--slate-400)" }} title={c.status} />
      <span className="w-40 shrink-0 truncate font-mono text-sm text-text-primary">{c.name}</span>
      <span className="hidden flex-1 truncate text-xs text-text-muted sm:block">{c.status}</span>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-text-secondary">{running ? c.cpu : "—"}</span>
      <span className="hidden w-32 shrink-0 truncate text-right font-mono text-xs tabular-nums text-text-muted md:block">{running ? c.mem : ""}</span>
      <div className="flex shrink-0 items-center gap-1">
        {busy ? <Loader2 size={15} className="mx-2 animate-spin text-text-muted" /> : running ? (
          <>
            <IconBtn title="Stop" danger onClick={() => onAction(c.name, "stop")}><Square size={13} /></IconBtn>
            <IconBtn title="Restart" onClick={() => onAction(c.name, "restart")}><RotateCw size={13} /></IconBtn>
          </>
        ) : (
          <IconBtn title="Start" onClick={() => onAction(c.name, "start")}><Play size={13} /></IconBtn>
        )}
        <IconBtn title="Logs" onClick={() => onLogs(c.name)}><FileText size={13} /></IconBtn>
      </div>
    </div>
  );
}

const IconBtn = ({ children, title, onClick, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; danger?: boolean;
}) => (
  <button title={title} onClick={onClick}
    className={"grid h-7 w-7 place-items-center rounded-md text-text-muted transition hover:bg-elev " +
      (danger ? "hover:text-danger" : "hover:text-text-primary")}>
    {children}
  </button>
);
