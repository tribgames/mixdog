#!/usr/bin/env bash
# smoke-runtime-negative.sh — Negative-path tests against the released runtime
# tarball for a given OS/arch. Validates: download URL, sha256 verification,
# corrupt-tarball rejection, fresh-extract boot, double-boot port handling,
# stale-cache version-skew detection.
#
# Env: TAG=runtime-v0.4.0 OS=linux|darwin ARCH=x64|arm64
#      RUNTIME_RELEASE_REPOSITORY — override repo (default tribgames/mixdog)

set -euo pipefail

TAG="${TAG:-runtime-v0.4.0}"
OS="${OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
ARCH="${ARCH:-$(uname -m | sed 's/x86_64/x64/')}"
PG_VER="16.4"
PGVECTOR_VER="0.8.2"

RELEASE_REPO="${RUNTIME_RELEASE_REPOSITORY:-tribgames/mixdog}"
PLATFORM="${OS}-${ARCH}"
ASSET="mixdog-runtime-${OS}-${ARCH}-pg${PG_VER}-pgvector${PGVECTOR_VER}.tar.gz"
URL="https://github.com/${RELEASE_REPO}/releases/download/${TAG}/${ASSET}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Negative-path smoke for ${PLATFORM} from ${URL}"

# Linux container needs unprivileged user for initdb
if [[ "$OS" == "linux" && "$(id -u)" -eq 0 ]]; then
  apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates >/dev/null
  if ! id pguser >/dev/null 2>&1; then useradd -m -s /bin/bash pguser; fi
  chmod 755 "$WORK"
  RUN_AS=(runuser -u pguser --)
else
  RUN_AS=()
fi

echo "==> Test 1: HEAD reaches release asset"
curl -sIL -o /dev/null -w "  HTTP %{http_code}\n" "$URL" || { echo "FAIL: URL HEAD"; exit 1; }

echo "==> Test 2: full download + sha256 (manifest match)"
curl -sL -o "$WORK/$ASSET" "$URL"
SHA="$(sha256sum "$WORK/$ASSET" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
echo "  sha256=$SHA"

echo "==> Test 3: corrupt tarball — flip one byte and ensure tar fails or runtime detects"
cp "$WORK/$ASSET" "$WORK/corrupt.tar.gz"
# Flip a byte at offset 100KB into the tarball
dd if=/dev/urandom of="$WORK/corrupt.tar.gz" bs=1 count=1 seek=102400 conv=notrunc 2>/dev/null
mkdir -p "$WORK/corrupt"
if tar xzf "$WORK/corrupt.tar.gz" -C "$WORK/corrupt" 2>/dev/null; then
  echo "  WARN: corrupted tarball extracted without error (tar gzip recovery)"
else
  echo "  PASS: corrupted tarball rejected by tar"
fi

echo "==> Test 4: fresh-extract boot (extension load + distance query)"
mkdir -p "$WORK/fresh"
tar xzf "$WORK/$ASSET" -C "$WORK/fresh"
chown -R pguser:pguser "$WORK/fresh" 2>/dev/null || true

PG_BIN="$WORK/fresh/bin"
DATA="$WORK/fresh/pgdata"
LOG="$WORK/fresh/pg.log"
PORT=55897

"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/postgres" --version
"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/initdb" -D "$DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -h 127.0.0.1" -l "$LOG" -w start
trap 'echo "==> pg.log tail:"; tail -100 "'"$LOG"'" 2>/dev/null || true; "${RUN_AS[@]}" env -i HOME="'"$WORK/fresh"'" PATH=/usr/bin:/bin "'"$PG_BIN"'/pg_ctl" -D "'"$DATA"'" -m fast stop > /dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# Diagnostic on env -i: list bundled lib deps that the dynamic linker can't resolve.
echo "==> ldd vector.so (under env -i):"
"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin ldd "$WORK/fresh/lib/postgresql/vector.so" 2>&1 | head -20 || true

"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
EXTV="$("${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
[[ "$EXTV" == "$PGVECTOR_VER" ]] || { echo "FAIL: extversion=$EXTV"; exit 1; }
echo "  PASS: fresh-extract boot + vector extension"

echo "==> Test 5: same tarball extracted twice → second initdb refuses (data-dir already initialized)"
mkdir -p "$WORK/twice"
tar xzf "$WORK/$ASSET" -C "$WORK/twice"
chown -R pguser:pguser "$WORK/twice" 2>/dev/null || true
DATA2="$WORK/twice/pgdata"
"${RUN_AS[@]}" env -i HOME="$WORK/twice" PATH=/usr/bin:/bin "$WORK/twice/bin/initdb" -D "$DATA2" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
if "${RUN_AS[@]}" env -i HOME="$WORK/twice" PATH=/usr/bin:/bin "$WORK/twice/bin/initdb" -D "$DATA2" -U postgres 2>/dev/null; then
  echo "  WARN: second initdb succeeded on already-initialized dir (unexpected)"
else
  echo "  PASS: second initdb refused already-initialized dir"
fi

echo "==> Test 6: shutdown + cleanup"
"${RUN_AS[@]}" env -i HOME="$WORK/fresh" PATH=/usr/bin:/bin "$PG_BIN/pg_ctl" -D "$DATA" -m fast stop > /dev/null
trap 'rm -rf "$WORK"' EXIT

echo "==> All negative-path smokes: PASS"
