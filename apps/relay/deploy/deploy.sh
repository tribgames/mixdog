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
cp "$SRC_DIR/server.mjs" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" /opt/mixdog-relay/
# Shared HTTP helpers the server imports (also used by the desktop LAN bridge).
rm -rf /opt/mixdog-relay/lib
cp -r "$SRC_DIR/lib" /opt/mixdog-relay/lib
# Optional web app: run `npm run stage:web` before copying this directory and
# the relay serves the staged renderer over https.
if [[ -d "$SRC_DIR/renderer" ]]; then
  rm -rf /opt/mixdog-relay/renderer
  cp -r "$SRC_DIR/renderer" /opt/mixdog-relay/renderer
fi
cd /opt/mixdog-relay && npm ci --omit=dev --no-audit --no-fund
chown -R mixdog-relay:mixdog-relay /var/lib/mixdog-relay

if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  apt-get install -y certbot
  certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMAIN"
fi
# The service user must read THIS relay's certificate — and nothing else on the
# host. Recursive group access over live/ and archive/ hands the relay account
# every private key certbot manages here, so the parents only get traverse (x)
# and the grant stops at this domain's directory.
revoke_stale_cert_access() {
  local domain="$1"
  local root
  # An earlier install granted this group RECURSIVE access to every certificate
  # certbot manages here. An upgrade has to take that back, not just narrow the
  # new grant, so anything still group-owned outside $domain is handed to root.
  #
  # Nothing here is suppressed. A chmod/chgrp that does not land leaves the
  # relay account holding ANOTHER domain's private key — the exact state this
  # function exists to end — so a failure has to stop the deploy loudly instead
  # of scrolling past as `|| true`. A missing tree is not a failure: it is
  # skipped, which is what `2>/dev/null` used to hide alongside the real ones.
  for root in /etc/letsencrypt/live /etc/letsencrypt/archive; do
    [[ -d "$root" ]] || continue
    find "$root" -mindepth 1 -group mixdog-relay -type f \
      ! -path "$root/$domain/*" \
      -exec chmod g-r {} +
    find "$root" -mindepth 1 -group mixdog-relay \
      ! -path "$root/$domain" ! -path "$root/$domain/*" \
      -exec chgrp root {} +
  done
}
grant_cert_access() {
  local domain="$1"
  chgrp mixdog-relay /etc/letsencrypt/live /etc/letsencrypt/archive
  chmod g+x /etc/letsencrypt/live /etc/letsencrypt/archive
  chgrp -R mixdog-relay "/etc/letsencrypt/live/$domain" "/etc/letsencrypt/archive/$domain"
  chmod g+rx "/etc/letsencrypt/live/$domain" "/etc/letsencrypt/archive/$domain"
  chmod g+r "/etc/letsencrypt/archive/$domain"/*.pem
}
# A scoping failure is a security failure: stop here with the reason visible
# rather than continuing into a service that can read the whole cert store.
trap 'echo "[deploy] certificate scoping failed above; the mixdog-relay account may still reach other domains. Deploy aborted." >&2' ERR
revoke_stale_cert_access "$DOMAIN"
grant_cert_access "$DOMAIN"
trap - ERR
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/mixdog-relay <<HOOK
#!/bin/sh
set -e
# Renewal re-creates archive/live entries, so the scoping is re-applied on every
# deploy hook. Every step is checked: a silent chmod/chgrp failure here is how a
# stale cross-domain grant survives forever. On failure the hook exits non-zero
# WITHOUT restarting — certbot reports it, and the relay keeps serving the
# certificate it already loaded instead of coming up unscoped.
fail() {
  echo "[mixdog-relay] certificate scoping FAILED: \$1" >&2
  exit 1
}
for root in /etc/letsencrypt/live /etc/letsencrypt/archive; do
  [ -d "\$root" ] || continue
  find "\$root" -mindepth 1 -group mixdog-relay -type f \\
    ! -path "\$root/$DOMAIN/*" \\
    -exec chmod g-r {} + || fail "revoking group read under \$root"
  find "\$root" -mindepth 1 -group mixdog-relay \\
    ! -path "\$root/$DOMAIN" ! -path "\$root/$DOMAIN/*" \\
    -exec chgrp root {} + || fail "revoking group ownership under \$root"
done
chgrp mixdog-relay /etc/letsencrypt/live /etc/letsencrypt/archive || fail "parent group"
chmod g+x /etc/letsencrypt/live /etc/letsencrypt/archive || fail "parent traverse"
chgrp -R mixdog-relay "/etc/letsencrypt/live/$DOMAIN" "/etc/letsencrypt/archive/$DOMAIN" || fail "domain group"
chmod g+rx "/etc/letsencrypt/live/$DOMAIN" "/etc/letsencrypt/archive/$DOMAIN" || fail "domain traverse"
chmod g+r "/etc/letsencrypt/archive/$DOMAIN"/*.pem || fail "domain key read"
systemctl restart mixdog-relay
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/mixdog-relay

sed "s/RELAY_DOMAIN/$DOMAIN/g" "$SRC_DIR/deploy/mixdog-relay.service" > /etc/systemd/system/mixdog-relay.service
systemctl daemon-reload
systemctl enable mixdog-relay
systemctl restart mixdog-relay
sleep 1
systemctl --no-pager status mixdog-relay | head -5
echo "[deploy] relay live: https://$DOMAIN/healthz  (desktop: MIXDOG_RELAY_URL=wss://$DOMAIN)"
