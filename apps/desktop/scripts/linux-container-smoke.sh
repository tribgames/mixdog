#!/bin/bash
# Runs inside a distro container with the repo mounted at /w:
#   linux-container-smoke.sh <debian|fedora>
# Expects /w/node (Node tarball), /w/ctr (smoke script + ws), /w/pkg (packages).
# Containers run as root without FUSE, so the AppImage is launched with
# --appimage-extract-and-run and the app with --no-sandbox.
set -euo pipefail
family=$1
head -n 3 /etc/os-release
ldd --version | sed -n 1p
export PATH=/w/node/bin:$PATH
if [ "$family" = debian ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y --no-install-recommends xvfb xauth libgtk-3-0 libnss3 libasound2 libxss1 libxtst6 \
    libgbm1 libdrm2 libxkbcommon0 libatspi2.0-0 libsecret-1-0 libnotify4 xdg-utils ca-certificates
else
  dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth gtk3 nss alsa-lib libXScrnSaver libXtst mesa-libgbm \
    libdrm libxkbcommon at-spi2-core libsecret libnotify xdg-utils which
fi
chmod +x /w/pkg/*.AppImage
# Every bundled native tool must load and run here: a glibc newer than this
# distro's makes the dynamic loader refuse it ("version `GLIBC_x' not found").
# The tools exercised are the ones inside the built packages (extracted
# AppImage, installed .deb), never a build directory.
check_native_tools() { # check_native_tools <label> <tools dir>
  local label=$1 tools=$2
  echo "== native tools: $label ($family, $(ldd --version | sed -n 1p))"
  ls -l "$tools"
  sha256sum "$tools"/mixdog-*
  exec_tool() {
    local name=$1; shift
    local out rc=0
    out=$(timeout 30 "$tools/$name" "$@" </dev/null 2>&1) || rc=$?
    echo "-- $label $name $* (exit $rc)"; echo "$out" | head -n 5
    if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ] || echo "$out" | grep -Eq "GLIBC_[0-9.]+' not found|error while loading shared libraries|cannot execute"; then
      echo "NATIVE TOOL FAILED TO LOAD: $label $name"; exit 1
    fi
  }
  ldd "$tools"/* >/tmp/ldd.txt 2>&1 || true
  cat /tmp/ldd.txt
  if grep -q 'not found' /tmp/ldd.txt; then echo "unresolved native tool libraries ($label)"; exit 1; fi
  exec_tool mixdog-computer --version
  exec_tool mixdog-patch --help
  exec_tool mixdog-graph /tmp --langs
  exec_tool mixdog-spawn --version
}
mkdir -p /tmp/ex && cd /tmp/ex && /w/pkg/*.AppImage --appimage-extract >/dev/null && cd /
check_native_tools AppImage /tmp/ex/squashfs-root/resources/native-tools
echo "== AppImage ($family)"
SMOKE_LAUNCH_ARGS=--appimage-extract-and-run xvfb-run -a --server-args="-screen 0 1440x900x24" \
  node /w/ctr/linux-launch-smoke.mjs /w/pkg/mixdog-desktop-linux-*.AppImage "/w/out/appimage-$family"
if [ "$family" = debian ]; then
  echo "== .deb ($family)"
  apt-get install -y /w/pkg/*.deb
  xvfb-run -a --server-args="-screen 0 1440x900x24" \
    node /w/ctr/linux-launch-smoke.mjs /opt/Mixdog/mixdog-desktop "/w/out/deb-$family"
fi
