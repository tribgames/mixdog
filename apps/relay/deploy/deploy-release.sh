#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?usage: deploy-release.sh <relay-domain> <release-tag>}"
RELEASE_TAG="${2:?usage: deploy-release.sh <relay-domain> <release-tag>}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$(id -u)" = 0 ]]

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR=/opt/mixdog-relay
NEXT_DIR="/opt/mixdog-relay.next-${RELEASE_TAG}"
BACKUP_DIR="/opt/mixdog-relay.backup-${RELEASE_TAG}"
INCLUDE_RENDERER=0
RENDERER_MODE="reused"
RENDERER_DELTA_DIR="$SRC_DIR/.cache/renderer-delta"
RENDERER_MANIFEST="$SRC_DIR/.cache/renderer-manifest.json"
if [[ -d "$RENDERER_DELTA_DIR" && -f "$RENDERER_MANIFEST" ]]; then
  INCLUDE_RENDERER=1
  RENDERER_MODE="delta"
elif [[ -f "$SRC_DIR/renderer/index.html" ]]; then
  INCLUDE_RENDERER=1
  RENDERER_MODE="full"
fi
ACTIVATED=0

rollback() {
  local status=$?
  rm -rf "$NEXT_DIR"
  if [[ "$ACTIVATED" = 1 && -d "$BACKUP_DIR" ]]; then
    systemctl stop mixdog-relay || true
    rm -rf "$INSTALL_DIR"
    mv "$BACKUP_DIR" "$INSTALL_DIR"
    systemctl start mixdog-relay || true
  fi
  exit "$status"
}
trap rollback ERR

test -d "$INSTALL_DIR"
test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
rm -rf "$NEXT_DIR" "$BACKUP_DIR"
mkdir -p "$NEXT_DIR"
cp "$SRC_DIR/server.mjs" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$NEXT_DIR/"
cp -r "$SRC_DIR/lib" "$NEXT_DIR/"
if [[ "$RENDERER_MODE" = "delta" ]]; then
  node "$SRC_DIR/deploy/renderer-delta.mjs" --action=apply \
    "--base=$INSTALL_DIR/renderer" \
    "--delta=$RENDERER_DELTA_DIR" \
    "--manifest=$RENDERER_MANIFEST" \
    "--output=$NEXT_DIR/renderer"
elif [[ "$RENDERER_MODE" = "full" ]]; then
  cp -r "$SRC_DIR/renderer" "$NEXT_DIR/"
else
  test -f "$INSTALL_DIR/renderer/index.html"
  cp -r "$INSTALL_DIR/renderer" "$NEXT_DIR/"
fi
LOCAL_HASH="$(sha256sum "$NEXT_DIR/renderer/index.html" | awk '{print $1}')"
cd "$NEXT_DIR"
# Deploy-time shortcut (CI/CD 단축): the relay's dependency tree is tiny and
# rarely moves — when the lockfile hash matches the installed tree, reuse it
# instead of a fresh npm ci network pass.
LOCK_HASH="$(sha256sum "$NEXT_DIR/package-lock.json" | awk '{print $1}')"
if [[ -f "$INSTALL_DIR/node_modules/.mixdog-lock-hash" \
  && "$(cat "$INSTALL_DIR/node_modules/.mixdog-lock-hash")" = "$LOCK_HASH" ]]; then
  cp -r "$INSTALL_DIR/node_modules" "$NEXT_DIR/node_modules"
else
  npm ci --omit=dev --no-audit --no-fund
fi
printf '%s' "$LOCK_HASH" > "$NEXT_DIR/node_modules/.mixdog-lock-hash"

mv "$INSTALL_DIR" "$BACKUP_DIR"
mv "$NEXT_DIR" "$INSTALL_DIR"
ACTIVATED=1
systemctl restart mixdog-relay

for _ in $(seq 1 30); do
  if systemctl is-active --quiet mixdog-relay \
    && curl --fail --silent --show-error \
      --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" >/tmp/mixdog-relay-health; then
    break
  fi
  sleep 1
done
systemctl is-active --quiet mixdog-relay
grep -q '"status":"ok"' /tmp/mixdog-relay-health
test "$(sha256sum "$INSTALL_DIR/renderer/index.html" | awk '{print $1}')" = "$LOCAL_HASH"

rm -rf "$BACKUP_DIR"
ACTIVATED=0
trap - ERR
echo "[deploy] activated $RELEASE_TAG renderer=$LOCAL_HASH mode=$RENDERER_MODE"
