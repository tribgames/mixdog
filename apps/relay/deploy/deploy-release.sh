#!/usr/bin/env bash
set -Eeuo pipefail

DOMAIN="${1:?usage: deploy-release.sh <relay-domain> <release-tag> [desktop-version] [android-url]}"
RELEASE_TAG="${2:?usage: deploy-release.sh <relay-domain> <release-tag> [desktop-version] [android-url]}"
# The desktop build the uploaded renderer belongs to. It names the renderer as
# an ADDITIONAL side-by-side release; a relay-only deploy (renderer reused)
# passes none and registers nothing new.
DESKTOP_VERSION="${3:-}"
# The Android release the /app install page links (the relay reads it from
# mobile-release.json at startup). Deploy passes the newest release whose
# APK it verified downloadable; without one the installed link is kept.
ANDROID_URL="${4:-}"
DATA_DIR=/var/lib/mixdog-relay
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ -z "$DESKTOP_VERSION" || "$DESKTOP_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$ ]]
[[ -z "$ANDROID_URL" || "$ANDROID_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases$ || "$ANDROID_URL" =~ ^https://github\.com/tribgames/mixdog/releases/download/mobile-v[0-9]+\.[0-9]+\.[0-9]+/[A-Za-z0-9_.-]+\.apk$ ]]
[[ "$(id -u)" = 0 ]]

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR=/opt/mixdog-relay
# Where the unit must find the binary, and the drop-in that points a unit still
# running the previous (Node) release at it (release-transaction.sh).
RELAY_BINARY="$INSTALL_DIR/mixdog-relay"
EXEC_DROPIN=/etc/systemd/system/mixdog-relay.service.d/exec.conf
# The previous release when it was a Node tree: kept for a manual return, never
# touched by the cleanup globs below.
HANDOVER_DIR=/opt/mixdog-relay.handover
NEXT_DIR="/opt/mixdog-relay.next-${RELEASE_TAG}"
BACKUP_DIR="/opt/mixdog-relay.backup-${RELEASE_TAG}"
LOCK_FILE=/run/mixdog-relay-deploy.lock
RENDERER_MODE="reused"
RENDERER_DELTA_DIR="$SRC_DIR/.cache/renderer-delta"
RENDERER_MANIFEST="$SRC_DIR/.cache/renderer-manifest.json"
if [[ -d "$RENDERER_DELTA_DIR" && -f "$RENDERER_MANIFEST" ]]; then
	# Provenance, not just presence: a delta reconstructs its release only on top
	# of the exact installed tree it was computed from. The manifest records that
	# base and `mixdog-relay renderer-delta --action=apply` refuses any other tree, so a
	# cache left over from an earlier release can no longer rebuild stale content
	# that then passes the post-swap hash check (taken from the same rebuild).
	# The manifest is the tool's own pretty JSON: its top-level "base" is the only
	# key of that name indented by exactly two spaces.
	RENDERER_BASE="$(sed -n 's/^  "base": "\([0-9a-f]\{64\}\)"$/\1/p' "$RENDERER_MANIFEST")"
	if [[ "$RENDERER_BASE" =~ ^[0-9a-f]{64}$ ]]; then
		RENDERER_MODE="delta"
	elif [[ -f "$SRC_DIR/renderer/index.html" ]]; then
		# An unusable cache never outranks renderer content that IS in this upload.
		echo "[deploy] ignoring cached renderer delta without base provenance; deploying the full renderer from this upload" >&2
		RENDERER_MODE="full"
	else
		echo "[deploy] cached renderer delta at $RENDERER_DELTA_DIR has no base provenance, and this upload carries no renderer/." >&2
		echo "[deploy] fix: rm -rf '$SRC_DIR/.cache' and re-run to keep the installed renderer, or rebuild the delta:" >&2
		echo "[deploy]   '$SRC_DIR/mixdog-relay' renderer-delta --action=create --root=<renderer> --base=<installed manifest> --delta='$RENDERER_DELTA_DIR' --manifest='$RENDERER_MANIFEST'" >&2
		exit 1
	fi
elif [[ -f "$SRC_DIR/renderer/index.html" ]]; then
	RENDERER_MODE="full"
fi
# shellcheck source-path=SCRIPTDIR
# shellcheck source=release-transaction.sh
source "$SRC_DIR/deploy/release-transaction.sh"

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

# Host tuning reports its own gaps; it never holds back a release.
bash "$SRC_DIR/deploy/conntrack.sh" apply || echo "[conntrack] warning: conntrack.sh exited $?; the release continues" >&2

test -d "$INSTALL_DIR"
test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
rm -rf "$NEXT_DIR" "$BACKUP_DIR"
arm_release_transaction
mkdir -p "$NEXT_DIR"
if [[ -f "$SRC_DIR/mixdog-relay" ]]; then
	install -m 0755 -o root -g root "$SRC_DIR/mixdog-relay" "$NEXT_DIR/mixdog-relay"
elif [[ -x "$RELAY_BINARY" ]]; then
	# An upload without a binary is a renderer-only deploy: the installed relay stays.
	install -m 0755 -o root -g root "$RELAY_BINARY" "$NEXT_DIR/mixdog-relay"
else
	echo "[deploy] the upload carries no mixdog-relay binary and $INSTALL_DIR has none to keep" >&2
	exit 1
fi
cp -r "$SRC_DIR/deploy" "$NEXT_DIR/"
if [[ -n "$ANDROID_URL" ]]; then
	# The pattern above admits no character that needs JSON escaping.
	printf '{"androidUrl":"%s"}\n' "$ANDROID_URL" >"$NEXT_DIR/mobile-release.json"
elif [[ -f "$INSTALL_DIR/mobile-release.json" ]]; then
	cp "$INSTALL_DIR/mobile-release.json" "$NEXT_DIR/"
fi
if [[ "$RENDERER_MODE" = "delta" ]]; then
	"$NEXT_DIR/mixdog-relay" renderer-delta --action=apply \
		"--base=$INSTALL_DIR/renderer" \
		"--delta=$RENDERER_DELTA_DIR" \
		"--manifest=$RENDERER_MANIFEST" \
		"--output=$NEXT_DIR/renderer" \
		--hardlink-base
elif [[ "$RENDERER_MODE" = "full" ]]; then
	cp -r "$SRC_DIR/renderer" "$NEXT_DIR/"
else
	test -f "$INSTALL_DIR/renderer/index.html"
	cp -al "$INSTALL_DIR/renderer" "$NEXT_DIR/"
fi
LOCAL_HASH="$(sha256sum "$NEXT_DIR/renderer/index.html" | awk '{print $1}')"

# Side-by-side renderer releases. The installed registry is hardlinked into the
# staged tree, the new renderer is added as one more release (never replacing
# the others), and releases past the retention rule are collected — all inside
# NEXT_DIR, so the swap below stays the single atomic step and rollback restores
# the previous registry along with the previous install.
if [[ "$RENDERER_MODE" != "reused" && -z "$DESKTOP_VERSION" ]]; then
	echo "[deploy] a renderer deploy needs the desktop version: deploy-release.sh <domain> <tag> <desktop-version>" >&2
	exit 1
fi
RELEASES_DIR="$NEXT_DIR/renderer-releases"
mkdir -p "$RELEASES_DIR"
if [[ -d "$INSTALL_DIR/renderer-releases" ]]; then
	cp -al "$INSTALL_DIR/renderer-releases/." "$RELEASES_DIR/"
fi
LEGACY_ARGS=()
if [[ ! -f "$INSTALL_DIR/renderer-releases/index.json" && -f "$INSTALL_DIR/renderer/index.html" ]]; then
	# The renderer serving today becomes the `legacy` release.
	LEGACY_ARGS=("--legacy=$INSTALL_DIR/renderer")
fi
RELEASE_RESULT="$("$NEXT_DIR/mixdog-relay" renderer-releases --action=prepare \
	"--releases=$RELEASES_DIR" "--renderer=$NEXT_DIR/renderer" \
	"--desktop-version=$DESKTOP_VERSION" "--devices=$DATA_DIR/devices.json" \
	${LEGACY_ARGS[@]+"${LEGACY_ARGS[@]}"})"
# The tool prints one JSON line; a release id holds no quote or escape.
RELEASE_ID="$(sed -n 's/.*[{,]"releaseId":"\([^"\\]*\)".*/\1/p' <<<"$RELEASE_RESULT")"
echo "[deploy] renderer releases: $RELEASE_RESULT"

activate_release

# Verification runs the installed binary, the one this service runs. Failure is
# still inside the rollback transaction: a listening process alone is not a
# usable web deployment.
systemctl is-active --quiet mixdog-relay
test "$(sha256sum "$INSTALL_DIR/renderer/index.html" | awk '{print $1}')" = "$LOCAL_HASH"
"$RELAY_BINARY" verify-release \
	"--origin=https://$DOMAIN" "--address=127.0.0.1" "--expected-index=$LOCAL_HASH" \
	"--expected-release=$RELEASE_ID"

commit_release_transaction
if [[ -f "$BACKUP_DIR/server.mjs" ]]; then
	# The first switch: the Node tree stays as the handover copy.
	rm -rf "$HANDOVER_DIR"
	mv "$BACKUP_DIR" "$HANDOVER_DIR"
else
	rm -rf "$BACKUP_DIR"
fi
cleanup_stale_releases
echo "[deploy] activated $RELEASE_TAG renderer=$LOCAL_HASH release=${RELEASE_ID:-none} mode=$RENDERER_MODE"
