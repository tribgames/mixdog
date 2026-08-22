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
LOCK_FILE=/run/mixdog-relay-deploy.lock
RENDERER_MODE="reused"
RENDERER_DELTA_DIR="$SRC_DIR/.cache/renderer-delta"
RENDERER_MANIFEST="$SRC_DIR/.cache/renderer-manifest.json"
if [[ -d "$RENDERER_DELTA_DIR" && -f "$RENDERER_MANIFEST" ]]; then
  # Provenance, not just presence: a delta reconstructs its release only on top
  # of the exact installed tree it was computed from. The manifest records that
  # base and `renderer-delta.mjs --action=apply` refuses any other tree, so a
  # cache left over from an earlier release can no longer rebuild stale content
  # that then passes the post-swap hash check (taken from the same rebuild).
  RENDERER_BASE="$(node -e 'const {readFileSync}=require("node:fs");const m=JSON.parse(readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof m.base==="string"?m.base:"")' "$RENDERER_MANIFEST")"
  if [[ "$RENDERER_BASE" =~ ^[0-9a-f]{64}$ ]]; then
    RENDERER_MODE="delta"
  elif [[ -f "$SRC_DIR/renderer/index.html" ]]; then
    # An unusable cache never outranks renderer content that IS in this upload.
    echo "[deploy] ignoring cached renderer delta without base provenance; deploying the full renderer from this upload" >&2
    RENDERER_MODE="full"
  else
    echo "[deploy] cached renderer delta at $RENDERER_DELTA_DIR has no base provenance, and this upload carries no renderer/." >&2
    echo "[deploy] fix: rm -rf '$SRC_DIR/.cache' and re-run to keep the installed renderer, or rebuild the delta:" >&2
    echo "[deploy]   node '$SRC_DIR/deploy/renderer-delta.mjs' --action=create --root=<renderer> --base=<installed manifest> --delta='$RENDERER_DELTA_DIR' --manifest='$RENDERER_MANIFEST'" >&2
    exit 1
  fi
elif [[ -f "$SRC_DIR/renderer/index.html" ]]; then
  RENDERER_MODE="full"
fi
ACTIVATED=0

# One release at a time: the staging globs below sweep every
# /opt/mixdog-relay.* directory, so a concurrent run would delete the other's
# work in progress — including a backup mid-swap.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[deploy] another release is already running; aborting" >&2
  exit 1
fi

cleanup_stale_releases() {
  rm -rf \
    /opt/mixdog-relay.rollback \
    /opt/mixdog-relay.previous \
    /opt/mixdog-relay.bak-* \
    /opt/mixdog-relay.backup-* \
    /opt/mixdog-relay.next-*
}

rollback() {
  local status=$?
  trap - ERR
  rm -rf "$NEXT_DIR"
  if [[ "$ACTIVATED" = 1 && -d "$BACKUP_DIR" ]]; then
    systemctl stop mixdog-relay || true
    rm -rf "$INSTALL_DIR"
    mv "$BACKUP_DIR" "$INSTALL_DIR"
    # A rollback that restores the files but cannot start the service leaves
    # production DOWN. That is a different (worse) outcome than the deploy
    # failure that triggered it, so it exits with its own status instead of
    # being swallowed by `|| true`.
    if ! systemctl restart mixdog-relay || ! systemctl is-active --quiet mixdog-relay; then
      echo "[deploy] ROLLBACK FAILED: $INSTALL_DIR restored but mixdog-relay is not running" >&2
      exit 90
    fi
    echo "[deploy] rolled back to the previous release (deploy exited $status)" >&2
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

# The health body stays in this shell: a predictable /tmp path lets any local
# user pre-place a symlink there and have root truncate whatever it points at.
HEALTH_BODY=""
for _ in $(seq 1 30); do
  if systemctl is-active --quiet mixdog-relay \
    && HEALTH_BODY="$(curl --fail --silent \
      --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")"; then
    break
  fi
  sleep 1
done
systemctl is-active --quiet mixdog-relay
printf '%s' "$HEALTH_BODY" | grep -q '"status":"ok"'
test "$(sha256sum "$INSTALL_DIR/renderer/index.html" | awk '{print $1}')" = "$LOCAL_HASH"

rm -rf "$BACKUP_DIR"
cleanup_stale_releases
ACTIVATED=0
trap - ERR
echo "[deploy] activated $RELEASE_TAG renderer=$LOCAL_HASH mode=$RENDERER_MODE"
