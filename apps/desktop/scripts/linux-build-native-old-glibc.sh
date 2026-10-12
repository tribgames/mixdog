#!/bin/bash
# Runs inside quay.io/pypa/manylinux_2_28_<arch> (glibc 2.28) with the repo at /w.
# Builds the glibc-linked native tools for the host arch into /w/native-out so
# the packaged app's floor is 2.28 instead of the CI runner's glibc.
set -euo pipefail
dnf install -y cmake pkgconf-pkg-config
curl -fsSL -o /tmp/rustup-init.sh https://sh.rustup.rs
sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.95.0
export PATH=$HOME/.cargo/bin:$PATH
export RUSTFLAGS="-C link-arg=-Wl,--build-id=sha1"
mkdir -p /w/native-out
for tool in computer graph patch; do
  CARGO_TARGET_DIR=/tmp/target-$tool cargo build --locked --release --manifest-path /w/native/mixdog-$tool/Cargo.toml
  cp /tmp/target-$tool/release/mixdog-$tool /w/native-out/
done
ls -l /w/native-out
