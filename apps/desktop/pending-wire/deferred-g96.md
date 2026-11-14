# Desktop wiring after wave 96 (lead)

Applied: s4-host-type-split (imports), g96-fu-connections (claim resources).

NOT applied:
- g96-screen-viewer.wire (removal of the Electron screen sources from browser/host.ts, main/index.ts, remote-browser-methods.ts): the core's screen picture is read
  from the desktop at about 10 fps and at most 1920 px, where the Electron track ran at 30 fps at the display's size. Slower is not allowed: the Electron source stays
  until the core captures per monitor in process (or the desktop streams its frames). The text of the fragment: git show HEAD~0:apps/desktop/pending-wire/g96-screen-viewer.wire
  before this commit (kept below as g96-screen-viewer.kept).
- s4-harness-rebase-a.wire: apps/desktop/scripts/run-browser-host-integration.mjs must stop bundling golden-twin / host as standalone Electron entries and run
  scripts/run-browser-core-integration.mjs --suite .. --engine host|core instead (no task owns the script). Kept below as s4-harness-rebase-a.kept.
