# Wiring after wave 97 (lead): applied and waiting

Applied: statusline/read (row, service), blob fields of desktop/attachment/write and desktop/userFile/write, the prompt's user cwd, per-monitor capture features,
x-residual-moves-b-client (the patch of ipc.ts and index.ts; approval-grant-change.ts, native-runtime-cache-gc.*, network-watch.*, linux-input-access.* deleted).

Waiting (kept as .kept beside this file):
- s3-bridge-forward.kept: main/index.ts builds the computer bridge of computer/bridge/ over the core (computer/bridge/run|abort) and the TypeScript host stops publishing
  its own computer-bridge.json. Needs a live check with Computer Use on (focused test phase).
- s4-bridge-forward.kept: browser/host-agent.ts points the loopback browser bridge at the core (browser/bridge/run|turn|abort). ORDER: only after
  BrowserApprovalContext::session_gate is bound (native/core/crates/pending-wire/s4-bridge-forward.kept, deferred-g95 item 7), else a step that asks fails.
- g97-fu-screen.kept (and g96-screen-viewer.kept): removal of the Electron screen sources. The core now captures per monitor at 30 fps; apply with the live smoke of a
  phone watching the screen (4K monitor, a second monitor, a UAC prompt, unplug/replug).
- core: g97-fu-be-c.wire section 3b (warm_touches.clone() and .with_warm_uses(..) on HostManualCompaction): the two sites are in different functions; needs the
  warm touch store passed to real_core. Until then an idle auto-clear measures idleness from the last turn alone.
