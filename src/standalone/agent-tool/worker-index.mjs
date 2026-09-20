// Worker-index persistence for the agent tool: the on-disk row store (tag →
// session) and its tag-map projection. agent-tool.mjs owns spawn / dispatch
// flow only. The tag Maps are passed in by reference so the facade and this
// store observe the same live state. The pieces live under ./worker-index/:
//   row-shape      — one row shape; session → row projection
//   row-store      — the file, its parse cache, the locked writer
//   mutation-batch — spawn-path writes coalesced onto one microtask
//   row-liveness   — stale-active detection and idle settlement
import { resolve } from 'node:path';

import { WORKER_INDEX_FILE } from './tool-def.mjs';
import { clean, positiveInt, registerExitFlush, rowMatchesContext } from './helpers.mjs';
import { applyWorkerRowUpsert, workerRowKey } from './worker-rows.mjs';
import { createMutationBatch } from './worker-index/mutation-batch.mjs';
import { createRowLiveness, isActiveWorkerRow } from './worker-index/row-liveness.mjs';
import { normalizeWorkerRows, workerRowFromSession } from './worker-index/row-shape.mjs';
import { createWorkerRowStore } from './worker-index/row-store.mjs';

export function createWorkerIndex({ dataDir, cfgMod, mgr, tags, tagAgents, tagCwds }) {
  const file = dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  const store = createWorkerRowStore(file);
  const batch = createMutationBatch(store.write);
  const liveness = createRowLiveness({ dataDir, cfgMod });
  // Rows this process marked active; settled to idle on exit so a crash of
  // the host never leaves them "running" forever.
  const activeWorkerKeys = new Set();

  function readWorkerRows(context = {}) {
    const rows = store.readAll();
    if (rows.length === 0) return rows;
    return rows.filter((row) => rowMatchesContext(row, context));
  }

  // Every upsert also projects the row into the in-memory tag maps so tag
  // lookups never wait on a disk round-trip.
  function bindTag(row) {
    tags.set(row.tag, row.sessionId);
    if (row.agent) tagAgents.set(row.tag, row.agent);
    if (row.cwd) tagCwds.set(row.tag, row.cwd);
  }

  function upsertWorkerRow(row, { defer = false } = {}) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    const key = workerRowKey(normalized);
    if (isActiveWorkerRow(normalized)) activeWorkerKeys.add(key);
    else activeWorkerKeys.delete(key);
    bindTag(normalized);
    if (defer) return file ? batch.queue((byKey) => applyWorkerRowUpsert(byKey, normalized)) : false;
    store.write((byKey) => {
      applyWorkerRowUpsert(byKey, normalized);
    });
    return true;
  }

  const rowFromSession = (session, fallbackTag = '', extra = {}) =>
    workerRowFromSession(session, fallbackTag, extra, (sessionId) => mgr.getSessionRuntime?.(sessionId));

  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
    batch.flush();
    store.write((byKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if ((targetSessionId && row.sessionId === targetSessionId) || (targetTag && row.tag === targetTag)) {
          byKey.delete(key);
        }
      }
    });
  }

  function refreshTagsFromIndex(context = {}) {
    const rows = readWorkerRows(context);
    for (const row of rows) bindTag(row);
    return rows;
  }

  function flushActiveWorkerRows() {
    if (!activeWorkerKeys.size) return;
    const keys = [...activeWorkerKeys];
    activeWorkerKeys.clear();
    const now = Date.now();
    store.write((byKey) => {
      for (const key of keys) {
        const current = byKey.get(key);
        if (!current || positiveInt(current.runtimePid) !== process.pid) continue;
        if (isActiveWorkerRow(current)) byKey.set(key, liveness.idleRow(current, now, true));
      }
    });
  }

  function recoverStaleWorkerRows() {
    const now = Date.now();
    const stale = store.readAll().filter((row) => liveness.isStaleActive(row, now));
    if (!stale.length) return false;
    store.write((byKey) => {
      for (const row of stale) {
        const key = workerRowKey(row);
        const current = byKey.get(key);
        if (!current || !liveness.isStaleActive(current, now)) continue;
        byKey.set(key, liveness.idleRow(current, now));
      }
    });
    return true;
  }

  function flushWorkerIndexOnExit() {
    batch.flush();
    flushActiveWorkerRows();
  }

  recoverStaleWorkerRows();
  registerExitFlush(flushWorkerIndexOnExit);

  return {
    workerIndexPath: () => file,
    invalidateWorkerRowsCache: store.invalidate,
    readAllWorkerRows: store.readAll,
    readAllTagTombstones: store.readTombstones,
    readTagTombstones: (context = {}) => store.readTombstones().filter((row) => rowMatchesContext(row, context)),
    readWorkerRows,
    writeWorkerRows: store.write,
    flushWorkerIndexMutations: batch.flush,
    queueWorkerIndexMutation: (mutator) => (file ? batch.queue(mutator) : false),
    workerRowFromSession: rowFromSession,
    upsertWorkerRow,
    upsertWorkerSession: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra)),
    upsertWorkerSessionDeferred: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra), { defer: true }),
    removeWorkerRow,
    refreshTagsFromIndex,
    flushActiveWorkerRows,
    flushWorkerIndexOnExit,
    recoverStaleWorkerRows,
  };
}
