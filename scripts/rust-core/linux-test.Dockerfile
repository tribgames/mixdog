# The Linux test image: stock Rust 1.99.1 (rust-toolchain.toml) with Node 22 (the workflow's node-version) copied from the
# stock node image. Built and used by run-linux-tests.sh; nothing is installed from a package manager.
FROM node:22-bookworm AS node
FROM rust:1.99.1-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node