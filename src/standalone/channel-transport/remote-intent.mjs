/**
 * remote-intent.mjs — the durable record of a manual Remote ON: which session
 * (and transcript) the pin belongs to, persisted so a daemon restart can
 * restore it. Restoring that intent is ./remote-binding.mjs's job; this module
 * only owns the file and the pinned-session fields derived from it.
 *
 * Shared transport state written here: pinnedSessionId, remoteIntent.
 */
import { rmSync } from 'node:fs';
import { writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { normalizeRemoteIntent } from '../channel-binding.mjs';

export function createRemoteIntentStore({ state, log, remoteIntentPath }) {
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

  return { writeRemoteIntent, clearRemoteIntent };
}
