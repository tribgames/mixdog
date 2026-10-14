// agent-tree/agent-cancel.mjs
// Cancelling an agent subtree: descendants first, then a durable canonical
// close of the session itself. Concurrent cancels of one id share a run.
import {
  cancelBackgroundTask,
  cancelBackgroundTasks,
  listBackgroundTasks,
} from '../../../runtime/shared/background-tasks.mjs';

// Cancel the running Agent task(s) bound to this session itself (owned by its
// parent) BEFORE the session closes, so the owner hears `cancelled` with the
// turn's partial output instead of the closed turn failing the task.
function cancelOwnAgentTasks(sessionId, reason) {
  for (const row of listBackgroundTasks({ surface: 'agent' })) {
    if (row.status === 'running' && row.sessionId === sessionId) cancelBackgroundTask(row.task_id, reason);
  }
}

export function createAgentCancellation({
  registry,
  rehydrateAgentSessions,
  sessionOwner,
  entryForSession,
  log,
  rememberCancelTranscript,
}) {
  const agentCancelRuns = new Map();

  /** The runtime entry that can close this descriptor: the live owner, else a
   *  freshly loaded one (null when loading fails, which is logged). */
  const closableEntry = async (id, descriptor) => {
    const owned = sessionOwner(id);
    if (owned) return owned;
    try {
      return await entryForSession(id, {
        cwd: descriptor.cwd,
        provider: descriptor.provider,
        model: descriptor.model,
        toolMode: 'full',
      });
    } catch (error) {
      log(`agent cancel load failed session=${id}: ${error?.message || error}`);
      return null;
    }
  };

  function cancelAgentTree(sessionId, reason = 'agent session cancelled') {
    const id = String(sessionId || '').trim();
    if (!id) return Promise.resolve(false);
    const active = agentCancelRuns.get(id);
    if (active) return active;
    let run;
    run = (async () => {
      await rehydrateAgentSessions();
      cancelBackgroundTasks({
        surface: 'agent',
        callerSessionId: id,
        reason,
      });
      const children = registry.childrenOf(id);
      await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
      cancelOwnAgentTasks(id, reason);
      const descriptor = registry.get(id);
      if (!descriptor) return children.length > 0;
      if (descriptor.closed) return true;
      const entry = await closableEntry(id, descriptor);
      const closeCanonical = entry?.runtime?.closeCanonicalSession;
      if (typeof closeCanonical !== 'function') {
        throw new TypeError('session runtime must implement closeCanonicalSession');
      }
      // The close clears the transcript: capture a running turn's transcript
      // first so the cancelled turn still hands off its partial output.
      if (descriptor.status === 'running') {
        try {
          const { messages } = await entry.runtime.readModelMessages(0);
          rememberCancelTranscript(id, messages);
        } catch (error) {
          log(`agent cancel transcript read failed session=${id}: ${error?.message || error}`);
        }
      }
      const closed = await closeCanonical.call(entry.runtime, reason);
      if (closed !== true) throw new Error(`agent session ${id} could not be durably closed`);
      descriptor.closed = true;
      descriptor.status = 'closed';
      descriptor.stage = 'closed';
      descriptor.updatedAt = Date.now();
      return true;
    })().finally(() => {
      if (agentCancelRuns.get(id) === run) agentCancelRuns.delete(id);
    });
    agentCancelRuns.set(id, run);
    return run;
  }

  async function cancelAgentDescendants(parentSessionId, reason = 'parent session cancelled') {
    await rehydrateAgentSessions();
    const parentId = String(parentSessionId || '');
    cancelBackgroundTasks({
      surface: 'agent',
      callerSessionId: parentId,
      reason,
    });
    const children = registry.childrenOf(parentId);
    if (!children.length) return false;
    await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
    return true;
  }

  return { cancelAgentTree, cancelAgentDescendants };
}
