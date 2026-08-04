#!/usr/bin/env bash
# build-runtime-macos.sh — Build self-contained PostgreSQL 16 + pgvector runtime on macOS.
# Uses dylibbundler — the canonical macOS dependency-bundling tool — for @rpath
# / install_name / transitive dyld closure (auriamg/macdylibbundler). Replaces
# 200 lines of hand-rolled otool + install_name_tool walking.
# Produces: dist/mixdog-runtime-darwin-{arch}-pg{pgver}-pgvector{vecver}.tar.gz

set -euo pipefail

PG_VERSION="16.4"
PGVECTOR_VERSION="0.8.2"
TARGET_OS="${TARGET_OS:-darwin}"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m | sed 's/x86_64/x64/')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/runtime-darwin-$TARGET_ARCH"
STAGE_DIR="$BUILD_DIR/stage"
DIST_DIR="$ROOT_DIR/dist"
RUNTIME_DIR="$BUILD_DIR/runtime"

OUTPUT_NAME="mixdog-runtime-${TARGET_OS}-${TARGET_ARCH}-pg${PG_VERSION}-pgvector${PGVECTOR_VERSION}.tar.gz"

mkdir -p "$BUILD_DIR" "$STAGE_DIR" "$DIST_DIR" "$RUNTIME_DIR"/{bin,lib,share}

echo "==> Installing build dependencies via Homebrew"
brew install readline icu4c openssl@3 pkg-config curl git dylibbundler

BREW_PREFIX="$(brew --prefix)"
export CPPFLAGS="-I${BREW_PREFIX}/opt/readline/include -I${BREW_PREFIX}/opt/openssl@3/include -I${BREW_PREFIX}/opt/icu4c/include"
export LDFLAGS="-L${BREW_PREFIX}/opt/readline/lib -L${BREW_PREFIX}/opt/openssl@3/lib -L${BREW_PREFIX}/opt/icu4c/lib"
export PKG_CONFIG_PATH="${BREW_PREFIX}/opt/openssl@3/lib/pkgconfig:${BREW_PREFIX}/opt/icu4c/lib/pkgconfig"

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

  # macOS 15.4+ SDKs declare strchrnul (non-static, availability-floored at
  # 15.4). PG 16.4 predates that: with HAVE_STRCHRNUL its unconditional use
  # trips -Werror=unguarded-availability-new; without it (the ac_cv override
  # below) its static-inline fallback collides with the SDK declaration
  # ("static declaration follows non-static declaration"). Rename the
  # file-local fallback so the build never touches the libc symbol — also
  # keeps the binary loadable on macOS < 15.4. Upstream fixed this after
  # 16.4; drop both hunks on the next PG version bump.
  sed -i '' 's/strchrnul/pg_strchrnul/g' "postgresql-${PG_VERSION}/src/port/snprintf.c"

  echo "==> Configuring + building PostgreSQL"
  cd "postgresql-${PG_VERSION}"
  # Xcode 16.4 SDK (macOS 15.5) declares strchrnul with an availability
  # floor of macOS 15.4; configure's link test passes but compilation under
  # -Werror=unguarded-availability-new fails when the deployment target is
  # older (PG 16.4 predates the guard upstream added later). Force-disable
  # detection so PG uses its portable fallback — keeps the binary loadable
  # on every macOS the deployment target allows.
  ./configure \
    --prefix="$STAGE_DIR" \
    --without-perl --without-python --without-tcl \
    --with-openssl --with-icu --with-readline \
    --enable-thread-safety \
    ac_cv_func_strchrnul=no \
    CFLAGS="-O2"
  unset TARGET_OS TARGET_ARCH
  make -j"$(sysctl -n hw.logicalcpu)"
  make install
  make -C contrib/pgcrypto install
fi

PG_CONFIG="$STAGE_DIR/bin/pg_config"
export PATH="$STAGE_DIR/bin:$PATH"

if [[ -f "$STAGE_DIR/lib/postgresql/vector.dylib" ]]; then
  echo "==> Cache hit: pgvector already installed — skipping clone/build"
