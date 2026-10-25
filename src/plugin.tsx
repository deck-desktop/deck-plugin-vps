// Servers — host stats and container control for your own VPS and homelab.
//
// A plugin with no tab: it exports `Status` and `Settings`, so it contributes a footer readout
// and a settings panel, and nothing to the sidebar. That is deliberate and predates the move out
// of core — the VPS is checked when the footer dot goes red, then left, so it is a question
// asked in the footer rather than a destination in the nav. Clicking the readout opens the panel
// as an overlay.
//
// It also ships its own server: `server/` holds the Axum service the VPS calls reach, with
// install.sh to stand one up. See the plugin's README. The homelab needs nothing installed: it is
// read over SSH (homelab.ts), and gets a footer readout of its own once its host is set.
//
// The id stays `vps` from before the rename to Servers, so the stored settings, the install
// folder and the links into its settings page all keep working.
import { useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Server, X } from "lucide-react";
import { sshHosts } from "../shim/bridge.js";
import { Field, TextInput, StatusItem } from "../shim/ui.js";
import ServersPanel, { type SourceId } from "./Panel";
import { configured, deployTarget, get, getVersion, load, subscribe, update, vpsStatus } from "./api";
import { homelabStatus } from "./homelab";

// Read once at import, so the readout has its settings before its first render rather than
// flashing "not configured" for a tick.
void load();

const POLL_MS = 60000;

/**
 * The background "is it up" check, polling only while `on`. A network round trip (an ssh for
 * the homelab) that does not need to be frequent; the panel polls at 5s while it is open.
 */
function useUp(on: boolean, status: () => Promise<unknown>) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!on) { setOk(false); return; }
    const poll = () => { status().then(() => setOk(true)).catch(() => setOk(false)); };
    poll();
    const t = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    return () => clearInterval(t);
  }, [on, status]);
  return ok;
}

