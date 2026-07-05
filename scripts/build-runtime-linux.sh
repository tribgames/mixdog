#!/usr/bin/env bash
# build-runtime-linux.sh — Build self-contained PostgreSQL 16 + pgvector runtime on Linux.
# Designed to run inside ubuntu:20.04 container (glibc 2.31 floor) so produced
# binaries run on every distro from Ubuntu 20.04 / Debian 11 / RHEL 8 forward.
# Targets the runner's native arch (x64 or arm64).
# Produces: dist/mixdog-runtime-linux-{arch}-pg{pgver}-pgvector{vecver}.tar.gz
# Bundles foreign dyn deps via ldd transitive closure (binaries + ALL extension
# modules under lib/postgresql/) + patchelf rpath rewrite. Final smoke: initdb,
# pg_ctl start, CREATE EXTENSION vector, distance query, stop.

set -euo pipefail

PG_VERSION="16.4"
PGVECTOR_VERSION="0.8.2"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-x64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/runtime-linux-$TARGET_ARCH"
STAGE_DIR="$BUILD_DIR/stage"
DIST_DIR="$ROOT_DIR/dist"
RUNTIME_DIR="$BUILD_DIR/runtime"

OUTPUT_NAME="mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

mkdir -p "$BUILD_DIR" "$STAGE_DIR" "$DIST_DIR" "$RUNTIME_DIR"/{bin,lib,share}

# ---------------------------------------------------------------------------
# Build deps. SUDO=sudo iff non-root; inside ubuntu:20.04 container we are root.
# ---------------------------------------------------------------------------
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo"; fi
# Export rather than inline-assign before $SUDO: when SUDO is empty (root),
# `$SUDO DEBIAN_FRONTEND=... apt-get` would parse the env-assignment as a
# command name and fail with "command not found".
export DEBIAN_FRONTEND=noninteractive

echo "==> Installing build dependencies"
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends \
  build-essential libreadline-dev zlib1g-dev libssl-dev \
  libicu-dev libxml2-dev libzstd-dev liblz4-dev \
  pkg-config curl git ca-certificates patchelf file \
  bsdmainutils

if [[ -x "$STAGE_DIR/bin/postgres" ]]; then
  echo "==> Cache hit: PG already built at $STAGE_DIR — skipping configure/make"
  unset TARGET_OS TARGET_ARCH
else
  echo "==> Downloading PostgreSQL $PG_VERSION source"
  cd "$BUILD_DIR"
  if [[ ! -f "postgresql-${PG_VERSION}.tar.gz" ]]; then
    curl -fsSL "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.gz" \
      -o "postgresql-${PG_VERSION}.tar.gz"
  fi
  rm -rf "postgresql-${PG_VERSION}"
  tar xzf "postgresql-${PG_VERSION}.tar.gz"

  echo "==> Configuring PostgreSQL"
  cd "postgresql-${PG_VERSION}"
  ./configure \
    --prefix="$STAGE_DIR" \
    --without-perl \
    --without-python \
    --without-tcl \
    --with-openssl \
    --with-libxml \
    --with-icu \
    --with-readline \
    --enable-thread-safety \
    CFLAGS="-O2"

  echo "==> Building PostgreSQL"
  # PG Makefile.global has its own TARGET_ARCH var; env-passed TARGET_ARCH=x64
  # would collide as a make-variable override and leak into compile commands.
  unset TARGET_OS TARGET_ARCH
  make -j"$(nproc)"
  make install
  make -C contrib/pgcrypto install
fi

PG_CONFIG="$STAGE_DIR/bin/pg_config"
export PATH="$STAGE_DIR/bin:$PATH"

echo "==> Stripping PostgreSQL binaries"
find "$STAGE_DIR" -name '*.so*' -type f -exec strip --strip-debug {} \; 2>/dev/null || true
find "$STAGE_DIR/bin" -type f -exec strip --strip-all {} \; 2>/dev/null || true

if [[ -f "$STAGE_DIR/lib/postgresql/vector.so" ]]; then
  echo "==> Cache hit: pgvector already installed — skipping clone/build"
