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
# MIXDOG_NATIVE_TOOLS (space separated) limits the build to the tools whose
# cache missed; the tools are independent crates, each with its own target dir,
# so they build concurrently and every PID is waited on.
tools=${MIXDOG_NATIVE_TOOLS:-computer graph patch}
pids=()
for tool in $tools; do
	(
		CARGO_TARGET_DIR=/tmp/target-$tool cargo build --locked --release --manifest-path /w/native/mixdog-$tool/Cargo.toml
		cp /tmp/target-$tool/release/mixdog-$tool /w/native-out/
	) &
	pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do
	wait "$pid" || status=1
done
if [ "$status" -ne 0 ]; then
	echo "native tool build failed" >&2
	exit 1
fi
ls -l /w/native-out