/** The footer readouts: a dot for reachable, and a click to open the panel on that host. */
export function Status() {
  useSyncExternalStore(subscribe, getVersion);
  const [open, setOpen] = useState<SourceId | null>(null);
  const on = configured();
  const homelab = get().homelab;
  const ok = useUp(on, vpsStatus);
  const labOk = useUp(Boolean(homelab), homelabStatus);

  return (
    <>
      {homelab && (
        <StatusItem
          icon={<Server />}
          color={labOk ? "rgb(var(--tone-green-400))" : "var(--text-muted)"}
          label={homelab}
          title={labOk ? "Homelab is responding\n\nOpen the Servers panel" : "Homelab unreachable over SSH\n\nOpen the Servers panel"}
          onClick={() => setOpen("homelab")}
        />
      )}
      <StatusItem
        icon={<Server />}
        color={ok ? "rgb(var(--tone-green-400))" : "var(--text-muted)"}
        // The host rather than a fixed "vps", so a second stack (deck-dev.…) is told apart.
        label={on ? deployTarget(get().url).host : "vps"}
        title={on
          ? (ok ? "VPS is responding\n\nOpen the Servers panel" : "VPS unreachable\n\nOpen the Servers panel")
          : "VPS not configured\n\nOpen the Servers panel"}
        onClick={() => setOpen("vps")}
      />
      <VpsOverlay open={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Command-palette entry, so the panel is reachable without aiming at the footer. */
export function commands() {
  return [
    {
      id: "open",
      title: "Servers: open the panel",
      run: () => window.dispatchEvent(new CustomEvent("deck-open-vps")),
    },
  ];
}

/**
 * The panel as an overlay.
 *
 * A tab costs permanent space in the nav for something that is looked at rather than worked in.
 * Mounted only while open, so the panel's 5s poll does not run for something nobody is reading.
 */
function VpsOverlay({ open, onClose }: { open: SourceId | null; onClose: () => void }) {
  const [shown, setShown] = useState<SourceId | null>(open);
  useEffect(() => setShown(open), [open]);

  // The palette entry fires this rather than reaching into the readout's state.
  useEffect(() => {
    const openIt = () => setShown("vps");
    window.addEventListener("deck-open-vps", openIt);
    return () => window.removeEventListener("deck-open-vps", openIt);
  }, []);

  const close = () => { setShown(null); onClose(); };

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          // Blurred rather than only dimmed: the panel sits over a dense grid of terminals and
          // tables, and a wash alone leaves all of it legible enough to keep competing for the eye.
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50 p-8 backdrop-blur-md"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            // A fixed height rather than sizing to content: the panel's own root is h-full with
            // its own scrolling container list, so it needs a parent with a height to fill.
            className="relative flex h-[min(52rem,100%)] w-[min(80rem,94vw)] flex-col overflow-hidden rounded-[10px] border border-subtle shadow-2xl"
            style={{ background: "var(--bg-card)" }}
            initial={{ scale: 0.96, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={close} title="Close (Esc)"
              className="absolute right-4 top-4 z-10 grid size-7 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
              <X size={15} />
            </button>
            <div className="min-h-0 flex-1 p-6">
              <ServersPanel initial={shown} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The settings panel, rendered inside this plugin's own row in Settings > Plugins. */
export function Settings() {
  useSyncExternalStore(subscribe, getVersion);
  const s = get();
  // The commands below are written for whatever is in the URL box, rather than for an example
  // host the reader has to substitute themselves. That substitution is where the mistakes are:
  // the stack directory, the --instance flag and the config path all have to agree, and each
  // one is silently wrong if a placeholder is left in.
  const { host, instance } = deployTarget(s.url);
  const stack = `~/stacks/${instance}`;
  const [hosts, setHosts] = useState<string[]>([]);
  useEffect(() => { sshHosts().then(setHosts).catch((e) => console.warn("[vps] ssh hosts failed", e)); }, []);

  return (
    <div className="space-y-3">
      <Field label="Homelab SSH host" hint="A host from ~/.ssh/config with key login, e.g. homelab. It is read over SSH and nothing is installed on it. Leave empty to hide the homelab.">
        <TextInput
          list="vps-ssh-hosts"
          value={s.homelab}
          onChange={(e) => void update({ homelab: e.target.value.trim() })}
          placeholder="homelab"
        />
        <datalist id="vps-ssh-hosts">{hosts.map((h) => <option key={h} value={h} />)}</datalist>
      </Field>

      <Field label="Backend URL" hint="Where the service below is reachable, e.g. https://deck.example.com.">
        <TextInput
          value={s.url}
          onChange={(e) => void update({ url: e.target.value.trim() })}
          placeholder="https://deck.example.com"
        />
      </Field>

      <Field label="Token" hint="The BEARER_TOKEN install.sh printed. Stored on this machine only — a plugin's config is never synced.">
        <TextInput
          type="password"
          value={s.token}
          onChange={(e) => void update({ token: e.target.value.trim() })}
          placeholder={`from /opt/${instance}-config/.env`}
        />
      </Field>

      <div className="rounded-lg border border-subtle p-3 text-[12px] leading-relaxed text-text-secondary"
        style={{ background: "var(--bg-elev)" }}>
        <div className="mb-1.5 text-[12px] font-medium text-text-primary">Standing up the backend</div>
        <p className="mb-2 text-text-muted">
          This plugin talks to a small service you run on your own VPS. Its source ships with the
          plugin, under <span className="font-mono">plugins/vps/server/</span> in the Deck repo.
          {s.url.trim()
            ? <> These are written for <span className="font-mono">{host}</span> — the URL above.</>
            : <> Fill in the URL above and these will name your own host.</>}
        </p>
        <pre className="scroll-thin overflow-x-auto rounded-md border border-subtle p-2 font-mono text-[11px] text-text-secondary"
          style={{ background: "var(--bg-app)" }}>
{`cd <your Deck checkout>/plugins/vps/server
ssh vps 'mkdir -p ${stack}'
scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml \\
  deploy.sh install.sh src vps:${stack}/
ssh vps 'sh ${stack}/install.sh ${host}${instance === "deck" ? "" : ` --instance ${instance}`} --check'
ssh vps 'sh ${stack}/install.sh ${host}${instance === "deck" ? "" : ` --instance ${instance}`}'`}
        </pre>
        <p className="mt-2 text-text-muted">
          Named files rather than <span className="font-mono">server/*</span>: that glob would also
          send <span className="font-mono">host-helper/</span>, which installs separately, and a
          local <span className="font-mono">target/</span> of build output. The line ending in{" "}
          <span className="font-mono">--check</span> is a dry run — it prints what it would do and
          changes nothing, so read that before the last one.
        </p>
        <p className="mt-2 text-text-muted">
          {instance === "deck"
            ? <>It prints the token at the end. A second stack beside this one is the same commands
                with a host like <span className="font-mono">deck-dev.example.com</span> — the name
                decides the instance, and nothing is shared between them.</>
            : <>It prints the token at the end. This installs the{" "}
                <span className="font-mono">{instance}</span> stack, which shares nothing with any
                other on that host.</>}
          {" "}Needs Docker and Caddy already there; the README in that folder has the details.
        </p>
      </div>

      {!configured() && (
        <p className="text-[12px] text-text-muted">
          Both boxes are needed — the readout stays grey and the panel says so until then.
        </p>
      )}
    </div>
  );
}
