#!/bin/bash
# Runs inside quay.io/pypa/manylinux_2_28_<arch> (glibc 2.28) with the repo at /w.
# Builds mixdogd (mixdog-cli) for the host arch into /w/out/mixdogd, so the packaged
# app's glibc floor is 2.28 instead of the CI runner's glibc. The Google OAuth client
# secrets, when the caller passes them, are read by the crate's build script.
set -euo pipefail
dnf install -y cmake pkgconf-pkg-config
curl -fsSL -o /tmp/rustup-init.sh https://sh.rustup.rs
sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.99.1
export PATH=$HOME/.cargo/bin:$PATH
export RUSTFLAGS="-C link-arg=-Wl,--build-id=sha1"
mkdir -p /w/out
CARGO_TARGET_DIR=/tmp/target-core cargo build --locked --release --manifest-path /w/native/core/Cargo.toml -p mixdog-cli --bin mixdogd
cp /tmp/target-core/release/mixdogd /w/out/
ls -l /w/out