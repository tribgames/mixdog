#!/bin/sh
# One command for the Linux run of the process-tree helper: builds it and runs process-tree.test.mjs inside a container.
#   sh scripts/rust-core/run-linux-tests.sh
# The repository is mounted read-only at /repo; the build output and a writable copy of the scripts live in the container's
# own /work (a tmpfs-free anonymous volume), so nothing is written to the checkout. Exit status is the test run's.
# Needs: a running Docker; pulls the stock images node:22-bookworm and rust:1.99.1-bookworm (about 1.5 GB) on the first run.
# Expect about 3-5 minutes (the helper builds in about a minute; the tests take about two) and under 1.5 GB of memory.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
image=mixdog-k1-linux-test
docker build -q -t "$image" -f "$here/linux-test.Dockerfile" "$here"
docker run --rm --memory 2g -v "$repo:/repo:ro" "$image" sh -c '
  set -eu
  mkdir -p /work && cp -r /repo/scripts /work/scripts
  cd /work
  export CARGO_TARGET_DIR=/work/tree-helper-target
  cargo build --release --locked --manifest-path scripts/rust-core/tree-helper/Cargo.toml
  cargo test --release --locked --manifest-path scripts/rust-core/tree-helper/Cargo.toml
  export MIXDOG_TREE_HELPER=$CARGO_TARGET_DIR/release/treerun
  node --test --test-concurrency=1 scripts/rust-core/process-tree.test.mjs
'