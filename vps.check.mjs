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
  // api.ts imports the bridge shim, which only exists inside Deck. None of it is reached by
  // deployTarget, so a stub with the right named exports is enough to let the module load.
  plugins: [{
    name: "shim",
    setup(b) {
      b.onResolve({ filter: /shim\/bridge\.js$/ }, (a) => ({ path: a.path, namespace: "shim" }));
      b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        contents: "export const configRead = async () => '';" +
                  "export const configWrite = async () => {};" +
                  "export const httpSend = async () => ({});",
        loader: "js",
      }));
    },
  }],
});
const { deployTarget } = await import(
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

console.log("vps.check.mjs: ok");
