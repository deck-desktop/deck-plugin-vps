// The VPS's web traffic from Caddy's access log: requests and errors per site over the last 24h,
// and the newest error requests. VPS only; the homelab has no Caddy in front of it.
//
// Fetched when the panel opens and on the refresh button, not on the panel's 5s poll: each call
// has the server read and parse the whole log file, and a day's counts do not move in 5 seconds.
import { useEffect, useState } from "react";
import { Globe, RotateCw, Loader2 } from "lucide-react";
import { vpsAccess, type AccessSummary } from "./api";

const RED = "rgb(var(--tone-red-400))";
const AMBER = "rgb(var(--tone-amber-400))";

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function AccessCard() {
  const [a, setA] = useState<AccessSummary | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setA(await vpsAccess()); setErr(""); }
    catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Under 24h only when the log rolled over inside the window; say so rather than imply a full day.
  const span = a && Date.now() / 1000 - a.since < 23.5 * 3600 ? `since ${clock(a.since)}` : "last 24h";

  return (
    <div className="rounded-lg border border-subtle p-1.5" style={{ background: "var(--bg-card-glass)" }}>
      <div className="flex h-7 items-center gap-1.5 px-2">
        <Globe size={13} className="text-text-muted" />
        <span className="text-[12px] font-medium text-text-secondary">Web traffic</span>
        {a && <span className="text-[11px] text-text-muted">{span}</span>}
        <button onClick={load} disabled={loading} title="Refresh"
          className="ml-auto grid size-6 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
        </button>
      </div>

      {err && <div className="px-2 py-2 text-[12px]" style={{ color: AMBER }}>{err}</div>}
      {!a && !err && <div className="flex items-center gap-2 px-2 py-4 text-[12.5px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Reading the access log…</div>}

      {a && (
        <>
          {a.sites.length === 0 && <div className="px-2 py-3 text-[12.5px] text-text-muted">No requests</div>}
          <div className="space-y-px">
            {a.sites.map((s) => (
              <div key={s.host} className="flex h-7 items-center gap-3 rounded-md px-2 text-[12.5px]">
                <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{s.host || "(no host)"}</span>
                <span className="w-20 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-text-secondary">{s.total} req</span>
                <span className="w-16 shrink-0 text-right font-mono text-[11.5px] tabular-nums" style={{ color: s.s4xx ? AMBER : "var(--text-muted)" }}>{s.s4xx} 4xx</span>
                <span className="w-16 shrink-0 text-right font-mono text-[11.5px] tabular-nums" style={{ color: s.s5xx ? RED : "var(--text-muted)" }}>{s.s5xx} 5xx</span>
              </div>
            ))}
          </div>

          {a.errors.length > 0 && (
            <>
              <div className="mt-2 flex h-7 items-center px-2 text-[12px] font-medium text-text-secondary">Recent errors</div>
              <div className="scroll-thin max-h-72 space-y-px overflow-y-auto">
                {a.errors.map((e, i) => (
                  <div key={i} title={`${e.ip} · ${e.ms} ms`} className="flex h-7 items-center gap-3 rounded-md px-2 font-mono text-[11.5px] hover:bg-white/5">
                    <span className="w-16 shrink-0 whitespace-nowrap tabular-nums text-text-muted">{clock(e.ts)}</span>
                    <span className="w-9 shrink-0 tabular-nums" style={{ color: e.status >= 500 ? RED : AMBER }}>{e.status}</span>
                    <span className="w-40 shrink-0 truncate text-text-secondary">{e.host}</span>
                    <span className="min-w-0 flex-1 truncate text-text-primary">{e.method} {e.uri}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