else
  echo "==> Cloning pgvector $PGVECTOR_VERSION"
  cd "$BUILD_DIR"
  rm -rf pgvector
  git clone --branch "v${PGVECTOR_VERSION}" --depth 1 \
    https://github.com/pgvector/pgvector.git pgvector

  echo "==> Building pgvector"
  cd pgvector
  make PG_CONFIG="$PG_CONFIG" -j"$(nproc)"
  make PG_CONFIG="$PG_CONFIG" install
fi

echo "==> Assembling runtime layout"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"/{bin,lib,share}
cp -a "$STAGE_DIR/bin/postgres"   "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_ctl"     "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_dump"    "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/pg_restore" "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/psql"       "$RUNTIME_DIR/bin/"
cp -a "$STAGE_DIR/bin/initdb"     "$RUNTIME_DIR/bin/"

cp -a "$STAGE_DIR/lib"/.   "$RUNTIME_DIR/lib/"   2>/dev/null || true
cp -a "$STAGE_DIR/share"/. "$RUNTIME_DIR/share/" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Bundle foreign dyn deps — seed from binaries AND every extension module
# under lib/postgresql/. dlopen-loaded modules (extensions) need the same
# treatment as direct binary deps; missing them = runtime "ERROR: could not
# load library" on CREATE EXTENSION.
# ---------------------------------------------------------------------------
echo "==> Bundling foreign dynamic dependencies (binaries + extensions)"

KEEP_RE='^(linux-vdso|ld-linux|libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libnsl\.so|libresolv\.so)'

collect_deps() {
  ldd "$1" 2>/dev/null \
    | awk '/=>/{print $3}' \
    | grep -E '^/' \
    | while read -r path; do
        bn=$(basename "$path")
        if echo "$bn" | grep -Eq "$KEEP_RE"; then
          continue  # system lib — keep on host
        fi
        echo "$path"
      done \
    | sort -u
}

declare -A SEEN
declare -a QUEUE
# Seeds: binaries + every .so under lib/postgresql/ (extensions, contrib mods).
for seed in "$RUNTIME_DIR/bin/postgres" "$RUNTIME_DIR/bin/psql" \
            "$RUNTIME_DIR/bin/pg_ctl"; do
  [[ -f "$seed" ]] && QUEUE+=("$seed")
done
while IFS= read -r -d '' ext; do
  QUEUE+=("$ext")
done < <(find "$RUNTIME_DIR/lib/postgresql" -name '*.so' -print0 2>/dev/null)