else
  echo "==> Cloning + building pgvector $PGVECTOR_VERSION"
  cd "$BUILD_DIR"
  rm -rf pgvector
  git clone --branch "v${PGVECTOR_VERSION}" --depth 1 \
    https://github.com/pgvector/pgvector.git pgvector
  cd pgvector
  make PG_CONFIG="$PG_CONFIG" -j"$(sysctl -n hw.logicalcpu)"
  make PG_CONFIG="$PG_CONFIG" install
fi

echo "==> Stripping macOS binaries"
find "$STAGE_DIR/bin" -type f -exec strip -S -x {} \; 2>/dev/null || true
find "$STAGE_DIR/lib" -name '*.dylib' -type f -exec strip -S -x {} \; 2>/dev/null || true

echo "==> Assembling runtime layout"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"/{bin,lib,share}
for BIN in postgres pg_ctl pg_dump pg_restore psql initdb; do
  cp -a "$STAGE_DIR/bin/$BIN" "$RUNTIME_DIR/bin/" 2>/dev/null || echo "WARN: $BIN not found"
done
cp -a "$STAGE_DIR/lib"/.   "$RUNTIME_DIR/lib/"   2>/dev/null || true
cp -a "$STAGE_DIR/share"/. "$RUNTIME_DIR/share/" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Bundle foreign Homebrew dylibs via dylibbundler. This is the canonical
# macOS tool: walks transitive deps including @rpath, copies into a target
# dir, rewrites install_name + LC_RPATH on every Mach-O. Replaces the
# hand-rolled otool/install_name_tool loop that missed @rpath references.
#
# Flags:
#   -of   overwrite existing files in target dir
#   -b    bundle (don't only print)
#   -cd   create-dest if missing
#   -ns   no-codesign (we ad-hoc sign at the end ourselves)
#   -p    rpath to use in rewritten install_names (relative to binary)
#   -d    target lib dir
#   -x    Mach-O input to scan (repeatable)
# ---------------------------------------------------------------------------
echo "==> Bundling foreign deps via dylibbundler"
DYLIBBUNDLER_ARGS=(-of -b -cd -ns -d "$RUNTIME_DIR/lib/" -p '@executable_path/../lib/')
for BIN in postgres pg_ctl pg_dump pg_restore psql initdb; do
  [[ -f "$RUNTIME_DIR/bin/$BIN" ]] && DYLIBBUNDLER_ARGS+=(-x "$RUNTIME_DIR/bin/$BIN")
done
while IFS= read -r -d '' ext; do
  DYLIBBUNDLER_ARGS+=(-x "$ext")
done < <(find "$RUNTIME_DIR/lib/postgresql" -name '*.dylib' -print0 2>/dev/null)
dylibbundler "${DYLIBBUNDLER_ARGS[@]}"

echo "==> Stripping static archives from lib/"
find "$RUNTIME_DIR/lib" -name '*.a' -delete

echo "==> Ad-hoc re-codesign every Mach-O (dylibbundler invalidates signature)"
while IFS= read -r -d '' macho; do
  if file "$macho" 2>/dev/null | grep -q 'Mach-O'; then
    codesign --force --sign - "$macho" 2>/dev/null || true
  fi
done < <(find "$RUNTIME_DIR/bin" "$RUNTIME_DIR/lib" -type f -print0)

echo "==> Self-contained smoke test (initdb + CREATE EXTENSION vector + distance query)"
unset DYLD_FALLBACK_LIBRARY_PATH DYLD_LIBRARY_PATH
SMOKE_DATA="$BUILD_DIR/smoke-pgdata"
SMOKE_LOG="$BUILD_DIR/smoke-pg.log"
SMOKE_PORT=55899
rm -rf "$SMOKE_DATA"

"$RUNTIME_DIR/bin/postgres" --version
BAD="$(otool -L "$RUNTIME_DIR/bin/postgres" | grep -E '(/opt/homebrew|/usr/local/Cellar|/opt/local|'"$STAGE_DIR"')' || true)"
if [[ -n "$BAD" ]]; then echo "FAIL: stray paths in postgres:"; echo "$BAD"; exit 1; fi
VECTOR_DYLIB="$RUNTIME_DIR/lib/postgresql/vector.dylib"
if [[ -f "$VECTOR_DYLIB" ]]; then
  VBAD="$(otool -L "$VECTOR_DYLIB" | grep -E '(/opt/homebrew|/usr/local/Cellar|/opt/local|'"$STAGE_DIR"')' || true)"
  if [[ -n "$VBAD" ]]; then echo "FAIL: stray paths in vector.dylib:"; echo "$VBAD"; exit 1; fi
