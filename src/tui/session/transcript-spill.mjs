/**
 * Transcript spill storage, history paging, and session item-state mutations.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  cleanupStaleTranscriptSpillDirs,
  createSpillDirectories,
  writeOwnerRegistry,
} from './transcript-spill/spill-dir.mjs';
import { createSpillWriter } from './transcript-spill/spill-writer.mjs';

export const TUI_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_DEBUG || ''));
export const tuiDebug = (msg) => {
  if (!TUI_DEBUG) return;
  try {
    process.stderr.write(`[tui] ${msg}\n`);
  } catch {}
};

let _idSeq = 0;
export const nextId = () => `it_${++_idSeq}`;

export const TRANSCRIPT_LIVE_ITEM_CAP = 512;
export const TRANSCRIPT_SPILL_CHUNK_ITEMS = 128;
const TRANSCRIPT_RESTORE_OVERLAP_ITEMS = 64;

export { cleanupStaleTranscriptSpillDirs };

let staleSpillSweepDone = false;

// Serialized pages deliberately release the old item object graph while
// keeping every byte restorable. Only `items` is render-live and walkable.
// This buffer owns the page list, the reading cursor and snapshots; the spill
// directory lifecycle and the worker-backed page writer live under
// ./transcript-spill/.
export function createTranscriptSpillBuffer({
  cap = TRANSCRIPT_LIVE_ITEM_CAP,
  chunkSize = TRANSCRIPT_SPILL_CHUNK_ITEMS,
  // stdout/stderr: worker threads otherwise copy straight into the REAL fds,
  // bypassing the TUI stderr guard and printing over the terminal frame.
  workerFactory = (source) => new Worker(source, { eval: true, stdout: true, stderr: true }),
  onWarning = (message) => tuiDebug(message),
  writeTimeoutMs = 5000,
} = {}) {
  try {
    writeOwnerRegistry();
  } catch {}
  // One sweep per process: it lists the whole temp directory synchronously,
  // and a buffer is created per session.
  if (!staleSpillSweepDone) {
    staleSpillSweepDone = true;
    cleanupStaleTranscriptSpillDirs();
  }
  const pages = [];
  let cursor = null;
  let spillDir = null;
  let pageSequence = 0;
  let warningEmitted = false;
  let spillDisabled = false;
  const snapshots = new Set();
  const dirs = createSpillDirectories();
  const writer = createSpillWriter({
    workerFactory,
    writeTimeoutMs,
    onPinned: (error) => {
      spillDisabled = true;
      if (warningEmitted) return;
      warningEmitted = true;
      try {
        onWarning(`transcript spill write failed; history pinned in memory (${error || 'unknown error'})`);
      } catch {}
    },
  });
  const cleanupRecords = (records, directory) => {
    for (const record of records) {
      record.cancelled = true;
    }
    dirs.release(directory);
  };
  const ensureSpillDir = () => {
    spillDir ||= dirs.create();
    return spillDir;
  };
  const encode = (items) => {
    const page = join(ensureSpillDir(), `${++pageSequence}.json`);
    const record = {
      id: pageSequence,
      path: page,
      pendingItems: items,
      cancelled: false,
      attempts: 0,
      pinned: false,
    };
    writer.enqueue(record);
    return record;
  };
  const decode = (record) => record.pendingItems || JSON.parse(readFileSync(record.path, 'utf8'));
  const restoredWithOverlap = (liveItems) => {
    const restored = decode(pages[cursor]);
    let following = Array.isArray(liveItems) ? liveItems : [];
    if (cursor + 1 < pages.length) following = decode(pages[cursor + 1]);
    return [...restored, ...following.slice(0, TRANSCRIPT_RESTORE_OVERLAP_ITEMS)];
  };
  return {
    get hasOlder() {
      return cursor == null ? pages.length > 0 : cursor > 0;
    },
    get hasNewer() {
      return cursor != null;
    },
    reset() {
      const retained = [...snapshots].some((snapshot) => snapshot.spillDir === spillDir);
      const oldPages = pages.splice(0);
      const oldDir = spillDir;
      cursor = null;
      spillDir = null;
      pageSequence = 0;
      spillDisabled = false;
      warningEmitted = false;
      if (!retained) cleanupRecords(oldPages, oldDir);
    },
    snapshot() {
      const snapshot = {
        pages: pages.slice(),
        cursor,
        spillDir,
        pageSequence,
        spillDisabled,
        warningEmitted,
      };
      snapshots.add(snapshot);
      return snapshot;
    },
    restoreSnapshot(snapshot) {
      if (!snapshot || !snapshots.has(snapshot)) return false;
      if (snapshot.spillDir === spillDir) {
        cursor = snapshot.cursor;
        snapshots.delete(snapshot);
        return true;
      }
      cleanupRecords(pages, spillDir);
      pages.splice(0, pages.length, ...snapshot.pages);
      cursor = snapshot.cursor;
      spillDir = snapshot.spillDir;
      pageSequence = snapshot.pageSequence;
      spillDisabled = snapshot.spillDisabled === true;
      warningEmitted = snapshot.warningEmitted === true;
      snapshots.delete(snapshot);
      return true;
    },
    releaseSnapshot(snapshot) {
      if (!snapshot || !snapshots.delete(snapshot)) return false;
      if (snapshot.spillDir !== spillDir) cleanupRecords(snapshot.pages, snapshot.spillDir);
      return true;
    },
    dispose() {
      cleanupRecords(pages, spillDir);
      for (const snapshot of snapshots) {
        if (snapshot.spillDir !== spillDir) cleanupRecords(snapshot.pages, snapshot.spillDir);
      }
      pages.length = 0;
      snapshots.clear();
      cursor = null;
      spillDir = null;
      dirs.stopHeartbeats();
      writer.dispose();
    },
    get workerCount() {
      return writer.workerCount;
    },
    get pendingWriteCount() {
      return writer.pendingCount;
    },
    get pinnedPageCount() {
      return pages.filter((page) => page.pinned).length;
    },
    get disabled() {
      return spillDisabled;
    },
    capLive(items) {
      let live = Array.isArray(items) ? items : [];
      if (spillDisabled) return live;
      while (live.length > cap) {
        pages.push(encode(live.slice(0, chunkSize)));
        live = live.slice(chunkSize);
      }
      return live;
    },
    restoreOlder(liveItems) {
      const nextCursor = cursor == null ? pages.length - 1 : cursor - 1;
      if (nextCursor < 0) return null;
      cursor = nextCursor;
      return restoredWithOverlap(liveItems);
    },
    restoreNewer(liveItems) {
      if (cursor == null) return null;
      const nextCursor = cursor + 1;
      if (nextCursor >= pages.length) {
        cursor = null;
        return { items: null, atLive: true };
      }
      cursor = nextCursor;
      return restoredWithOverlap(liveItems);
    },
  };
}

export function refillTranscriptViewOverlap(viewItems, previousLiveItems, nextLiveItems) {
  const view = Array.isArray(viewItems) ? viewItems : null;
  if (!view) return null;
  const previousIds = new Set((previousLiveItems || []).map((item) => item?.id).filter((id) => id != null));
  if (!view.some((item) => previousIds.has(item?.id))) return view;
  const historical = view.filter((item) => !previousIds.has(item?.id));
  return [...historical, ...(nextLiveItems || []).slice(0, TRANSCRIPT_RESTORE_OVERLAP_ITEMS)];
}

// Rebuild the id → live-index map for a replaced item list.
export function reindexItems(itemIndexById, items) {
  itemIndexById.clear();
  for (let i = 0; i < items.length; i++) {
    const id = items[i]?.id;
    if (id != null) itemIndexById.set(id, i);
  }
}

export function replaceSessionItemsState({ state, items, itemIndexById, preserveStreamingTail = false, extra = {} }) {
  const nextItems = Array.isArray(items) ? items : [];
  reindexItems(itemIndexById, nextItems);
  return {
    ...state,
    ...extra,
    items: nextItems,
    structureRevision: (Number(state.structureRevision) || 0) + 1,
    streamingTail: preserveStreamingTail ? state.streamingTail : null,
  };
}

// Shared by the live session runtime and focused transcript tests so revision/tail
// regressions exercise the exact mutation implementation used in production.
export function createSessionItemMutators({
  getState,
  set,
  itemIndexById,
  normalizeItems = (items) => items,
  itemStateExtra = () => ({}),
}) {
  const patchItem = (id, patch) => {
    const state = getState();
    let index = itemIndexById.get(id);
    if (!Number.isInteger(index) || state.items[index]?.id !== id) {
      index = state.items.findIndex((it) => it.id === id);
      if (index >= 0) itemIndexById.set(id, index);
    }
    if (index < 0) return false;
    const current = state.items[index];
    let changed = false;
    for (const [key, value] of Object.entries(patch || {})) {
      if (!Object.is(current[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const items = state.items.slice();
    items[index] = { ...current, ...patch };
    set({ items, structureRevision: (Number(state.structureRevision) || 0) + 1 });
    return true;
  };

  const settleStreamingTail = (id, patch = {}, extra = {}) => {
    const state = getState();
    const tail = state.streamingTail?.id === id ? state.streamingTail : null;
    // Bulk transcript replacement/reset owns the new transcript. A stale turn
    // must never append into it after replaceItems deliberately cleared its tail.
    if (!tail) return false;
    let existingIndex = itemIndexById.get(id);
    if (!Number.isInteger(existingIndex) || state.items[existingIndex]?.id !== id) {
      existingIndex = state.items.findIndex((item) => item?.id === id);
    }
    if (existingIndex >= 0) return false;
    const item = {
      ...tail,
      ...patch,
      kind: 'assistant',
      id,
      streaming: false,
    };
    const items = normalizeItems([...state.items, item]);
    reindexItems(itemIndexById, items);
    const settledIndex = items.findIndex((entry) => entry?.id === id);
    set({
      items,
      structureRevision: (Number(state.structureRevision) || 0) + 1,
      streamingTail: null,
      ...itemStateExtra(),
      ...extra,
    });
    return settledIndex >= 0;
  };

  return { patchItem, settleStreamingTail };
}
