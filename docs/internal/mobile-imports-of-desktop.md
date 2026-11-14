# Files outside apps/mobile that the phone app imports

The phone app (`apps/mobile`) is built from its own sources plus files of the desktop app, the relay and
`packages/protocol-client` that it imports by relative path. A deletion task of the desktop migration (G11) must keep
every file below, or move it and change the import in the same commit. `node scripts/regress-clients.mjs` (step
`mobile-imports`) rebuilds this list from the imports and fails when a file is reached and not listed here, or is
listed and no longer exists. `node scripts/regress-clients.mjs --list-mobile-imports` prints it as JSON.

## Imported by a file of apps/mobile/src

- `apps/desktop/src/renderer/early-ui-i18n.ts`
- `apps/desktop/src/renderer/remote-connection-state.ts`
- `apps/desktop/src/renderer/remote-host-access.ts`
- `apps/desktop/src/renderer/remote-pairing-recovery.ts`
- `apps/desktop/src/renderer/remote-saved-pcs.ts`
- `apps/desktop/src/renderer/remote-shim-call-watch.ts`
- `apps/desktop/src/renderer/remote-shim-state.ts`
- `apps/desktop/src/renderer/remote-transport-peer.ts`
- `apps/desktop/src/shared/contract-sections.ts`
- `apps/desktop/src/shared/native-app.ts`
- `apps/desktop/src/shared/remote-e2ee.ts`
- `apps/desktop/src/shared/remote-transport.ts`
- `apps/relay/lib/relay-close-codes.mjs`
- `packages/protocol-client/src/index.ts`

## Reached through those files (transitive)