declare -a FOREIGN
while [[ ${#QUEUE[@]} -gt 0 ]]; do
  current="${QUEUE[0]}"
  QUEUE=("${QUEUE[@]:1}")
  while IFS= read -r dep; do
    real="$(readlink -f "$dep")"
    [[ -n "${SEEN[$real]+x}" ]] && continue
    SEEN[$real]=1
    FOREIGN+=("$dep")
    QUEUE+=("$dep")
  done < <(collect_deps "$current")
done

# Sanity: glibc / loader must never be bundled — if KEEP_RE regresses this catches it.
if find "$RUNTIME_DIR/lib" -maxdepth 1 \
     \( -name 'libc.so*' -o -name 'ld-linux*' -o -name 'libpthread.so*' \) \
   | grep -q .; then
  echo "FATAL: bundled glibc/loader detected — KEEP_RE filter did not work"
  exit 1
fi

echo "  bundling ${#FOREIGN[@]} foreign libraries"
for so_path in "${FOREIGN[@]}"; do
  real_path="$(readlink -f "$so_path")"
  real_name="$(basename "$real_path")"
  if [[ ! -f "$RUNTIME_DIR/lib/$real_name" ]]; then
    cp -L "$real_path" "$RUNTIME_DIR/lib/$real_name"
    chmod u+w "$RUNTIME_DIR/lib/$real_name"
    echo "    + $real_name"
  fi
  link="$so_path"
  while [[ -L "$link" ]]; do
    link_name="$(basename "$link")"
    link_target="$(readlink "$link")"
    if [[ ! -e "$RUNTIME_DIR/lib/$link_name" ]]; then
      ln -sf "$(basename "$link_target")" "$RUNTIME_DIR/lib/$link_name"
    fi
    link="$(dirname "$link")/$link_target"
  done
done

echo "==> Stripping static archives from lib/"
find "$RUNTIME_DIR/lib" -name '*.a' -delete

echo "==> Patching rpath"
# Binaries: $ORIGIN/../lib (from bin/ to lib/)
find "$RUNTIME_DIR/bin" -type f -executable | while read -r bin; do
  if file "$bin" 2>/dev/null | grep -q ELF; then
    patchelf --set-rpath '$ORIGIN/../lib' "$bin" 2>/dev/null || true
  fi
done
# Top-level lib/*.so*: $ORIGIN
find "$RUNTIME_DIR/lib" -maxdepth 1 -type f -name '*.so*' | while read -r so; do
  if file "$so" 2>/dev/null | grep -q ELF; then
    patchelf --set-rpath '$ORIGIN' "$so" 2>/dev/null || true
  fi
done
# Every extension module under lib/postgresql/: $ORIGIN/.. (=lib/) and $ORIGIN/../.. (=runtime root)
find "$RUNTIME_DIR/lib/postgresql" -name '*.so' 2>/dev/null | while read -r ext; do
  if file "$ext" 2>/dev/null | grep -q ELF; then
    patchelf --set-rpath '$ORIGIN/..:$ORIGIN/../..' "$ext" 2>/dev/null || true
  fi
done

# ---------------------------------------------------------------------------
# Self-contained smoke — full PG lifecycle, not just --version
# ---------------------------------------------------------------------------
echo "==> Self-contained smoke test (initdb + CREATE EXTENSION vector + distance query)"
unset LD_LIBRARY_PATH
SMOKE_DATA="$BUILD_DIR/smoke-pgdata"
SMOKE_LOG="$BUILD_DIR/smoke-pg.log"
SMOKE_PORT=55899

# PG initdb refuses to run as root. Inside ubuntu:20.04 container we are root,
# so create an unprivileged user and run the smoke under it.
if [[ "$(id -u)" -eq 0 ]]; then
  if ! id pguser >/dev/null 2>&1; then useradd -m -s /bin/bash pguser; fi
  chown -R pguser:pguser "$BUILD_DIR"
  RUN_AS=(runuser -u pguser --)
else
  RUN_AS=()
fi

"${RUN_AS[@]}" "$RUNTIME_DIR/bin/postgres" --version || { echo "FAIL: postgres --version"; exit 1; }
MISSING="$(ldd "$RUNTIME_DIR/bin/postgres" 2>&1 | grep 'not found' || true)"
if [[ -n "$MISSING" ]]; then echo "FAIL: missing deps in postgres:"; echo "$MISSING"; exit 1; fi

SMOKE_OK=""
for attempt in 1 2 3; do
  echo "==> Self-contained smoke (attempt $attempt/3)"
  rm -rf "$SMOKE_DATA"
  set +e
  (
    set -e
    "${RUN_AS[@]}" "$RUNTIME_DIR/bin/initdb" -D "$SMOKE_DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
    "${RUN_AS[@]}" "$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -o "-p $SMOKE_PORT -h 127.0.0.1" -l "$SMOKE_LOG" -w start
    "${RUN_AS[@]}" "$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
    EXTV="$("${RUN_AS[@]}" "$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
    DIST="$("${RUN_AS[@]}" "$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;")"
    echo "  vector extension version: $EXTV"
    echo "  distance query result:    $DIST"
    [[ "$EXTV" == "$PGVECTOR_VERSION" ]] || { echo "FAIL: extversion=$EXTV expected=$PGVECTOR_VERSION"; exit 1; }
    "${RUN_AS[@]}" "$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m fast stop > /dev/null
  )
  attempt_rc=$?
  set -e
  if [[ $attempt_rc -eq 0 ]]; then
    rm -rf "$SMOKE_DATA"
    echo "  PASS smoke (extension load + vector distance)"
    SMOKE_OK=1
    break
  fi
  echo "  attempt $attempt failed (rc=$attempt_rc) — cleaning up"
  echo "  -- last 20 lines of $SMOKE_LOG --"
  tail -20 "$SMOKE_LOG" 2>/dev/null || true
  "${RUN_AS[@]}" "$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m immediate stop > /dev/null 2>&1 || true
  pkill -f "$RUNTIME_DIR/bin/postgres" > /dev/null 2>&1 || true
  rm -rf "$SMOKE_DATA"
done
if [[ -z "${SMOKE_OK:-}" ]]; then
  echo "FAIL: smoke failed all 3 attempts"
  exit 1
fi

# Licenses
curl -fsSL "https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/COPYRIGHT" \
  -o "$RUNTIME_DIR/LICENSE.postgresql"
cp "$BUILD_DIR/pgvector/LICENSE" "$RUNTIME_DIR/LICENSE.pgvector"

echo "==> Creating tarball: $OUTPUT_NAME"
tar czf "$DIST_DIR/$OUTPUT_NAME" -C "$RUNTIME_DIR" .

echo "==> Generating sha256 sidecar"
cd "$DIST_DIR"
sha256sum "$OUTPUT_NAME" > "${OUTPUT_NAME}.sha256"

# ---------------------------------------------------------------------------
# Phase A: Re-smoke from EXTRACTED tarball with hostile env. Catches false-pass
# where the build host happens to satisfy a dep that the tarball is missing.
# Uses `env -i` to clear all variables, minimal PATH, fresh data dir.
# ---------------------------------------------------------------------------
echo "==> Re-smoke from extracted tarball (hostile env, verify self-contained)"
EXTRACT_DIR="$BUILD_DIR/extract-smoke"
rm -rf "$EXTRACT_DIR"; mkdir -p "$EXTRACT_DIR"
tar xzf "$DIST_DIR/$OUTPUT_NAME" -C "$EXTRACT_DIR"
if [[ "$(id -u)" -eq 0 ]]; then chown -R pguser:pguser "$EXTRACT_DIR"; fi
EXTRACT_DATA="$EXTRACT_DIR/extract-pgdata"
EXTRACT_LOG="$EXTRACT_DIR/extract-pg.log"
EXTRACT_PORT=55898

"${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/postgres" --version

EXTRACT_SMOKE_OK=""
for attempt in 1 2 3; do
  echo "==> Re-smoke from extracted tarball (attempt $attempt/3)"
  rm -rf "$EXTRACT_DATA"
  set +e
  (
    set -e
    "${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
      "$EXTRACT_DIR/bin/initdb" -D "$EXTRACT_DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
    "${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
      "$EXTRACT_DIR/bin/pg_ctl" -D "$EXTRACT_DATA" -o "-p $EXTRACT_PORT -h 127.0.0.1" -l "$EXTRACT_LOG" -w start
    "${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
      "$EXTRACT_DIR/bin/psql" -h 127.0.0.1 -p "$EXTRACT_PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
    EXTV2="$("${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
      "$EXTRACT_DIR/bin/psql" -h 127.0.0.1 -p "$EXTRACT_PORT" -U postgres -d postgres -tAc \
      "SELECT extversion FROM pg_extension WHERE extname='vector';")"
    [[ "$EXTV2" == "$PGVECTOR_VERSION" ]] || { echo "FAIL: extracted-smoke extversion=$EXTV2"; exit 1; }
    "${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
      "$EXTRACT_DIR/bin/pg_ctl" -D "$EXTRACT_DATA" -m fast stop > /dev/null
  )
  attempt_rc=$?
  set -e
  if [[ $attempt_rc -eq 0 ]]; then
    rm -rf "$EXTRACT_DIR"
    echo "  PASS extracted-tarball smoke"
    EXTRACT_SMOKE_OK=1
    break
  fi
  echo "  attempt $attempt failed (rc=$attempt_rc) — cleaning up"
  echo "  -- last 20 lines of $EXTRACT_LOG --"
  tail -20 "$EXTRACT_LOG" 2>/dev/null || true
  "${RUN_AS[@]}" env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
    "$EXTRACT_DIR/bin/pg_ctl" -D "$EXTRACT_DATA" -m immediate stop > /dev/null 2>&1 || true
  pkill -f "$EXTRACT_DIR/bin/postgres" > /dev/null 2>&1 || true
  rm -rf "$EXTRACT_DATA"
done
if [[ -z "${EXTRACT_SMOKE_OK:-}" ]]; then
  echo "FAIL: extracted-tarball smoke failed all 3 attempts"
  exit 1
fi

echo "==> Done: $DIST_DIR/$OUTPUT_NAME"
ls -lh "$DIST_DIR/$OUTPUT_NAME"
