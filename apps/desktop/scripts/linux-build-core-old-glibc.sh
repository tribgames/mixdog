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
# With /usr/local/bin/sccache mounted (a static binary) and its cache variables passed, compiled crates are cached
# across runs; without it the build is the same, only slower. The registry and git directories of cargo may be mounted at
# /root/.cargo/registry and /root/.cargo/git; they are made readable by the runner user before the container ends.
set -euo pipefail
dnf install -y cmake pkgconf-pkg-config
curl -fsSL -o /tmp/rustup-init.sh https://sh.rustup.rs
sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.99.1
export PATH=$HOME/.cargo/bin:$PATH
export RUSTFLAGS="-C link-arg=-Wl,--build-id=sha1"
export CARGO_TARGET_DIR=/tmp/target
if [ -x /usr/local/bin/sccache ] && /usr/local/bin/sccache --version; then
  export RUSTC_WRAPPER=/usr/local/bin/sccache
else
  echo "::warning::sccache is not available in the container: the build runs uncached"
fi
mkdir -p /w/out
manifest=/w/native/core/Cargo.toml
cargo build --locked --release --manifest-path "$manifest" -p mixdog-cli --bin mixdogd -p mixdog-askpass --bin mixdog-askpass
cargo build --locked --release --manifest-path "$manifest" -p mixdog-entry --bin mixdog
cp /tmp/target/release/mixdogd /tmp/target/release/mixdog-askpass /tmp/target/release/mixdog /w/out/
if [ "${MIXDOG_BUILD_RELAY:-}" = "1" ]; then
  env -u MIXDOG_GOOGLE_OAUTH_CLIENT_ID -u MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET \
    cargo build --locked --release --manifest-path "$manifest" -p mixdog-relay --bin mixdog-relay
  cp /tmp/target/release/mixdog-relay /w/out/
fi
if [ -n "${RUSTC_WRAPPER:-}" ]; then "$RUSTC_WRAPPER" --show-stats || true; fi
# The cache directories belong to root here; the runner user saves them.
chmod -R a+rwX /root/.cargo/registry /root/.cargo/git 2>/dev/null || true
ls -l /w/out
