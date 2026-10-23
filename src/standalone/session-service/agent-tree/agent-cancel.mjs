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
  const agentCloseRuns = new Map();

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

  function closeOne(id, reason, options) {
    const active = agentCloseRuns.get(id);
    if (active) return active;
    let run;
    run = Promise.resolve()
      .then(async () => {
        cancelBackgroundTasks({
          surface: 'agent',
          callerSessionId: id,
          reason,
        });
        cancelOwnAgentTasks(id, reason);
        const descriptor = registry.get(id);
        if (!descriptor) return false;
        if ((await sessionOwner(id)?.runtime?.isSessionTerminal?.()) === true) return true;
        const entry = await closableEntry(id, descriptor);
        const closeCanonical = entry?.runtime?.closeCanonicalSession;
        if (typeof closeCanonical !== 'function') {
          throw new TypeError('session runtime must implement closeCanonicalSession');
        }
        const wasRunning = descriptor.status === 'running';
        // The close clears the transcript: capture a running turn's transcript
        // first so the cancelled turn still hands off its partial output.
        if (wasRunning) {
          try {
            const { messages } = await entry.runtime.readModelMessages(0);
            rememberCancelTranscript(id, messages);
          } catch (error) {
            log(`agent cancel transcript read failed session=${id}: ${error?.message || error}`);
          }
        }
        const closed = await closeCanonical.call(entry.runtime, reason, { tombstone: options.tombstone === true });
        if (closed !== true) throw new Error(`agent session ${id} could not be durably closed`);
        descriptor.closed = options.tombstone === true;
        // Only a close that stopped a running turn is a cancellation; closing a
        // finished agent (cleanup after its handoff) keeps its last status.
        if (descriptor.closed) descriptor.status = 'closed';
        else if (wasRunning) descriptor.status = 'cancelled';
        descriptor.stage = descriptor.status;
        descriptor.updatedAt = Date.now();
        return true;
      })
      .finally(() => {
        if (agentCloseRuns.get(id) === run) agentCloseRuns.delete(id);
      });
    agentCloseRuns.set(id, run);
    return run;
  }

  async function cancelAgentTree(sessionId, reason = 'agent session cancelled', options = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return false;
    await rehydrateAgentSessions();
    const seen = new Set();
    const ordered = [];
    const visit = (current) => {
      if (seen.has(current)) return;
      seen.add(current);
      for (const child of registry.childrenOf(current)) visit(child);
      ordered.push(current);
    };
    visit(id);
    const release = registry.beginCancellation(ordered);
    try {
      let closed = false;
      const failures = [];
      // Descendant-first, one at a time; a failed member never skips the rest.
      for (const current of ordered) {
        try {
          closed = (await closeOne(current, reason, options)) || closed;
        } catch (error) {
          log(`agent cancel failed session=${current}: ${error?.message || error}`);
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        const details = failures.map((error) => error?.message || String(error)).join('; ');
        throw new AggregateError(
          failures,
          `agent tree cancel failed for ${failures.length} of ${ordered.length} sessions: ${details}`
        );
      }
      return closed;
    } finally {
      release();
    }
  }

  async function cancelAgentDescendants(parentSessionId, reason = 'parent session cancelled') {
    await rehydrateAgentSessions();
    const parentId = String(parentSessionId || '');
    const release = registry.beginCancellation([parentId]);
    try {
      cancelBackgroundTasks({
        surface: 'agent',
        callerSessionId: parentId,
        reason,
      });
      const children = registry.childrenOf(parentId);
      if (!children.length) return false;
      await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
      return true;
    } finally {
      release();
    }
  }

  return { cancelAgentTree, cancelAgentDescendants };
}
