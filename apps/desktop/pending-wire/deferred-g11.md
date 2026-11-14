# Desktop wiring after wave 11 (DELETE-HOT-G11, lead): applied and waiting

Applied (commits b740b1b097, 5d2d7f1eea, 19fd39995a); the five fragments are deleted:

- s2a-del-ipc-handlers.wire: ipc.ts no longer registers the notification IPC (its five channels are DIRECT keys answered by
  renderer/core-direct/api-settings.ts), and the register calls take the narrowed options; SERVICE_OPERATION_NAMES, serviceOperations,
  serviceApp/serviceUserDataPath, onDesktopSettingsChanged (core-observers.ts applies the core's settings change), remoteAccessInfo /
  rotateRemoteAccess / revokeRemoteAccessClient options (api-settings.ts getRemoteAccessInfo/rotateRemoteAccess/revokeRemoteAccessClient;
  index.ts keeps remoteAccessInfo for its own line) are gone. The git/gh/tool-install operations are api-scm.ts (SCM_OPERATION_ROUTES)
  and api-files.ts. desktop-service-contract.ts drops readSessionTranscript?/readSessionHistory? (the core's desktop/attachment/resolve
  reads the stored history). ipc-state-bridge.ts forwards only conversationImportProgress of the desktop events (plus updater, notices,
  engine/session state): sessions, agent pool, folder, LSP, settings, provider models, rail pins, turn review, orchestration mode,
  relay refusal, remote claim and remote access settings are the renderer's DIRECT subscribe* members.
- s2a-del-protocol-relay.wire: the window-ipc import, statement and dispose are gone; SECTIONS_IPC removed from contract-sections.ts
  (RENDERER_PROTOCOL_METHODS / isRendererProtocolMethod / DesktopSectionsApi stay: renderer/core-direct/sections.ts uses them);
  the desktop-operation-route.ts comment names renderer-connection.ts.
- s2a-del-terminal.wire: ipc.ts terminal registration, index.ts `terminals`, desktop-connection.ts terminal host, connections/index.ts
  export and connections.test.mjs lines removed (renderer/core-direct/api-terminal.ts serves the terminals).
- s2b-delete-ts.wire: items 1-5 (remote-session import, remoteGraceMs, throughPcCore, MIXDOG_SSH_TARGET read directly, test:ssh:e2e).
- s1-del-grants-page.wire: items 1 (localPageUrl option; windowIdFor import now unused, removed; coreLocalPages stays, used at
  startup), 2 (connection.ts comment), 4 (project-files.ts import from project-entry-path); item 3 was done by PROTO-WIRE-G11.

Waiting:

- s2a-del-terminal.wire, contract-ipc.ts line: the term* / terminalRunClaim channels of DESKTOP_IPC (and the other DIRECT channel
  rows) are dropped by s2a-del-preload-contract (not merged in G11); ipc.ts's eventChannels set still names them until then.
  shared/desktop-ipc-preload.parity.test.mjs test 2 now excludes DIRECT keys and their event channels from "main names it".
- ipc-state-bridge.ts: the session/engine state handlers (setVisibleSessions, prefetchSession, readTranscriptHistory, getSnapshot,
  state/sessionState pushes and resyncs) are DIRECT keys no preload calls; they and their tests (ipc-state-bridge-late-read,
  -resync, -notices) go with s2a-del-preload-contract.
- s2a-del-ipc-handlers.wire, Rust names readSessionTranscript/readSessionHistory (operations_map.json, inventory.rs,
  desktop_residual.rs): protocol lead (native/core/crates/pending-wire/deferred-g11.md).
- Tests still exercising removed DIRECT handlers through registerDesktopIpc (s2a-del-ipc-tests did not rewrite them): chat-file-ipc.test.mjs
  cases 2-5 (readProjectFile/listProjectDir/... ), settings-store.test.mjs cases 3, 8, 9 (updateSessionRetention, updateSetting),
  local-page-permissions.test.mjs cases 9-10 (failing before G11 too). Owner: a follow-up of s2a-del-ipc-tests (move them to
  renderer/core-direct api-files / api-settings tests).
- benchmarks/rust-core/recorders/record-session-history-boundary-cases.mjs still loads the deleted main/session-attachments.ts (deferred-g4).
- deferred-g7 listSystemFonts / getNotificationPreferences / sendTestNotification: x-del-notify-ts (not merged).
- The .kept files (s3-bridge-forward, s4-bridge-forward, g97-fu-screen, g96-screen-viewer, s4-harness-rebase-a): unchanged, real-screen check.
