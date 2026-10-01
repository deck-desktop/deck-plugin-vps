# Deck VPS backend

A small Rust/Axum service on the VPS that Deck's VPS plugin reads host stats and container
state from. Runs as a Docker stack on the `edge` network behind Caddy at `deck.example.com`;
no published ports.

## Endpoints

- `GET /health` — unauthenticated liveness (`ok`).
- `GET /status` — `Authorization: Bearer <token>`. Host stats + the container list.
- `POST /action` — `{"name":"<container>","action":"start|stop|restart"}`.
- `GET /logs?name=<container>&tail=200` — one container's recent log.

All three are bearer-guarded proxies to the **host helper**, the localhost service that can
actually run docker. The container has no docker socket, and that is deliberate: the only thing
this process adds is the bearer check, so the helper never has to be exposed.

## What used to be here

A phone relay (`/desk/*`), remote triggers (`/trigger`) and FCM push (`/notify`), all of which
went with the Deck mobile app. See `docs/vps-plugin-plan.md` in the repo root.

**Server-side Script Runner jobs are unaffected** — they never went through this service, and
they no longer live here either. See `plugins/script-runner/vps/`: a systemd timer reads the
job list straight from the synced vault, with no API in the path. The two share a server and
nothing else.

## Layout

```
server/
  Cargo.toml Cargo.lock src/main.rs   # the Axum service
  Dockerfile docker-compose.yml       # the backend, on `edge`, no ports
  install.sh                          # first-time setup (idempotent)
  deploy.sh                           # → /opt/deck-config/deploy.sh
  host-helper/                        # the localhost docker service this proxies to
```

## VPS placement (not a git clone — rsync/scp from here)

- Stack source → `~/stacks/deck/` (Cargo.*, Dockerfile, docker-compose.yml, src/).
- deploy script → `/opt/deck-config/deploy.sh`.
- Secrets → `/opt/deck-config/.env` (chmod 600): `BACKEND_URL`, `BEARER_TOKEN`,
  `VPS_HELPER_URL`. **Never in the vault** (it syncs to other machines).

## First install

`install.sh` does everything under "VPS placement" above — directories, config files, secrets
and the Caddy blocks — and is idempotent, so re-running it repairs a half-finished install
rather than starting over. An existing `.env` is never regenerated.

Run these from this directory (`plugins/vps/server/`), which is what the relative paths are
against:

```sh
# scp rather than rsync — rsync is not on Windows, scp ships with OpenSSH everywhere.
ssh vps 'mkdir -p ~/stacks/deck'
scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml deploy.sh install.sh src vps:~/stacks/deck/
ssh vps 'sh ~/stacks/deck/install.sh deck.example.com --check'   # prints what it would do
ssh vps 'sh ~/stacks/deck/install.sh deck.example.com'
```

The files are listed rather than globbed. `scp -r ./*` would also send `host-helper/`, which
belongs on the host and not in the stack, and a local `target/` if one has been built here.

A second instance on the same host adds `--instance <name>`, and everything — container, config
dir, token, hostname — is separate:

```sh
ssh vps 'mkdir -p ~/stacks/deck-dev'
scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml deploy.sh install.sh src vps:~/stacks/deck-dev/
ssh vps 'sh ~/stacks/deck-dev/install.sh deck-dev.example.com --instance deck-dev'
```

It prints the bearer token at the end; paste it into Deck's VPS plugin settings along with the
URL.

## Upgrading an install that predates this cut

The trigger path unit is no longer installed, and an existing one keeps watching a directory
nothing writes to. Remove it by hand:

```sh
ssh vps 'systemctl --user disable --now deck-trigger.path'
ssh vps 'rm -f ~/.config/systemd/user/deck-trigger.{path,service}'
ssh vps 'systemctl --user daemon-reload'
```

The FCM service-account file at `/opt/deck-config/fcm-sa.json` and the `FCM_PROJECT_ID` line in
`.env` are no longer read and can be deleted whenever convenient.
