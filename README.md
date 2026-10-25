# Servers

Host stats and container control for your own VPS and homelab, as footer readouts and a panel.
(Its id is still `vps`, from before it covered the homelab, so existing settings carry over.)

Click the VPS readout in the footer (or run **Servers: open the panel** from the command palette)
to see CPU, memory, disk, uptime and network rate, plus every container with start/stop/restart
and a log tail. Stop and restart ask first — these are production actions.

## The homelab

Set **Homelab SSH host** in the plugin's settings to a host from `~/.ssh/config` that logs in with
a key (`ssh homelab` must work without a prompt). Nothing is installed on it: each refresh is one
`ssh` running a short shell probe (`src/homelab.ts`) that prints CPU, memory, disk, uptime,
network, Wi-Fi signal, mains and battery, the `battery-guard.timer` state, and the containers.
The homelab gets its own footer readout, and the panel switches between it and the VPS.
Losing mains power posts a notification, and mains coming back takes it down.

## It needs a server half

Unlike every other plugin here, this one talks to something you deploy. `server/` holds it: a
small Rust/Axum service that sits behind Caddy on your VPS and proxies three routes to a
localhost host helper that can actually run docker.

```
GET  /health    unauthenticated liveness
GET  /status    host stats + container list
POST /action    start | stop | restart a container
GET  /logs      one container's recent log
```

Everything but `/health` is bearer-guarded. The container has no docker socket on purpose — the
only thing the service adds over the helper is the token check, so the helper is never exposed.

### Deploying it

From this folder, with Docker and Caddy already on the host:

```sh
cd plugins/vps/server            # the paths below are relative to here
ssh vps 'mkdir -p ~/stacks/deck'
scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml \
  deploy.sh install.sh src vps:~/stacks/deck/
ssh vps 'sh ~/stacks/deck/install.sh deck.example.com --check'   # prints what it would do
ssh vps 'sh ~/stacks/deck/install.sh deck.example.com'
```

The files are named rather than globbed as `server/*`, which would also copy up
`host-helper/` — a separate binary that installs on the host, not into the stack — and any
local `target/` of build output.

`install.sh` is idempotent, so re-running it repairs a half-finished install rather than
starting over, and it never regenerates an existing token. It prints the bearer token at the
end — paste that and the URL into the VPS plugin's settings (its gear in Plugins › Installed).

A **second stack** beside the first, for testing, is the same commands with a different name
and hostname — nothing is shared between them:

```sh
ssh vps 'mkdir -p ~/stacks/deck-dev'
scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml \
  deploy.sh install.sh src vps:~/stacks/deck-dev/
ssh vps 'sh ~/stacks/deck-dev/install.sh deck-dev.example.com --instance deck-dev'
```

`server/README.md` has the rest: what goes where, the host helper, and how to retire the
trigger unit an install from before the phone app was dropped will still have.

## How it fits Deck

- **No tab.** It exports `Status` and `Settings`, so it contributes a footer readout and a
  settings panel and nothing to the sidebar. The VPS is checked when the dot goes red and then
  left, so the panel opens as an overlay from the readout rather than owning a nav slot.
- **Requests go through `httpSend`**, Deck's Rust HTTP client, rather than the webview's fetch.
  The backend does send CORS headers so fetch would work, but this brings the size cap and
  timeout http.rs already implements, and does not depend on `csp: null` staying null.
- **Settings stay on this machine.** They live in `plugin-vps` in Deck's config dir, and a
  backup leaves the bearer token out (one of the two fields), keeping only the URL.
- **`server/` is never bundled.** Deck seeds only `plugin.json`, `plugin.js` and `mcp.js` into
  `%APPDATA%\Deck\plugins`, so the Rust source stays in the repo where the deploy steps expect it.

This is the worked example of a plugin with a server half. Nothing stops another one from
shipping the same way.
