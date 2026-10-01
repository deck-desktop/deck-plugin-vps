#!/bin/sh
# Rebuild and restart a Deck backend stack that is already installed. install.sh is what puts one
# there the first time.
#
# The stack name comes from the copy of this script in the instance's own config dir — install.sh
# writes it in — so /opt/deck-config/deploy.sh rebuilds "deck" and /opt/deck-dev-config/deploy.sh
# rebuilds "deck-dev". It used to hardcode ~/stacks/deck, which meant running a dev instance's
# copy quietly rebuilt production.
set -e
INSTANCE="${1:-__INSTANCE__}"
cd "$HOME/stacks/$INSTANCE"
docker compose up -d --build
echo "$INSTANCE stack up."
