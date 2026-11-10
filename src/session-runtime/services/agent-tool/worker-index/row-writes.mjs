// worker-index/row-writes.mjs
// Row upserts (immediate or batched), removal, and the owner's release mark:
// every upsert projects the row into the tag maps (`bindTag`), tracks whether
// this process runs it, and brings its approval wait in step.
import { clean } from '../helpers.mjs';
import { applyWorkerRowUpsert, workerRowKey } from '../worker-rows.mjs';
import { isUnnotifiedRestartFailure } from './row-liveness.mjs';
import { normalizeWorkerRows, workerRowFromSession } from './row-shape.mjs';

export function createWorkerRowWrites({ file, store, batch, mgr, bindTag, settlement, awaitingUser }) {
  function upsertWorkerRow(row, { defer = false } = {}) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    const key = workerRowKey(normalized);
    settlement.trackActiveRow(key, normalized);
    bindTag(normalized);
    if (defer) {
      if (!file) return false;
      awaitingUser.deferReconcile(normalized.sessionId);
      return batch.queue((byKey) => applyWorkerRowUpsert(byKey, normalized));
    }
    store.write((byKey) => {
      applyWorkerRowUpsert(byKey, normalized);
    });
    awaitingUser.reconcileAwaitingUser(normalized.sessionId);
    return true;
  }

  // A session its owner closed keeps `released` on every row written for it,
  // until a turn starts on it.
  const rowFromSession = (session, fallbackTag = '', extra = {}) => {
    const row = workerRowFromSession(session, fallbackTag, extra, (sessionId) => mgr.getSessionRuntime?.(sessionId));
    return row && store.isReleased(row.sessionId) ? { ...row, released: true } : row;
  };

  /** Persist that the owner closed these sessions (survives a restart). */
  function markReleased(sessionIds) {
    store.markReleased(sessionIds.map(clean).filter(Boolean));
  }

  // A row whose owner is still owed its restart failure stays: closing the
  // worker (a process exit closes every one) must not lose that result.
  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
    batch.flush();
    store.write((byKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if (isUnnotifiedRestartFailure(row)) continue;
        if ((targetSessionId && row.sessionId === targetSessionId) || (targetTag && row.tag === targetTag)) {
          byKey.delete(key);
        }
      }
    });
  }

  return { upsertWorkerRow, rowFromSession, markReleased, removeWorkerRow };
}
