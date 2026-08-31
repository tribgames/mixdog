#!/usr/bin/env bash
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-6.1.1}"
TARGET_OS="${TARGET_OS:?TARGET_OS is required}"
TARGET_ARCH="${TARGET_ARCH:?TARGET_ARCH is required}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build/ffmpeg-runtime-${TARGET_OS}-${TARGET_ARCH}"
SOURCE_DIR="$BUILD_DIR/ffmpeg-${FFMPEG_VERSION}"
DIST_DIR="$ROOT_DIR/dist"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

echo "==> Downloading FFmpeg n${FFMPEG_VERSION}"
curl -fsSL --retry 3 \
  "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
  -o "$BUILD_DIR/ffmpeg.tar.xz"
tar -xJf "$BUILD_DIR/ffmpeg.tar.xz" -C "$BUILD_DIR"

CONFIGURE_FLAGS=(
  --disable-everything
  --disable-autodetect
  --disable-debug
  --disable-doc
  --disable-network
  --disable-shared
  --enable-static
  --enable-small
  --enable-ffmpeg
  --enable-avcodec
  --enable-avfilter
  --enable-avformat
  --enable-swresample
  --enable-protocol=file,pipe
  --enable-demuxer=aac,ac3,aiff,amr,ape,asf,au,avi,caf,flac,flv,matroska,mov,mp3,mpegts,ogg,wav,wv
  --enable-decoder=aac,aac_fixed,ac3,alac,amrnb,amrwb,ape,eac3,flac,mp1,mp1float,mp2,mp2float,mp3,mp3float,opus,pcm_alaw,pcm_f32be,pcm_f32le,pcm_f64be,pcm_f64le,pcm_mulaw,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_s8,pcm_u16be,pcm_u16le,pcm_u24be,pcm_u24le,pcm_u32be,pcm_u32le,pcm_u8,vorbis,wavpack,wmav1,wmav2,wmapro
  --enable-encoder=pcm_s16le
  --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis
  --enable-filter=aformat,anull,aresample
  --enable-muxer=wav
)

EXE_NAME=ffmpeg
STRIP_COMMAND=strip
if [[ "$TARGET_OS" == "win32" ]]; then
  CONFIGURE_FLAGS+=(
    --target-os=mingw32
    --arch=x86_64
    --cc=gcc
    --ar=ar
    --ranlib=ranlib
    --nm=nm
    --strip=strip
    --extra-ldflags=-static
  )
  EXE_NAME=ffmpeg.exe
elif [[ "$TARGET_OS" == "darwin" ]]; then
  STRIP_COMMAND="strip -x"
fi

echo "==> Configuring minimal audio-transcode runtime"
pushd "$SOURCE_DIR" >/dev/null
./configure "${CONFIGURE_FLAGS[@]}"
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu)"
popd >/dev/null

RUNTIME_EXE="$SOURCE_DIR/ffmpeg"
if [[ "$TARGET_OS" == "win32" ]]; then
  RUNTIME_EXE="$SOURCE_DIR/ffmpeg.exe"
fi
if [[ ! -f "$RUNTIME_EXE" ]]; then
  echo "FFmpeg build did not produce $RUNTIME_EXE" >&2
  exit 1
fi

read -r -a STRIP_PARTS <<< "$STRIP_COMMAND"
"${STRIP_PARTS[@]}" "$RUNTIME_EXE"

echo "==> Smoke testing WAV normalization"
PYTHON_COMMAND=
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON_COMMAND="$candidate"
    break
  fi
done
if [[ -z "$PYTHON_COMMAND" ]]; then
  echo "Python 3 is required for the FFmpeg runtime smoke test" >&2
  exit 1
fi

"$PYTHON_COMMAND" - "$BUILD_DIR/input.wav" <<'PY'
import math
import struct
import sys
import wave

with wave.open(sys.argv[1], "wb") as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(48000)
    frames = bytearray()
    for index in range(4800):
        sample = int(math.sin(index * 2 * math.pi * 440 / 48000) * 12000)
        frames.extend(struct.pack("<hh", sample, sample))
    wav.writeframes(frames)
PY
"$RUNTIME_EXE" -hide_banner -loglevel error \
  -i "$BUILD_DIR/input.wav" -ar 16000 -ac 1 -threads 1 -y "$BUILD_DIR/output.wav"
"$PYTHON_COMMAND" - "$BUILD_DIR/output.wav" <<'PY'
import sys
import wave

with wave.open(sys.argv[1], "rb") as wav:
    assert wav.getframerate() == 16000
    assert wav.getnchannels() == 1
    assert wav.getnframes() > 0
PY

RUNTIME_BYTES="$(wc -c < "$RUNTIME_EXE" | tr -d ' ')"
if (( RUNTIME_BYTES > 26214400 )); then
  echo "Minimal FFmpeg exceeds 25 MiB: $RUNTIME_BYTES bytes" >&2
  exit 1
fi

ASSET_NAME="ffmpeg-${TARGET_OS}-${TARGET_ARCH}.gz"
gzip -9 -n -c "$RUNTIME_EXE" > "$DIST_DIR/$ASSET_NAME"
ASSET_BYTES="$(wc -c < "$DIST_DIR/$ASSET_NAME" | tr -d ' ')"
if (( ASSET_BYTES > 15728640 )); then
  echo "Compressed FFmpeg exceeds 15 MiB: $ASSET_BYTES bytes" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIST_DIR" && sha256sum "$ASSET_NAME" > "$ASSET_NAME.sha256")
else
  (cd "$DIST_DIR" && shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256")
fi

echo "Built $DIST_DIR/$ASSET_NAME ($RUNTIME_BYTES bytes raw, $ASSET_BYTES bytes compressed)"
