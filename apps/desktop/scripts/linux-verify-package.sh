#!/bin/bash
# Verifies the BUILT Linux packages, not the build directory:
#   linux-verify-package.sh <distDir> <nativeOutDir> <x64|arm64> <maxGlibc> [workDir]
# 1. extracts the payload of the .deb (dpkg-deb -x) and of the AppImage (--appimage-extract),
# 2. proves mixdog-computer/-graph/-patch inside BOTH are byte-identical to the
#    manylinux_2_28 build outputs in <nativeOutDir> (so the pinned-release
#    download path was not used) and that both packages carry the same tools,
# 3. records the glibc floor of every ELF in both payloads (fail closed, see
#    linux-glibc-floor.mjs) including the Electron binary, the native tools and pty.node.
# Exports DEB_ROOT / AI_ROOT to $GITHUB_ENV when set.
set -euo pipefail
dist=$1 native=$2 arch=$3 max=$4 work=${5:-extract}
here=$(cd "$(dirname "$0")" && pwd)
shopt -s nullglob
debs=("$dist"/*.deb)
ais=("$dist"/*.AppImage)
[ ${#debs[@]} -eq 1 ] || {
	echo "expected exactly one .deb in $dist, found ${#debs[@]}"
	exit 1
}
[ ${#ais[@]} -eq 1 ] || {
	echo "expected exactly one .AppImage in $dist, found ${#ais[@]}"
	exit 1
}
rm -rf "$work"
mkdir -p "$work/deb" "$work/appimage"
work=$(cd "$work" && pwd)
ai=$(realpath "${ais[0]}")
dpkg-deb -x "${debs[0]}" "$work/deb"
chmod +x "$ai"
(cd "$work/appimage" && "$ai" --appimage-extract >/dev/null)
deb_root="$work/deb/opt/Mixdog"
ai_root="$work/appimage/squashfs-root"
echo "deb payload: $deb_root"
echo "AppImage payload: $ai_root"
for root in "$deb_root" "$ai_root"; do
	for t in computer graph patch; do
		want=$(sha256sum "$native/mixdog-$t" | cut -d' ' -f1)
		got=$(sha256sum "$root/resources/native-tools/mixdog-$t" | cut -d' ' -f1)
		echo "mixdog-$t  build=$want  packaged=$got  ($root)"
		[ "$want" = "$got" ] || {
			echo "::error::packaged mixdog-$t is not the manylinux_2_28 build output"
			exit 1
		}
	done
done
diff -r "$deb_root/resources/native-tools" "$ai_root/resources/native-tools"
sha256sum "$deb_root"/resources/native-tools/*
required="mixdog-desktop,resources/native-tools/mixdog-computer,resources/native-tools/mixdog-graph,resources/native-tools/mixdog-patch,resources/native-tools/mixdog-spawn,resources/app.asar.unpacked/node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node"
for root in "$deb_root" "$ai_root"; do
	echo "== glibc floor: $root"
	node "$here/linux-glibc-floor.mjs" "$root" "$max" --arch "$arch" --require "$required"
done
if [ -n "${GITHUB_ENV:-}" ]; then
	echo "DEB_ROOT=$deb_root" >>"$GITHUB_ENV"
	echo "AI_ROOT=$ai_root" >>"$GITHUB_ENV"
fi
echo "package verification passed"
