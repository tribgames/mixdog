// agent-tree/agent-cancel.mjs
// Cancelling an agent subtree: descendants first, then a durable canonical
// close of the session itself. Concurrent cancels of one id share a run.
import { cancelBackgroundTasks } from '../../../runtime/shared/background-tasks.mjs';

export function createAgentCancellation({ registry, rehydrateAgentSessions, sessionOwner, entryForSession, log }) {
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
      const descriptor = registry.get(id);
      if (!descriptor) return children.length > 0;
      if (descriptor.closed) return true;
      const entry = await closableEntry(id, descriptor);
      const closeCanonical = entry?.runtime?.closeCanonicalSession;
      if (typeof closeCanonical !== 'function') {
        throw new TypeError('session runtime must implement closeCanonicalSession');
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
