// Worker-index persistence for the agent tool: the on-disk row store (tag →
// session) and its tag-map projection. agent-tool.mjs owns spawn / dispatch
// flow only. The tag Maps are passed in by reference so the facade and this
// store observe the same live state. The pieces live under ./worker-index/:
//   row-shape      — one row shape; session → row projection
//   row-store      — the file, its parse cache, the locked writer
//   mutation-batch — spawn-path writes coalesced onto one immediate
//   row-liveness   — stale-active detection and idle settlement
//   row-reads          — scoped row and tag-tombstone reads
//   row-writes         — upserts, removal, the owner's release mark
//   awaiting-user-sync — approval waits kept in step with the runtime
//   restart-settlement — rows a process exit or restart ended
//   disposal           — drain, then release the registrations
import { resolve } from 'node:path';

import { WORKER_INDEX_FILE } from './tool-def.mjs';
import { registerExitFlush, rowMatchesContext } from './helpers.mjs';
import { registerApprovalWaitWriter } from './worker-index/approval-wait.mjs';
import { createAwaitingUserSync } from './worker-index/awaiting-user-sync.mjs';
import { createIndexDisposal } from './worker-index/disposal.mjs';
import { createMutationBatch } from './worker-index/mutation-batch.mjs';
import { createRestartSettlement } from './worker-index/restart-settlement.mjs';
import { createWorkerRowReads } from './worker-index/row-reads.mjs';
import { acquireWorkerRowStore } from './worker-index/row-store.mjs';
import { createWorkerRowWrites } from './worker-index/row-writes.mjs';
import { onSessionTurnStart } from '../../../runtime/shared/session-activity-signal.mjs';

export function createWorkerIndex({ dataDir, cfgMod, mgr, tags, tagAgents, tagCwds }) {
  const file = dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  // Shared with every other worker index of this process over the same file.
  const { store, release: releaseStore } = acquireWorkerRowStore(file);
  const awaitingUser = createAwaitingUserSync(store, mgr);
  const batch = createMutationBatch(store.write, awaitingUser.reconcileDeferred);
  const settlement = createRestartSettlement({ store, cfgMod, mgr });
  const { readWorkerRows, readAllTagTombstones } = createWorkerRowReads(store, mgr);

  // Every upsert also projects the row into the in-memory tag maps so tag
  // lookups never wait on a disk round-trip.
  function bindTag(row) {
    tags.set(row.tag, row.sessionId);
    if (row.agent) tagAgents.set(row.tag, row.agent);
    if (row.cwd) tagCwds.set(row.tag, row.cwd);
  }

  const { upsertWorkerRow, rowFromSession, markReleased, removeWorkerRow } = createWorkerRowWrites({
    file,
    store,
    batch,
    mgr,
    bindTag,
    settlement,
    awaitingUser,
  });

  // The one boundary every turn start passes through (user input, an answer,
  // auto-resume, a send, a room/bot turn): the session is in use again, for
  // good, whatever started the turn.
  const stopTurnStartListener = onSessionTurnStart((sessionId) => store.clearReleased(sessionId));

  function refreshTagsFromIndex(context = {}) {
    const rows = readWorkerRows(context);
    for (const row of rows) bindTag(row);
    return rows;
  }

  function flushWorkerIndexOnExit() {
    batch.flush();
    settlement.flushActiveWorkerRows();
    // Writes are persisted by an async queue; the loop is gone at exit. This
    // is the best-effort last resort: a persist still running is left alone
    // (the graceful shutdown path drains before exit).
    store.flushSync();
  }

  settlement.recoverStaleWorkerRows();
  const unregisterExitFlush = registerExitFlush(flushWorkerIndexOnExit);
  const unregisterApprovalWaits = registerApprovalWaitWriter(file, awaitingUser.setAwaitingUser);

  function teardown() {
    stopTurnStartListener();
    unregisterExitFlush();
    unregisterApprovalWaits();
    releaseStore();
  }

  const { dispose, disposeAsync } = createIndexDisposal({ batch, store, teardown });

  return {
    dispose,
    disposeAsync,
    workerIndexPath: () => file,
    invalidateWorkerRowsCache: store.invalidate,
    readAllWorkerRows: store.readAll,
    readAllTagTombstones,
    readTagTombstones: (context = {}) => readAllTagTombstones().filter((row) => rowMatchesContext(row, context)),
    readWorkerRows,
    writeWorkerRows: store.write,
    flushWorkerIndexMutations: batch.flush,
    /** Resolves once every queued index write is on disk. */
    flushWorkerIndexWrites: async () => {
      batch.flush();
      await store.flush();
    },
    queueWorkerIndexMutation: (mutator) => (file ? batch.queue(mutator) : false),
    workerRowFromSession: rowFromSession,
    upsertWorkerRow,
    upsertWorkerSession: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra)),
    upsertWorkerSessionDeferred: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra), { defer: true }),
    removeWorkerRow,
    markReleased,
    setAwaitingUser: awaitingUser.setAwaitingUser,
    refreshTagsFromIndex,
    flushActiveWorkerRows: settlement.flushActiveWorkerRows,
    flushWorkerIndexOnExit,
    recoverStaleWorkerRows: settlement.recoverStaleWorkerRows,
    pendingRestartFailures: settlement.pendingRestartFailures,
    markRestartNotified: settlement.markRestartNotified,
  };
}
