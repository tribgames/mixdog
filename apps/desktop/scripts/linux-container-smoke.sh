#!/bin/bash
# Runs inside a distro container with the repo mounted at /w:
#   linux-container-smoke.sh <debian|fedora>
# Expects /w/node (Node tarball), /w/ctr (smoke script + ws), /w/pkg (packages).
# Containers run as root without FUSE, so the AppImage is launched with
# --appimage-extract-and-run and the app with --no-sandbox.
set -euo pipefail
family=$1
cat /etc/os-release | head -n 3
ldd --version | head -n 1
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
echo "== AppImage ($family)"
SMOKE_LAUNCH_ARGS=--appimage-extract-and-run xvfb-run -a --server-args="-screen 0 1440x900x24" \
  node /w/ctr/linux-launch-smoke.mjs /w/pkg/mixdog-desktop-linux-*.AppImage "/w/out/appimage-$family"
if [ "$family" = debian ]; then
  echo "== .deb ($family)"
  apt-get install -y /w/pkg/*.deb
  xvfb-run -a --server-args="-screen 0 1440x900x24" \
    node /w/ctr/linux-launch-smoke.mjs /opt/Mixdog/mixdog-desktop "/w/out/deb-$family"
fi
