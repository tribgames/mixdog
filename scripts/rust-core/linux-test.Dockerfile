# The Linux test image: stock Rust 1.99.1 (rust-toolchain.toml) with Node 22 (the workflow's node-version) copied from the
# stock node image. Built and used by run-linux-tests.sh; nothing is installed from a package manager.
FROM node:22-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f AS node
FROM rust:1.99.1-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c
COPY --from=node /usr/local/bin/node /usr/local/bin/node