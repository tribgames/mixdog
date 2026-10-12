#!/bin/bash
# GNOME Shell extension packaging checks.
#   linux-gnome-extension-check.sh source <repoRoot>   (pre-build: dir exists, uuid == dir name, modes normalized)
#   linux-gnome-extension-check.sh payload <debRoot> <appImageRoot>   (built packages carry it in both places)
set -euo pipefail
uuid='mixdog-windows@mixdog.io'
check_dir() { # <dir> <label>
  local d=$1 label=$2
  [ -f "$d/metadata.json" ] || { echo "::error::$label: $d/metadata.json missing"; exit 1; }
  [ -f "$d/extension.js" ] || { echo "::error::$label: $d/extension.js missing"; exit 1; }
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/metadata.json", "utf8"));
    if (m.uuid !== process.argv[2]) { console.error("metadata.json uuid " + JSON.stringify(m.uuid) + " != " + process.argv[2]); process.exit(1); }
  ' "$d" "$uuid" || { echo "::error::$label: metadata uuid mismatch"; exit 1; }
  echo "$label OK: $d (uuid=$uuid)"
}
check_modes() { # <dir>
  local bad
  bad=$(find "$1" \( -type d ! -perm 755 \) -o \( -type f ! -perm 644 \)) || true
  [ -z "$bad" ] || { echo "::error::wrong modes (dirs 0755, files 0644):"; echo "$bad"; exit 1; }
}
case "$1" in
  source)
    src="$2/native/gnome-extension/$uuid"
    [ -d "$src" ] || { echo "::error::GNOME extension source $src does not exist yet (packaging is wired and waits for the app-code commit)"; exit 1; }
    find "$src" -type d -exec chmod 755 {} +; find "$src" -type f -exec chmod 644 {} +
    check_dir "$src" "source" ;;
  payload)
    deb=$2 ai=$3
    check_dir "$deb/usr/share/gnome-shell/extensions/$uuid" ".deb system-wide"
    check_modes "$deb/usr/share/gnome-shell/extensions/$uuid"
    check_dir "$deb/opt/Mixdog/resources/gnome-extension/$uuid" ".deb app resources"
    check_dir "$ai/resources/gnome-extension/$uuid" "AppImage app resources"
    diff -r "$deb/usr/share/gnome-shell/extensions/$uuid" "$deb/opt/Mixdog/resources/gnome-extension/$uuid"
    diff -r "$deb/usr/share/gnome-shell/extensions/$uuid" "$ai/resources/gnome-extension/$uuid"
    echo "system-wide, .deb resources and AppImage resources copies are identical" ;;
  *) echo "usage: $0 source <repoRoot> | payload <debRoot> <aiRoot>"; exit 2 ;;
esac