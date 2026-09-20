/**
 * remote-binding.mjs — the durable Remote pin of the channel transport: the
 * persisted remote intent (session + transcript a manual ON pinned), its
 * restore on daemon boot, the exclusive chain every binding call runs on,
 * and publication of the derived remote-session state (listener + file).
 *
 * Shared transport state read/written here: pinnedSessionId, remoteIntent,
 * remoteAcquired, stickyRemoteFrame, pointerToken (for the published cwd),
 * clients, closed.
 */
import { rmSync } from 'node:fs';
import { writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { ACTIVATE_TOOL, normalizeRemoteIntent } from '../channel-binding.mjs';

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
  let remoteStateSignature = '';

  function runExclusiveBinding(run) {
    const result = bindingChain.then(run, run);
    bindingChain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  function writeRemoteIntent(args, sessionId, cwd = null) {
    state.pinnedSessionId = sessionId;
    if (!remoteIntentPath) return;
    const intent = normalizeRemoteIntent({
      sessionId,
      transcriptPath: args?.transcriptPath,
      cwd,
      updatedAt: Date.now(),
    });
    if (!intent) {
      log(`remote intent not persisted: session/transcript mismatch session=${sessionId || '?'}`);
      return;
    }
    state.remoteIntent = intent;
    try {
      writeJsonAtomicSync(remoteIntentPath, intent, { compact: true });
    } catch (err) {
      log(`remote intent write failed: ${err?.message || err}`);
    }
  }

  function clearRemoteIntent(reason, sessionId = null) {
    const expectedSessionId = String(sessionId || '').trim();
    if (expectedSessionId && state.pinnedSessionId !== expectedSessionId) return false;
    state.pinnedSessionId = null;
    state.remoteIntent = null;
    if (remoteIntentPath) {
      try {
        rmSync(remoteIntentPath, { force: true });
      } catch (err) {
        log(`remote intent clear failed (${reason}): ${err?.message || err}`);
      }
    }
    log(`remote intent cleared (${reason})`);
    return true;
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

  function publishRemoteState() {
    const pointerClient = state.pointerToken ? state.clients.get(state.pointerToken) : null;
    const sessionId = String(state.remoteAcquired ? state.pinnedSessionId : '');
    const remoteState = {
      enabled: state.remoteAcquired === true && Boolean(sessionId),
      sessionId: state.remoteAcquired === true && sessionId ? sessionId : null,
      cwd: pointerClient?.cwd ?? state.remoteIntent?.cwd ?? null,
      daemonPid: process.pid,
      updatedAt: Date.now(),
    };
    const signature = JSON.stringify([
      remoteState.enabled,
      remoteState.sessionId,
      remoteState.cwd,
      remoteState.daemonPid,
    ]);
    if (signature === remoteStateSignature) return;
    remoteStateSignature = signature;
    if (typeof onRemoteStateChange === 'function') {
      try {
        onRemoteStateChange(remoteState);
      } catch (err) {
        log(`remote session state listener failed: ${err?.message || err}`);
      }
    }
    if (!remoteStatePath) return;
    try {
      writeJsonAtomicSync(remoteStatePath, remoteState, { compact: true });
    } catch (err) {
      log(`remote session state write failed: ${err?.message || err}`);
    }
  }

  return { runExclusiveBinding, writeRemoteIntent, clearRemoteIntent, restoreRemoteIntent, publishRemoteState };
}
