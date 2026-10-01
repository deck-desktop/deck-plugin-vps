#!/bin/sh
# First-time setup for the Deck backend on a fresh VPS. Idempotent: every step is skipped if it
# is already done, so re-running it is safe and is the way to repair a half-finished install.
#
# deploy.sh is the sibling of this script: it rebuilds a stack that already exists. This one puts
# the stack, its secrets and the Caddy site blocks in place the first time.
#
# Run it ON THE VPS, after copying this directory there:
#
#   scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml deploy.sh install.sh src \n#       vps:~/stacks/deck/
#   ssh vps 'sh ~/stacks/deck/install.sh deck.example.com'
#
# A second instance can sit beside the first on the same host — a dev backend, say — with its own
# container, config dir, token and hostname. Nothing is shared, so experimenting on one cannot
# disturb the other:
#
#   scp -r Cargo.toml Cargo.lock Dockerfile docker-compose.yml deploy.sh install.sh src \n#       vps:~/stacks/deck-dev/
#   ssh vps 'sh ~/stacks/deck-dev/install.sh deck-dev.example.com --instance deck-dev'
#
# Add --check to print what each step would do and change nothing.
#
# Point DNS for <deck-host> at this box before running, or Caddy cannot get a certificate.
set -e

DECK_HOST=""
INSTANCE=deck
CHECK=""
while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK=1 ;;
        --instance) INSTANCE="$2"; shift ;;
        # Quoted: dash parses a bare -* here as an option to `set`.
        "-"*) echo "unknown option: $1" >&2; exit 2 ;;
        # `[ ] && x` as the last command of a branch returns non-zero when the test fails, which
        # set -e treats as a failure. if/fi keeps the exit status clean.
        *) if [ -z "$DECK_HOST" ]; then DECK_HOST="$1"; fi ;;
    esac
    shift
done

if [ -z "$DECK_HOST" ]; then
    echo "usage: sh install.sh <deck-host> [--instance <name>] [--check]" >&2
    echo "  e.g. sh install.sh deck.example.com" >&2
    echo "       sh install.sh deck-dev.example.com --instance deck-dev" >&2
    exit 2
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() { if [ -n "$CHECK" ]; then say "  would: $*"; else eval "$@"; fi; }

# Every path carries the instance name, so a second stack shares nothing with the first.
STACK="$HOME/stacks/$INSTANCE"
CONF="/opt/$INSTANCE-config"
say_instance() { [ "$INSTANCE" = deck ] || echo " (instance: $INSTANCE)"; }

# ---- preconditions: report everything missing at once, then stop -------------------------
step "Checking prerequisites"
MISSING=""
command -v docker >/dev/null 2>&1 || MISSING="$MISSING docker"
docker compose version >/dev/null 2>&1 || MISSING="$MISSING docker-compose-plugin"
command -v openssl >/dev/null 2>&1 || MISSING="$MISSING openssl"
[ -f "$HOME/stacks/caddy/Caddyfile" ] || MISSING="$MISSING caddy-stack(~/stacks/caddy/Caddyfile)"
if [ -n "$MISSING" ]; then
    say "missing:$MISSING"
    say "Install these first — this script sets up Deck's stack, not the host."
    exit 1
fi
say "ok"

# ---- the edge network, and the gateway the backend reaches the host helper on -------------
# The compose file used to hardcode 172.18.0.1. That is only this network's gateway by accident of
# creation order: on another host Docker may hand `edge` a different subnet, and the backend would
# then fail to reach the host helper with nothing in the logs to say why. Read it instead.
step "Docker network 'edge'"
if docker network inspect edge >/dev/null 2>&1; then
    say "exists"
else
    run "docker network create edge"
fi
GATEWAY=$(docker network inspect edge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo "")
[ -z "$GATEWAY" ] && GATEWAY=172.18.0.1
say "gateway: $GATEWAY"

# ---- directories -------------------------------------------------------------------------
step "Directories"
run "mkdir -p '$STACK'"
run "sudo mkdir -p '$CONF'"
run "sudo chown -R '$USER' '$CONF'"
say "ok"

# ---- config files --------------------------------------------------------------------------
step "Config files"
# deploy.sh carries the instance name, so each config dir's copy rebuilds its own stack.
run "sed 's|__INSTANCE__|$INSTANCE|' '$STACK/deploy.sh' > '$CONF/deploy.sh'"
run "chmod +x '$CONF/deploy.sh'"

# ---- secrets: generated once, never regenerated ---------------------------------------------
# Rewriting an existing token would break every client already using it, so an existing .env is
# left exactly as it is.
step "Secrets ($CONF/.env)"
if [ -f "$CONF/.env" ]; then
    say "exists — left alone (delete it by hand if you really want new secrets)"
    TOKEN=$(grep '^BEARER_TOKEN=' "$CONF/.env" | cut -d= -f2-)
elif [ -n "$CHECK" ]; then
    say "  would: generate BEARER_TOKEN and write $CONF/.env (chmod 600)"
    TOKEN="<generated>"
else
    TOKEN=$(openssl rand -hex 32)
    umask 177
    cat > "$CONF/.env" <<EOF
BACKEND_URL=https://$DECK_HOST
BEARER_TOKEN=$TOKEN
VPS_HELPER_URL=http://$GATEWAY:8899
EOF
    umask 022
    say "written"
fi

# ---- Caddy ----------------------------------------------------------------------------------
# Appended only when the host is absent, so a re-run never duplicates a site block. DNS must
# already point here or Caddy cannot get a certificate.
step "Caddy site blocks"
CADDYFILE="$HOME/stacks/caddy/Caddyfile"
if grep -q "^$DECK_HOST" "$CADDYFILE" 2>/dev/null; then
    say "$DECK_HOST already present — left alone"
elif [ -n "$CHECK" ]; then
    say "  would: append a block for $DECK_HOST, then reload Caddy"
else
    cat >> "$CADDYFILE" <<EOF

$DECK_HOST {
    reverse_proxy $INSTANCE-backend:8080
}
EOF
    docker compose -f "$HOME/stacks/caddy/docker-compose.yml" exec -T caddy caddy reload --config /etc/caddy/Caddyfile
    say "appended + reloaded"
fi

# ---- bring it up ------------------------------------------------------------------------------
# compose interpolates ${DECK_INSTANCE} from a .env beside the compose file — a different file
# from the service's env_file, which holds the secrets.
step "Stack"
run "printf 'DECK_INSTANCE=%s\n' '$INSTANCE' > '$STACK/.env'"
run "cd '$STACK' && docker compose up -d --build"

if [ -n "$CHECK" ]; then
    printf '\n--check: nothing was changed.\n'
    exit 0
fi

step "Health"
sleep 3
if curl -sf "https://$DECK_HOST/health" >/dev/null 2>&1; then
    say "https://$DECK_HOST/health responds"
else
    say "no response yet — Caddy may still be getting a certificate. Check:"
    say "  docker logs $INSTANCE-backend --tail 30"
fi

cat <<EOF

────────────────────────────────────────────────────────────
 Deck backend is up.

 In Deck$(say_instance): the VPS plugin's settings
   URL    https://$DECK_HOST
   Token  $TOKEN

 The token is also in $CONF/.env, which is the only copy.

 Re-run this script any time; it changes nothing that is already set up.
────────────────────────────────────────────────────────────
EOF
