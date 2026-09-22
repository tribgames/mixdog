/**
 * remote-binding.mjs — the durable Remote pin of the channel transport: the
 * exclusive chain every binding call runs on, and the boot restore of a
 * persisted remote intent. The intent file itself lives in ./remote-intent.mjs
 * and the derived remote-session state in ./remote-state.mjs; both are wired
 * here so callers keep one binding facade.
 *
 * Shared transport state read/written here: pinnedSessionId, remoteIntent,
 * remoteAcquired, stickyRemoteFrame, closed.
 */
import { ACTIVATE_TOOL } from '../channel-binding.mjs';
import { createRemoteIntentStore } from './remote-intent.mjs';
import { createRemoteStatePublisher } from './remote-state.mjs';

// Sticky replay cache for the bridge remote-state notify. The daemon emits
// 'notifications/mixdog/remote' {state:'acquired'} at boot (and 'superseded'
// on repoint). That is a STATE signal, not an inbound message: every TUI must
// observe the current remote-enabled state, and a late/non-pointer TUI that
// attaches after the one-shot notify would otherwise never learn it. Inbound
// channel messages bypass this transport and submit directly to the pinned
// session through the daemon session service.
export const REMOTE_STATE_METHOD = 'notifications/mixdog/remote';

export function remoteStateFrame(state) {
  return JSON.stringify({ type: 'notify', method: REMOTE_STATE_METHOD, params: { state } });
}

export function createRemoteBinding({
  state,
  handleCall,
  log,
  remoteStatePath,
  remoteIntentPath,
  onRemoteStateChange,
}) {
  // Binding calls (manual ON/OFF, rebind) mutate GLOBAL pointer/pin state after
  // reading it. The control lane is unbounded, so two sessions toggling at once
  // would interleave read and write and clobber each other's binding. Every
  // binding call therefore runs alone on this chain.
  let bindingChain = Promise.resolve();
  let remoteRestorePromise = null;
  const publishRemoteState = createRemoteStatePublisher({ state, log, remoteStatePath, onRemoteStateChange });
  const { writeRemoteIntent, clearRemoteIntent } = createRemoteIntentStore({ state, log, remoteIntentPath });

  function runExclusiveBinding(run) {
    const result = bindingChain.then(run, run);
    bindingChain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  function restoreRemoteIntent() {
    const intent = state.remoteIntent;
    if (state.closed || !intent) return Promise.resolve(false);
    if (state.remoteAcquired) return Promise.resolve(true);
    if (remoteRestorePromise) return remoteRestorePromise;
    const restore = runExclusiveBinding(async () => {
      if (state.closed || state.remoteIntent !== intent || state.pinnedSessionId !== intent.sessionId) return false;
      try {
        const result = await handleCall(
          ACTIVATE_TOOL,
          {
            active: true,
            sessionId: intent.sessionId,
            transcriptPath: intent.transcriptPath,
            restore: true,
          },
          {
            clientToken: null,
            leadPid: null,
            cwd: intent.cwd,
          }
        );
        if (result?.isError === true) {
          throw new Error(result?.content?.[0]?.text || 'restored activation failed');
        }
        if (!state.closed && state.remoteIntent === intent) {
          state.remoteAcquired = true;
          state.pinnedSessionId = intent.sessionId;
          state.stickyRemoteFrame = remoteStateFrame('acquired');
          log(`remote intent restored session=${intent.sessionId}`);
          publishRemoteState();
          return true;
        }
      } catch (err) {
        log(`remote intent restore failed session=${intent.sessionId}: ${err?.message || err}`);
      }
      return false;
    }).finally(() => {
      if (remoteRestorePromise === restore) remoteRestorePromise = null;
    });
    remoteRestorePromise = restore;
    return restore;
  }

  return { runExclusiveBinding, writeRemoteIntent, clearRemoteIntent, restoreRemoteIntent, publishRemoteState };
}
