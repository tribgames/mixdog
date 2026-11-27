#!/bin/bash
# Runs inside quay.io/pypa/manylinux_2_28_<arch> (glibc 2.28) with the repo at /w, once per Linux leg of
# .github/workflows/mixdogd-build.yml (the only caller). Builds every program of the leg for the host arch into /w/out, in
# one container and one target directory so the crates they share compile once:
#   mixdogd (mixdog-cli) and mixdog-askpass   the core and its ssh helper (the desktop packages and the npm package)
#   mixdog (mixdog-entry)                      the terminal program (the npm package)
#   mixdog-relay                               only with MIXDOG_BUILD_RELAY=1 (the web relay the production box runs)
# so the packaged app's glibc floor is 2.28 instead of the CI runner's glibc. The Google OAuth client secrets, when the
# caller passes them, are read by the crate's build script; the relay is built without them.
# Each program has a cargo invocation of its own, so the features a binary is built with are the ones it always had; the
# workspace-hack crate keeps the shared dependencies' features equal, so the second and third build reuse them.
# The registry and git directories of cargo may be mounted at /root/.cargo/registry and /root/.cargo/git; they are made
# readable by the runner user before the container ends.
set -euo pipefail
dnf install -y cmake pkgconf-pkg-config
curl -fsSL -o /tmp/rustup-init.sh https://sh.rustup.rs
sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.99.1
export PATH=$HOME/.cargo/bin:$PATH
export RUSTFLAGS="-C link-arg=-Wl,--build-id=sha1"
export CARGO_TARGET_DIR=/tmp/target
# The project's own machine mounts a build folder it keeps at /tmp/target and names what that folder was built of (the
# image, the third-party packages, this script): with another name nothing in it is read again, so it is emptied here,
# where its files are this user's.
if [ -n "${MIXDOG_BUILD_STAMP:-}" ]; then
	if [ "$(cat /tmp/target/.build-stamp 2>/dev/null)" != "$MIXDOG_BUILD_STAMP" ]; then find /tmp/target -mindepth 1 -delete; fi
	printf '%s' "$MIXDOG_BUILD_STAMP" >/tmp/target/.build-stamp
fi
# The prebuilt static libvpx is published per Ubuntu release, which this container is not: the oldest one is named.
# A symbol it needed past glibc 2.28 would fail the link here.
case "$(uname -m)" in
x86_64) export LIBVPX_TARGET=ubuntu-22.04_x86_64 ;;
aarch64) export LIBVPX_TARGET=ubuntu-22.04_arm64 ;;
esac
# CI leaves both unset. scripts/deploy-remote.ps1 -LocalRelayBuild sets MIXDOG_OUT_DIR (so the repo mounts read-only)
# and MIXDOG_RELAY_ONLY=1 (it ships nothing but the relay, so the core and the terminal program are not compiled).
out=${MIXDOG_OUT_DIR:-/w/out}
mkdir -p "$out"
manifest=/w/native/core/Cargo.toml
if [ "${MIXDOG_RELAY_ONLY:-}" != "1" ]; then
	cargo build --locked --release --manifest-path "$manifest" -p mixdog-cli --bin mixdogd -p mixdog-askpass --bin mixdog-askpass
	cargo build --locked --release --manifest-path "$manifest" -p mixdog-entry --bin mixdog
	cargo build --locked --release --manifest-path /w/scripts/rust-core/tree-helper/Cargo.toml
	cp /tmp/target/release/mixdogd /tmp/target/release/mixdog-askpass /tmp/target/release/mixdog /tmp/target/release/treerun "$out/"
fi
if [ "${MIXDOG_BUILD_RELAY:-}" = "1" ]; then
	env -u MIXDOG_GOOGLE_OAUTH_CLIENT_ID -u MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET \
		cargo build --locked --release --manifest-path "$manifest" -p mixdog-relay --bin mixdog-relay
	cp /tmp/target/release/mixdog-relay "$out/"
fi
# The cache directories belong to root here; the runner user saves them.
chmod -R a+rwX /root/.cargo/registry /root/.cargo/git 2>/dev/null || true
ls -l "$out"
