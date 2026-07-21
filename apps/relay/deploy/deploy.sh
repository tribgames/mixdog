#!/usr/bin/env bash
# One-shot relay deploy: run ON the VPS (Ubuntu 22.04+, as root).
#   curl -fsSL <raw url>/deploy.sh | bash -s relay.example.com
# or: scp -r apps/relay root@vps: && bash relay/deploy/deploy.sh relay.example.com
#
# Does: node 22 install, mixdog-relay user, /opt/mixdog-relay code, Let's
# Encrypt cert (standalone, port 80 must be free), systemd unit on :443 with
# in-process TLS, renew hook that restarts the service.
set -euo pipefail

DOMAIN="${1:?usage: deploy.sh <relay-domain>}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

id -u mixdog-relay >/dev/null 2>&1 || useradd --system --home /var/lib/mixdog-relay --shell /usr/sbin/nologin mixdog-relay
mkdir -p /opt/mixdog-relay /var/lib/mixdog-relay
cp "$SRC_DIR/server.mjs" "$SRC_DIR/package.json" /opt/mixdog-relay/
# Optional web app + APK: stage a renderer build (plus mixdog.apk) next to
# server.mjs before running this script and the relay serves it over https.
if [[ -d "$SRC_DIR/renderer" ]]; then
  rm -rf /opt/mixdog-relay/renderer
  cp -r "$SRC_DIR/renderer" /opt/mixdog-relay/renderer
fi
cd /opt/mixdog-relay && npm install --omit=dev --no-audit --no-fund
chown -R mixdog-relay:mixdog-relay /var/lib/mixdog-relay

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  apt-get install -y certbot
  certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN"
fi
# The service user must read the cert; scope group access to the live/archive dirs.
chgrp -R mixdog-relay /etc/letsencrypt/live /etc/letsencrypt/archive
chmod -R g+rx /etc/letsencrypt/live /etc/letsencrypt/archive
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nchgrp -R mixdog-relay /etc/letsencrypt/live /etc/letsencrypt/archive\nchmod -R g+rx /etc/letsencrypt/live /etc/letsencrypt/archive\nsystemctl restart mixdog-relay\n' \
  > /etc/letsencrypt/renewal-hooks/deploy/mixdog-relay
chmod +x /etc/letsencrypt/renewal-hooks/deploy/mixdog-relay

sed "s/RELAY_DOMAIN/$DOMAIN/g" "$SRC_DIR/deploy/mixdog-relay.service" > /etc/systemd/system/mixdog-relay.service
systemctl daemon-reload
systemctl enable --now mixdog-relay
sleep 1
systemctl --no-pager status mixdog-relay | head -5
echo "[deploy] relay live: https://$DOMAIN/healthz  (desktop: MIXDOG_RELAY_URL=wss://$DOMAIN)"
