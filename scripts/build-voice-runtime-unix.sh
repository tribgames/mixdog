#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${PROJECT_ROOT}/scripts/voice-runtime-config.json"
CONFIG_VERSION="$(node -e "const c=require(process.argv[1]);process.stdout.write(c.runtimeVersion)" "${CONFIG_PATH}")"
CONFIG_COMMIT="$(node -e "const c=require(process.argv[1]);process.stdout.write(c.whisperCommit)" "${CONFIG_PATH}")"
WHISPER_VERSION="${WHISPER_VERSION:-${CONFIG_VERSION}}"
WHISPER_COMMIT="${WHISPER_COMMIT:-${CONFIG_COMMIT}}"
TARGET_OS="${TARGET_OS:?TARGET_OS is required}"
TARGET_ARCH="${TARGET_ARCH:?TARGET_ARCH is required}"
BACKEND="${BACKEND:?BACKEND is required}"

if [[ "${WHISPER_VERSION}" != "${CONFIG_VERSION}" || "${WHISPER_COMMIT}" != "${CONFIG_COMMIT}" ]]; then
  echo "voice runtime version/commit must match ${CONFIG_PATH}" >&2
  exit 2
fi

HOST_ARCH="$(uname -m)"
case "${TARGET_ARCH}:${HOST_ARCH}" in
  x64:x86_64|x64:amd64|arm64:arm64|arm64:aarch64) ;;
  *)
    echo "voice runtime target ${TARGET_ARCH} does not match runner architecture ${HOST_ARCH}" >&2
    exit 2
    ;;
esac

WORK_BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
WORK_ROOT="${WORK_BASE}/mixdog-whisper-${WHISPER_COMMIT}-${TARGET_OS}-${TARGET_ARCH}-${BACKEND}"
SOURCE_ROOT="${WORK_ROOT}/whisper.cpp-${WHISPER_COMMIT}"
BUILD_ROOT="${WORK_ROOT}/build"
STAGE_ROOT="${WORK_ROOT}/stage"
DIST_ROOT="${PROJECT_ROOT}/dist"
ASSET_NAME="whisper-server-${TARGET_OS}-${TARGET_ARCH}-${BACKEND}.zip"
OUTPUT_PATH="${DIST_ROOT}/${ASSET_NAME}"

rm -rf "${WORK_ROOT}"
mkdir -p "${WORK_ROOT}" "${STAGE_ROOT}" "${DIST_ROOT}"
curl --fail --location --retry 3 \
  "https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_COMMIT}.tar.gz" \
  --output "${WORK_ROOT}/source.tar.gz"
tar -xzf "${WORK_ROOT}/source.tar.gz" -C "${WORK_ROOT}"

# Portability baseline (GGML_NATIVE=OFF + explicit ISA on x86-64).
#
# ggml defaults GGML_NATIVE=ON, which tunes the binary to the BUILD machine.
# CI runners are wider than consumer hardware, so a native build ships
# instructions the target CPU may not have and aborts with SIGILL /
# STATUS_ILLEGAL_INSTRUCTION right after backend init — the `--help` smoke
# below cannot catch it, because on the build machine it passes.
#
# x86-64 pins an AVX2/FMA/F16C baseline (Haswell 2013+); AVX-512, AVX-VNNI and
# BMI2 stay OFF because they are not universal on current consumer CPUs.
# arm64 needs no ISA pins — NEON is baseline — but must still disable NATIVE.
CMAKE_ARGS=(
  -S "${SOURCE_ROOT}"
  -B "${BUILD_ROOT}"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_EXAMPLES=ON
  -DWHISPER_BUILD_SERVER=ON
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_SDL2=OFF
)

if [[ "${TARGET_ARCH}" == "x64" ]]; then
  CMAKE_ARGS+=(
    -DGGML_AVX=ON
    -DGGML_AVX2=ON
    -DGGML_FMA=ON
    -DGGML_F16C=ON
    -DGGML_AVX512=OFF
    -DGGML_AVX_VNNI=OFF
    -DGGML_BMI2=OFF
  )
fi

case "${BACKEND}" in
  vulkan)
    CMAKE_ARGS+=(-DGGML_VULKAN=ON)
    ;;
  metal)
    CMAKE_ARGS+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON)
    ;;
  cpu)
    CMAKE_ARGS+=(-DGGML_METAL=OFF -DGGML_VULKAN=OFF)
    ;;
  *)
    echo "unsupported voice runtime backend: ${BACKEND}" >&2
    exit 2
    ;;
esac

cmake "${CMAKE_ARGS[@]}"
cmake --build "${BUILD_ROOT}" --config Release --target whisper-server --parallel 2

SERVER_PATH="$(find "${BUILD_ROOT}" -type f -name whisper-server -perm -111 | head -n 1)"
if [[ -z "${SERVER_PATH}" ]]; then
  echo "whisper-server was not produced" >&2
  exit 1
fi

cp "${SERVER_PATH}" "${STAGE_ROOT}/whisper-server"
cp "${SOURCE_ROOT}/LICENSE" "${STAGE_ROOT}/LICENSE-whisper.cpp.txt"
find "$(dirname "${SERVER_PATH}")" -maxdepth 1 -type f \
  \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) \
  -exec cp {} "${STAGE_ROOT}/" \;
chmod +x "${STAGE_ROOT}/whisper-server"
"${STAGE_ROOT}/whisper-server" --help >/dev/null

rm -f "${OUTPUT_PATH}"
(
  cd "${STAGE_ROOT}"
  cmake -E tar cf "${OUTPUT_PATH}" --format=zip .
)

if command -v sha256sum >/dev/null 2>&1; then
  HASH="$(sha256sum "${OUTPUT_PATH}" | cut -d' ' -f1)"
else
  HASH="$(shasum -a 256 "${OUTPUT_PATH}" | cut -d' ' -f1)"
fi
SIZE="$(wc -c < "${OUTPUT_PATH}" | tr -d ' ')"
printf '%s  %s\n' "${HASH}" "${ASSET_NAME}" > "${OUTPUT_PATH}.sha256"
echo "voice-runtime ${WHISPER_VERSION} ${TARGET_OS}-${TARGET_ARCH} ${BACKEND}: ${OUTPUT_PATH} (${SIZE} bytes, sha256=${HASH})"
