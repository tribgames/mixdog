# Power-cut harness image (see run.sh). Build context: native/core. From the repo root:
#   docker build -f native/core/crates/mixdog-store/powercut/Dockerfile -t mixdog-powercut native/core
#   docker run --rm --privileged mixdog-powercut [batches]
# The host kernel must provide the dm-log-writes target (`modprobe dm-log-writes`).
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release -p mixdog-store --example powercut \
 && cp target/release/examples/powercut /usr/local/bin/powercut

FROM debian:bookworm AS replay
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
 && git clone --depth 1 https://git.kernel.org/pub/scm/fs/xfs/xfstests-dev.git /xfstests \
 && cd /xfstests/src/log-writes \
 && gcc -O2 -o /usr/local/bin/replay-log replay-log.c log-writes.c

FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs dmsetup util-linux mawk \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/powercut /usr/local/bin/powercut
COPY --from=replay /usr/local/bin/replay-log /usr/local/bin/replay-log
COPY crates/mixdog-store/powercut/run.sh /usr/local/bin/run.sh
ENTRYPOINT ["bash", "/usr/local/bin/run.sh"]