fi

"$RUNTIME_DIR/bin/initdb" -D "$SMOKE_DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -o "-p $SMOKE_PORT -h 127.0.0.1" -l "$SMOKE_LOG" -w start
trap '"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m fast stop > /dev/null 2>&1 || true' EXIT

"$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
EXTV="$("$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
DIST="$("$RUNTIME_DIR/bin/psql" -h 127.0.0.1 -p "$SMOKE_PORT" -U postgres -d postgres -tAc "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;")"
echo "  vector extension version: $EXTV"
echo "  distance query result:    $DIST"
[[ "$EXTV" == "$PGVECTOR_VERSION" ]] || { echo "FAIL: extversion=$EXTV expected=$PGVECTOR_VERSION"; exit 1; }
"$RUNTIME_DIR/bin/pg_ctl" -D "$SMOKE_DATA" -m fast stop > /dev/null
trap - EXIT
rm -rf "$SMOKE_DATA"
echo "  PASS smoke (extension load + vector distance)"

# Licenses
curl -fsSL "https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/COPYRIGHT" \
  -o "$RUNTIME_DIR/LICENSE.postgresql"
cp "$BUILD_DIR/pgvector/LICENSE" "$RUNTIME_DIR/LICENSE.pgvector"

echo "==> Creating tarball: $OUTPUT_NAME"
cd "$BUILD_DIR"
tar czf "$DIST_DIR/$OUTPUT_NAME" -C "$RUNTIME_DIR" .

echo "==> Generating sha256 sidecar"
cd "$DIST_DIR"
shasum -a 256 "$OUTPUT_NAME" > "${OUTPUT_NAME}.sha256"

# ---------------------------------------------------------------------------
# Phase A: Re-smoke from EXTRACTED tarball with hostile env. Catches false-pass
# from build-host having Homebrew formulae that bundled tarball might be
# missing — dylibbundler should have rewritten everything, this is the proof.
# ---------------------------------------------------------------------------
echo "==> Re-smoke from extracted tarball (hostile env)"
EXTRACT_DIR="$BUILD_DIR/extract-smoke"
rm -rf "$EXTRACT_DIR"; mkdir -p "$EXTRACT_DIR"
tar xzf "$DIST_DIR/$OUTPUT_NAME" -C "$EXTRACT_DIR"
EXTRACT_DATA="$EXTRACT_DIR/extract-pgdata"
EXTRACT_LOG="$EXTRACT_DIR/extract-pg.log"
EXTRACT_PORT=55898

env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/postgres" --version
env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/initdb" -D "$EXTRACT_DATA" --auth-local=trust --no-locale -E UTF8 -U postgres > /dev/null
env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/pg_ctl" -D "$EXTRACT_DATA" -o "-p $EXTRACT_PORT -h 127.0.0.1" -l "$EXTRACT_LOG" -w start
trap 'env -i HOME="'"$EXTRACT_DIR"'" PATH=/usr/bin:/bin "'"$EXTRACT_DIR"'/bin/pg_ctl" -D "'"$EXTRACT_DATA"'" -m fast stop > /dev/null 2>&1 || true' EXIT
env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/psql" -h 127.0.0.1 -p "$EXTRACT_PORT" -U postgres -d postgres -c "CREATE EXTENSION vector;" > /dev/null
EXTV2="$(env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" "$EXTRACT_DIR/bin/psql" -h 127.0.0.1 -p "$EXTRACT_PORT" -U postgres -d postgres -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")"
[[ "$EXTV2" == "$PGVECTOR_VERSION" ]] || { echo "FAIL: extracted-smoke extversion=$EXTV2"; exit 1; }
env -i HOME="$EXTRACT_DIR" PATH="/usr/bin:/bin" \
  "$EXTRACT_DIR/bin/pg_ctl" -D "$EXTRACT_DATA" -m fast stop > /dev/null
trap - EXIT
rm -rf "$EXTRACT_DIR"
echo "  PASS extracted-tarball smoke"

echo "==> Done: $DIST_DIR/$OUTPUT_NAME"
ls -lh "$DIST_DIR/$OUTPUT_NAME"