- `apps/desktop/src/main/state-delta.ts`
- `apps/desktop/src/renderer/mobile-surface.ts`
- `apps/desktop/src/renderer/remote-browser-identity.ts`
- `apps/desktop/src/renderer/remote-call-deadline.ts`
- `apps/desktop/src/renderer/remote-compact-frames.ts`
- `apps/desktop/src/renderer/remote-file-preview.ts`
- `apps/desktop/src/renderer/remote-ice-candidate.ts`
- `apps/desktop/src/renderer/remote-pairing-screen.ts`
- `apps/desktop/src/renderer/remote-session-inbox.ts`
- `apps/desktop/src/renderer/remote-shim-payload-limit.ts`
- `apps/desktop/src/renderer/remote-ui-projection.ts`
- `apps/desktop/src/renderer/remote-webrtc-stats.ts`
- `apps/desktop/src/shared/activity-rail-pins.ts`
- `apps/desktop/src/shared/browser-page-control.ts`
- `apps/desktop/src/shared/browser-permission-policy.ts`
- `apps/desktop/src/shared/contract-browser.ts`
- `apps/desktop/src/shared/contract-capabilities.ts`
- `apps/desktop/src/shared/contract-computer.ts`
- `apps/desktop/src/shared/contract-connection-link.ts`
- `apps/desktop/src/shared/contract-feedback.ts`
- `apps/desktop/src/shared/contract-git.ts`
- `apps/desktop/src/shared/contract-import.ts`
- `apps/desktop/src/shared/contract-ipc.ts`
- `apps/desktop/src/shared/contract-network-proxy.ts`
- `apps/desktop/src/shared/contract-notifications.ts`
- `apps/desktop/src/shared/contract-server-ports.ts`
- `apps/desktop/src/shared/contract-session.ts`
- `apps/desktop/src/shared/contract-settings.ts`
- `apps/desktop/src/shared/contract-ssh.ts`
- `apps/desktop/src/shared/contract-workspace.ts`
- `apps/desktop/src/shared/contract-worktree.ts`
- `apps/desktop/src/shared/contract.ts`
- `apps/desktop/src/shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs`
- `apps/desktop/src/shared/core-src/runtime/agent/orchestrator/session/routine-result.mjs`
- `apps/desktop/src/shared/core-src/runtime/github/contract.mjs`
- `apps/desktop/src/shared/core-src/runtime/shared/handoff-artifacts.mjs`
- `apps/desktop/src/shared/core-src/runtime/shared/routine-trigger.mjs`
- `apps/desktop/src/shared/core-src/runtime/shared/shell-output-summary.mjs`
- `apps/desktop/src/shared/core-src/runtime/shared/transcript-metadata.mjs`
- `apps/desktop/src/shared/desktop-notice.ts`
- `apps/desktop/src/shared/desktop-pet.ts`
- `apps/desktop/src/shared/file-downloads.ts`
- `apps/desktop/src/shared/file-extension.ts`
- `apps/desktop/src/shared/file-preview.ts`
- `apps/desktop/src/shared/host-display-preferences.ts`
- `apps/desktop/src/shared/list-delta.ts`
- `apps/desktop/src/shared/local-files.ts`
- `apps/desktop/src/shared/native-file-save.ts`
- `apps/desktop/src/shared/orchestration-mode.ts`
- `apps/desktop/src/shared/project-recovery.ts`
- `apps/desktop/src/shared/provider-models.ts`
- `apps/desktop/src/shared/remote-browser.ts`
- `apps/desktop/src/shared/remote-catalog.ts`
- `apps/desktop/src/shared/remote-e2ee-compression.ts`
- `apps/desktop/src/shared/remote-payload-limit.ts`
- `apps/desktop/src/shared/remote-roster-cache.ts`
- `apps/desktop/src/shared/remote-trust.ts`
- `apps/desktop/src/shared/remote-view-baseline.ts`
- `apps/desktop/src/shared/remote-view-resume.ts`
- `apps/desktop/src/shared/remote-webrtc.ts`
- `apps/desktop/src/shared/remote-window.ts`
- `apps/desktop/src/shared/sandbox-storage-shim.ts`
- `apps/desktop/src/shared/secure-desktop-grant.ts`
- `apps/desktop/src/shared/settings-changed.ts`
- `apps/desktop/src/shared/streaming-partial.ts`
- `apps/desktop/src/shared/streaming-text-append.ts`
- `apps/desktop/src/shared/surface-class.ts`
- `apps/desktop/src/shared/terminal-activity.ts`
- `apps/desktop/src/shared/terminal-command.ts`
- `apps/desktop/src/shared/terminal-size-owner.ts`
- `apps/desktop/src/shared/transcript-read-diagnostics.ts`
- `apps/desktop/src/shared/ui-language.ts`
- `apps/desktop/src/shared/visualize-annotations.ts`
- `apps/desktop/src/shared/visualize.ts`
- `apps/relay/lib/feedback-attachments.mjs`
- `packages/protocol-client/src/api.ts`
- `packages/protocol-client/src/client.ts`
- `packages/protocol-client/src/method-table.ts`
- `packages/protocol-client/src/mock.ts`
- `packages/protocol-client/src/obj.ts`
- `packages/protocol-client/src/rows.ts`
- `packages/protocol-client/src/rows/err-text.mjs`
- `packages/protocol-client/src/rows/error-presentation.mjs`
- `packages/protocol-client/src/rows/index.mjs`
- `packages/protocol-client/src/rows/model-display.mjs`
- `packages/protocol-client/src/rows/provider-error-kind.mjs`
- `packages/protocol-client/src/rows/provider-timeout-phase.mjs`
- `packages/protocol-client/src/rows/result-classification.mjs`
- `packages/protocol-client/src/rows/time-format.mjs`
- `packages/protocol-client/src/rows/tool-card-model/git-result.mjs`
- `packages/protocol-client/src/rows/tool-card-model/media-result.mjs`
- `packages/protocol-client/src/rows/tool-primitives.mjs`
- `packages/protocol-client/src/rows/tool-result-status.mjs`
- `packages/protocol-client/src/rows/tool-result-summary.mjs`
- `packages/protocol-client/src/rows/tool-result-text.mjs`
- `packages/protocol-client/src/rows/tool-status.mjs`
- `packages/protocol-client/src/rows/tool-surface.mjs`
- `packages/protocol-client/src/rows/tool-work-units.mjs`
- `packages/protocol-client/src/rows/transport-error-text.mjs`
- `packages/protocol-client/src/session-state.ts`
- `src/runtime/shared/bot-hops.mjs`
- `src/runtime/shared/clean.mjs`
- `src/runtime/shared/shell-display.mjs`
- `src/runtime/shared/task-notification-envelope.mjs`
- `src/runtime/shared/tool-execution-contract.mjs`

## Not imports, but also read from the desktop tree

These are not checked by the script; they are listed so a deletion keeps them too.

- apps/desktop/src/renderer/desktop-api.d.ts: named in the `include` of apps/mobile/tsconfig.json.
- apps/desktop/src/renderer/public/mixdog.svg: copied by apps/mobile/scripts/build-web.mjs.
- packages/protocol/src/index.ts: reached as `@mixdog/protocol` through packages/protocol-client.

apps/desktop/src/renderer/remote-protocol-terminal.ts and apps/desktop/src/shared/terminal-protocol.ts are not
imported by the phone sources at present; if a phone file starts importing them, they join the list (the script reports it).
