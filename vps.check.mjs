// deployTarget: the host and stack name the settings panel writes into its deploy commands.
//
//   node vps.check.mjs
//
// Worth pinning because the failure is silent and expensive: a wrong instance sends someone's
// dev install into the production stack's directory, config dir and container name, and the
// commands look perfectly reasonable while doing it.
import assert from "node:assert";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The real source, compiled — not a copy. A check holding its own copy of the logic cannot
// fail when the source changes, which is the one thing it exists to catch.
const out = await build({
  entryPoints: [join(here, "src/api.ts")],
  bundle: true, write: false, format: "esm", platform: "node",
  // api.ts imports the bridge and ui shims, which only exist inside Deck. deployTarget reaches
  // none of it, so a stub with the right named exports lets the module load; the notification
  // calls are recorded, for the container watch below.
  plugins: [{
    name: "shim",
    setup(b) {
      b.onResolve({ filter: /shim\/(bridge|ui)\.js$/ }, (a) => ({ path: a.path, namespace: "shim" }));
      b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        contents: "export const configRead = async () => '';" +
                  "export const configWrite = async () => {};" +
                  "export const httpSend = async () => ({});" +
                  "export const notify = (n) => globalThis.__posted.push(['notify', n.key, n.title]);" +
                  "export const dismissNotification = (s, k) => globalThis.__posted.push(['dismiss', k]);",
        loader: "js",
      }));
    },
  }],
});
globalThis.__posted = [];
const { deployTarget, watchContainers } = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

const eq = (url, host, instance) =>
  assert.deepStrictEqual(deployTarget(url), { host, instance }, `deployTarget(${JSON.stringify(url)})`);

// An empty box reads as an example rather than as something broken.
eq("", "deck.example.com", "deck");
eq("   ", "deck.example.com", "deck");

// The ordinary case: scheme stripped, instance is install.sh's own default.
eq("https://deck.example.com", "deck.example.com", "deck");
eq("http://deck.example.com", "deck.example.com", "deck");
eq("deck.example.com", "deck.example.com", "deck");

// A trailing path or slash is not part of the hostname.
eq("https://deck.example.com/", "deck.example.com", "deck");
eq("https://deck.example.com/status", "deck.example.com", "deck");

// A deck-<name> first label names the stack. This is the whole point: it is what keeps a dev
// install out of the production stack's directory and config dir.
eq("https://deck-dev.hasan-zarif.com", "deck-dev.hasan-zarif.com", "deck-dev");
eq("https://deck-staging.example.com", "deck-staging.example.com", "deck-staging");

// Anything else installs "deck". A host that says nothing about the stack must not be guessed
// at — "vps" is not an instance, and installing one would be wrong in a way nobody would spot.
eq("https://vps.example.com", "vps.example.com", "deck");
eq("https://example.com", "example.com", "deck");
// "deckdev" without the hyphen is not the deck-<name> form, so it is not an instance either.
eq("https://deckdev.example.com", "deckdev.example.com", "deck");

// Case and whitespace are the user's, not the shell's.
eq("  HTTPS://Deck-Dev.Example.COM  ", "deck-dev.example.com", "deck-dev");

// A port belongs to the URL, not to the name Caddy serves or the stack installs under.
eq("https://deck-dev.example.com:8080", "deck-dev.example.com", "deck-dev");

// ---- watchContainers: running to down is one notification, up again takes it down ----------
const status = (...cs) => JSON.stringify({ host: {}, containers: cs.map(([name, state, s]) => ({ name, state, status: s })) });
const posted = () => globalThis.__posted.splice(0);
// The first read is the baseline: a container already stopped there is not news.
watchContainers(status(["web", "running", "Up 2 hours"], ["old", "exited", "Exited (0) 3 days ago"]));
assert.deepStrictEqual(posted(), [], "nothing for the baseline");
watchContainers(status(["web", "running", "Up 2 hours (unhealthy)"], ["old", "exited", "Exited (0) 3 days ago"]));
assert.deepStrictEqual(posted(), [["notify", "down:web", "web is down"]], "unhealthy counts as down");
watchContainers(status(["web", "exited", "Exited (1) 1 second ago"]));
assert.deepStrictEqual(posted(), [], "still down is not posted again");
watchContainers(status(["web", "running", "Up 1 second (health: starting)"]));
assert.deepStrictEqual(posted(), [["dismiss", "down:web"]], "running again takes it down");
assert.throws(() => watchContainers("not json"), "an unreadable reply throws, for vpsStatus to log");
assert.deepStrictEqual(posted(), [], "and changes nothing");

console.log("vps.check.mjs: ok");
