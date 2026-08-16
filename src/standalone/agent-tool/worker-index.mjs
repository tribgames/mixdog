// Worker-index persistence for the agent tool: the on-disk row store (tag →
// session), its mtime-keyed parse cache, the batched atomic writer and the
// tag-map projection. Extracted from agent-tool.mjs, which now owns spawn /
// dispatch flow only. The tag Maps are passed in by reference so the facade
// and this store observe the same live state.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { updateJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { resolveAgentTerminalReapMs } from '../../session-runtime/config-helpers.mjs';
import { WORKER_INDEX_FILE } from './tool-def.mjs';
import { agentTagOf, clean, positiveInt, rowMatchesContext } from './helpers.mjs';
import {
  applyWorkerRowUpsert,
  isDeadWorkerStatus,
  isLeadPoolAgent,
  normalizeTagTombstones,
  tagTombstoneKey,
  workerRowKey,
  workerRowTime,
} from './worker-rows.mjs';

export function createWorkerIndex({ dataDir, cfgMod, mgr, tags, tagAgents, tagCwds }) {
  const pendingMutators = [];
  let flushTimer = null;
  // Mtime-keyed parse cache. A single spawn calls refreshTagsFromSessions /
  // resolveTag / nextTag, which each re-read and re-parse this file; across a
  // parallel fanout that is O(spawns^2) synchronous reads of the same bytes.
  let cache = null; // { mtimeMs, size, rows, tombstones }
  let cacheDirty = true;

  function workerIndexPath() {
    return dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  }

  // A terminal row ages out after the configured reap window so the index does
  // not grow without bound; live rows are always kept.
  function keepWorkerRow(row = {}) {
    if (!clean(row.tag) || !clean(row.sessionId)) return false;
    const t = workerRowTime(row);
    if (!t) return true;
    if (!isDeadWorkerStatus(row.status || row.stage)) return true;
    const reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row.provider);
    return reapMs == null || Date.now() - t < reapMs;
  }

  function normalizeWorkerRows(value) {
    const source = Array.isArray(value?.workers)
      ? value.workers
      : (value?.workers && typeof value.workers === 'object'
        ? Object.values(value.workers)
        : (Array.isArray(value) ? value : []));
    return source
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        tag: clean(row.tag),
        sessionId: clean(row.sessionId),
        ownerSessionId: clean(row.ownerSessionId || row.parentSessionId) || null,
        agent: clean(row.agent) || null,
        provider: clean(row.provider) || null,
        model: clean(row.model) || null,
        preset: clean(row.preset) || null,
        effort: clean(row.effort) || null,
        fast: row.fast === true ? true : (row.fast === false ? false : null),
        status: clean(row.status) || 'idle',
        stage: clean(row.stage) || clean(row.status) || 'idle',
        createdAt: clean(row.createdAt) || null,
        updatedAt: clean(row.updatedAt) || null,
        lastUsedAt: clean(row.lastUsedAt) || null,
        finishedAt: clean(row.finishedAt) || null,
        turnStartedAt: clean(row.turnStartedAt) || null,
        clientHostPid: positiveInt(row.clientHostPid),
        cwd: clean(row.cwd) || null,
        task_id: clean(row.task_id || row.taskId) || null,
        error: clean(row.error) || null,
        permission: clean(row.permission) || null,
        toolPermission: clean(row.toolPermission) || null,
        messages: positiveInt(row.messages) || 0,
        tools: positiveInt(row.tools) || 0,
      }))
      .filter((row) => !isLeadPoolAgent(row.agent))
      .filter((row) => !isLeadPoolAgent(row.agent) && keepWorkerRow(row));
  }

  function invalidateCache() {
    cacheDirty = true;
  }

  function readAllWorkerRows() {
    const file = workerIndexPath();
    if (!file) return [];
    let st = null;
    try { st = statSync(file); } catch { cache = null; return []; }
    if (!cacheDirty && cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.rows;
    }
    let rows = [];
    let tombstones = [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      rows = normalizeWorkerRows(parsed);
      tombstones = normalizeTagTombstones(parsed);
    } catch {
      rows = [];
      tombstones = [];
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, rows, tombstones };
    cacheDirty = false;
    return rows;
  }

  function readAllTagTombstones() {
    readAllWorkerRows();
    return cache?.tombstones || [];
  }

  function readTagTombstones(context = {}) {
    return readAllTagTombstones().filter((row) => rowMatchesContext(row, context));
  }

  function readWorkerRows(context = {}) {
    const rows = readAllWorkerRows();
    if (rows.length === 0) return rows;
    return rows.filter((row) => rowMatchesContext(row, context));
  }

  // Single writer path: every mutation re-reads under the file lock, applies
  // the caller's mutator over keyed maps, then republishes rows + tombstones.
  function writeWorkerRows(mutator) {
    const file = workerIndexPath();
    if (!file || typeof mutator !== 'function') return null;
    try {
      const result = updateJsonAtomicSync(file, (cur) => {
        const byKey = new Map();
        for (const row of normalizeWorkerRows(cur)) {
          const key = workerRowKey(row);
          if (key) byKey.set(key, row);
        }
        const tombstonesByKey = new Map();
        for (const row of normalizeTagTombstones(cur, { cap: false })) {
          tombstonesByKey.set(tagTombstoneKey(row), row);
        }
        const priorityTombstoneKeys = new Set();
        mutator(byKey, tombstonesByKey, priorityTombstoneKeys);
        const workers = {};
        for (const row of [...byKey.values()].filter(keepWorkerRow)) {
          const key = workerRowKey(row);
          if (key) workers[key] = row;
        }
        const tombstones = {};
        for (const row of normalizeTagTombstones(
          { tombstones: [...tombstonesByKey.values()] },
          { priorityKeys: priorityTombstoneKeys },
        )) {
          tombstones[tagTombstoneKey(row)] = row;
        }
        return { version: 2, updatedAt: new Date().toISOString(), workers, tombstones };
      }, { lock: true });
      // This process just rewrote the index; force the next read to re-parse
      // even if the new mtime/size happen to collide with the cached stat.
      invalidateCache();
      return result;
    } catch {
      return null;
    }
  }

  // Spawn-path writes are batched onto one microtask so a parallel fanout pays
  // a single locked rewrite instead of one per worker.
  function flushWorkerIndexMutations() {
    if (flushTimer) {
      try { clearImmediate(flushTimer); } catch { /* already fired */ }
      flushTimer = null;
    }
    if (pendingMutators.length === 0) return;
    const batch = pendingMutators.splice(0, pendingMutators.length);
    writeWorkerRows((byKey) => {
      for (const mutator of batch) {
        try { mutator(byKey); } catch { /* one bad row never drops the batch */ }
      }
    });
  }

  function queueWorkerIndexMutation(mutator) {
    if (typeof mutator !== 'function') return false;
    if (!workerIndexPath()) return false;
    pendingMutators.push(mutator);
    if (!flushTimer) {
      flushTimer = setImmediate(flushWorkerIndexMutations);
      flushTimer.unref?.();
    }
    return true;
  }

  function workerRowFromSession(session, fallbackTag = '', extra = {}) {
    const tag = agentTagOf(session) || clean(fallbackTag) || clean(extra.tag);
    const sessionId = clean(session?.id || extra.sessionId);
    if (!tag || !sessionId) return null;
    const runtime = mgr.getSessionRuntime?.(sessionId);
    const status = clean(extra.status) || (session?.closed === true ? 'closed' : clean(session?.status) || 'idle');
    const stage = clean(extra.stage) || clean(runtime?.stage) || status;
    const nowIso = new Date().toISOString();
    return {
      tag,
      sessionId,
      ownerSessionId: clean(extra.ownerSessionId || extra.parentSessionId)
        || clean(session?.ownerSessionId || session?.parentSessionId)
        || null,
      agent: clean(extra.agent) || clean(session?.agent) || null,
      provider: clean(extra.provider) || clean(session?.provider) || null,
      model: clean(extra.model) || clean(session?.model) || null,
      preset: clean(extra.preset) || clean(session?.presetName) || null,
      effort: clean(extra.effort) || clean(session?.effort) || null,
      fast: extra.fast === true || extra.fast === false ? extra.fast : (session?.fast === true ? true : null),
      status,
      stage,
      createdAt: clean(session?.createdAt) || clean(extra.createdAt) || nowIso,
      updatedAt: clean(extra.updatedAt) || nowIso,
      lastUsedAt: clean(session?.lastUsedAt) || null,
      finishedAt: clean(extra.finishedAt) || null,
      // Turn dispatch stamps this; terminal upserts leave it null and the
      // merge in applyWorkerRowUpsert preserves the running turn's value.
      turnStartedAt: clean(extra.turnStartedAt) || null,
      clientHostPid: positiveInt(extra.clientHostPid) || positiveInt(session?.clientHostPid),
      cwd: clean(session?.cwd) || clean(extra.cwd) || null,
      task_id: clean(extra.task_id || extra.taskId) || null,
      error: clean(extra.error) || null,
      permission: clean(session?.permission) || null,
      toolPermission: clean(session?.toolPermission) || null,
      messages: Array.isArray(session?.messages) ? session.messages.length : 0,
      tools: Array.isArray(session?.tools) ? session.tools.length : 0,
    };
  }

  // Every upsert also projects the row into the in-memory tag maps so tag
  // lookups never wait on a disk round-trip.
  function upsertWorkerRow(row, { defer = false } = {}) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    const bindTag = !isLeadPoolAgent(normalized.agent);
    if (bindTag) {
      tags.set(normalized.tag, normalized.sessionId);
      if (normalized.agent) tagAgents.set(normalized.tag, normalized.agent);
      if (normalized.cwd) tagCwds.set(normalized.tag, normalized.cwd);
    }
    if (defer) return queueWorkerIndexMutation((byKey) => applyWorkerRowUpsert(byKey, normalized));
    writeWorkerRows((byKey) => { applyWorkerRowUpsert(byKey, normalized); });
    return true;
  }

  function upsertWorkerSession(session, fallbackTag = '', extra = {}) {
    return upsertWorkerRow(workerRowFromSession(session, fallbackTag, extra));
  }

  function upsertWorkerSessionDeferred(session, fallbackTag = '', extra = {}) {
    return upsertWorkerRow(workerRowFromSession(session, fallbackTag, extra), { defer: true });
  }

  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
    flushWorkerIndexMutations();
    writeWorkerRows((byKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if ((targetSessionId && row.sessionId === targetSessionId) || (targetTag && row.tag === targetTag)) {
          byKey.delete(key);
        }
      }
    });
  }

  function refreshTagsFromIndex(context = {}) {
    const rows = readWorkerRows(context);
    for (const row of rows) {
      if (!row.tag || !row.sessionId) continue;
      if (isLeadPoolAgent(row.agent)) {
        // Lead pool rows are status projections, not agent-tool children.
        // Purge a projection left by older code so closeAll cannot mistake
        // the owning desktop session for a worker and close it.
        if (tags.get(row.tag) === row.sessionId) {
          tags.delete(row.tag);
          tagAgents.delete(row.tag);
          tagCwds.delete(row.tag);
        }
        continue;
      }
      tags.set(row.tag, row.sessionId);
      if (row.agent) tagAgents.set(row.tag, row.agent);
      if (row.cwd) tagCwds.set(row.tag, row.cwd);
    }
    return rows;
  }

  return {
    workerIndexPath,
    invalidateWorkerRowsCache: invalidateCache,
    readAllWorkerRows,
    readAllTagTombstones,
    readTagTombstones,
    readWorkerRows,
    writeWorkerRows,
    flushWorkerIndexMutations,
    queueWorkerIndexMutation,
    workerRowFromSession,
    upsertWorkerRow,
    upsertWorkerSession,
    upsertWorkerSessionDeferred,
    removeWorkerRow,
    refreshTagsFromIndex,
  };
}
