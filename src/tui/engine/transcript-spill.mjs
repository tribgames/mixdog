// Transcript spill buffer + engine item state, extracted from engine.mjs.
/**
 * src/tui/engine.mjs - the engine<->React bridge (React-free).
 *
 * Runs mixdog's session manager outside React and exposes a tiny subscribable
 * store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs).
 *
 * Pure/stateless helpers live in ./engine/* (boot-profile, session-stats,
 * labels, notice-text, tool-result-text, tool-call-fields, agent-envelope,
 * queue-helpers) and are re-exported here so the public surface is unchanged.
 * This file keeps the stateful createEngineSession store + notification plan.
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  aggregateToolCategoryEntry,
  classifyToolCategory,
  formatAggregateDetail,
  summarizeToolResult,
} from '../../runtime/shared/tool-surface.mjs';
import {
  isModelVisibleToolCompletionWrapper,
  isLikelyToolCompletionWrapper,
} from '../../runtime/shared/tool-execution-contract.mjs';
import { isLateToolAnnouncement } from '../../session-runtime/session-text.mjs';
import { presentErrorText } from '../../runtime/shared/err-text.mjs';
import { sessionPath } from '../../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { listThemes, getThemeSetting, setThemeSetting } from '../theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from '../markdown/streaming-markdown.mjs';
import { bootProfile } from '../engine/boot-profile.mjs';
import { createSessionStats, applyUsageDelta } from '../engine/session-stats.mjs';
import {
  pickVerb,
  pickDoneVerb,
  formatElapsedSeconds,
  compactEventLabel,
  compactEventDetail,
  projectNameFromPath,
} from '../engine/labels.mjs';
import { polishNoticeText } from '../engine/notice-text.mjs';
import {
  toolResultText,
  toolAggregateDetailFallback,
  toolGroupedDisplayFallback,
  toolErrorDisplay,
} from '../engine/tool-result-text.mjs';
import {
  toolCallId,
  toolResultCallId,
  toolCallName,
  toolCallArgs,
} from '../engine/tool-call-fields.mjs';
import {
  parseBackgroundTaskEnvelope,
  parseSyntheticAgentMessage,
  toolResultStatus,
  isErrorToolStatus,
} from '../engine/agent-envelope.mjs';
import {
  queuePriorityValue,
  defaultQueuePriority,
  isQueuedEntryEditable,
  isQueuedEntryVisible,
  isSlashQueuedEntry,
  notificationDisplayText,
  sessionActivityTimestamp,
  promptDisplayText,
  mergePromptContents,
  mergePastedImages,
  mergePastedTexts,
  callCommitCallbacks,
} from '../engine/queue-helpers.mjs';
import {
  resolveTuiRuntimeNotificationDelivery,
} from '../engine/notification-plan.mjs';
import { yieldToRenderer } from '../engine/render-timing.mjs';
import {
  aggregateRawResult,
  aggregateBucketForCategory,
  aggregateSummaries,
  assignAggregateSummaryOrder,
} from '../engine/tool-result-status.mjs';
import { createToolApproval } from '../engine/tool-approval.mjs';
import { createToolCardResults } from '../engine/tool-card-results.mjs';
import { createAgentJobFeed } from '../engine/agent-job-feed.mjs';
import { appendAgentResponseTail } from '../engine/agent-response-tail.mjs';
import {
  appendTuiSteeringPersist,
  dropTuiSteeringPersist,
  drainTuiSteeringPersist,
  flushTuiSteeringPersist,
} from '../engine/tui-steering-persist.mjs';
import { createContextState } from '../engine/context-state.mjs';
import { recomputePromptHistory } from '../engine/prompt-history.mjs';
import {
  appendPromptHistory,
  buildMergedPromptHistory,
  loadPromptHistory,
} from '../prompt-history-store.mjs';
import { createSessionFlow } from '../engine/session-flow.mjs';
import { createRunTurn } from '../engine/turn.mjs';
import { createEngineApi } from '../engine/session-api.mjs';
import { createFrameBatchedStorePublisher } from '../engine/frame-batched-store.mjs';
import { createLiveShare, liveSharePipePath } from '../engine/live-share.mjs';
import { displayModelName } from '../../ui/model-display.mjs';

export const TUI_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_DEBUG || ''));
export const tuiDebug = (msg) => {
  if (!TUI_DEBUG) return;
  try { process.stderr.write(`[tui] ${msg}\n`); } catch {}
};

export let _idSeq = 0;
export const nextId = () => `it_${++_idSeq}`;

export const TRANSCRIPT_LIVE_ITEM_CAP = 512;
export const TRANSCRIPT_SPILL_CHUNK_ITEMS = 128;
export const TRANSCRIPT_RESTORE_OVERLAP_ITEMS = 64;
export const TRANSCRIPT_SPILL_STALE_MS = 24 * 60 * 60 * 1000;
export const TRANSCRIPT_SPILL_HEARTBEAT_MS = 10_000;
export const TRANSCRIPT_PROCESS_NONCE = randomUUID();

export function cleanupStaleTranscriptSpillDirs({
  root = tmpdir(),
  now = Date.now(),
  staleMs = TRANSCRIPT_SPILL_STALE_MS,
} = {}) {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('mixdog-transcript-')) continue;
      const path = join(root, entry.name);
      try {
        const ownerPid = Number(/^mixdog-transcript-(\d+)-/.exec(entry.name)?.[1]);
        let pidAlive = false;
        if (ownerPid > 0) {
          try { process.kill(ownerPid, 0); pidAlive = true; } catch {}
        }
        if (!pidAlive) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        // A fresh heartbeat proves the owning process is running. A stale one
        // is ambiguous (suspended owner vs PID reuse), so retain it for the
        // generous staleMs grace period, then reclaim it even if that PID is
        // currently alive. This avoids both short suspension data loss and
        // immortal crash leftovers after PID reuse.
        let heartbeatAge;
        try {
          heartbeatAge = now - statSync(join(path, 'heartbeat')).mtimeMs;
        } catch {
          heartbeatAge = now - statSync(path).mtimeMs;
        }
        if (heartbeatAge <= staleMs) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// Serialized pages deliberately release the old item object graph while
// keeping every byte restorable. Only `items` is render-live and walkable.
export function createTranscriptSpillBuffer({
  cap = TRANSCRIPT_LIVE_ITEM_CAP,
  chunkSize = TRANSCRIPT_SPILL_CHUNK_ITEMS,
  // stdout/stderr: worker threads otherwise copy straight into the REAL fds,
  // bypassing the TUI stderr guard and printing over the terminal frame.
  workerFactory = (source) => new Worker(source, { eval: true, stdout: true, stderr: true }),
  onWarning = (message) => tuiDebug(message),
  writeTimeoutMs = 5000,
} = {}) {
  // Publish this process instance's nonce BEFORE cleanup. If the OS reused our
  // PID after a crash, the old directory's owner nonce now differs from the
  // live registry and cannot be mistaken for this process.
  try {
    writeFileSync(
      join(tmpdir(), `mixdog-transcript-owner-${process.pid}.json`),
      JSON.stringify({ pid: process.pid, nonce: TRANSCRIPT_PROCESS_NONCE }),
      'utf8',
    );
  } catch {}
  cleanupStaleTranscriptSpillDirs();
  const pages = [];
  let cursor = null;
  let spillDir = null;
  let pageSequence = 0;
  let spillWorker = null;
  let workerSpawnCount = 0;
  let activeWrite = null;
  let activeWriteTimer = null;
  let warningEmitted = false;
  let spillDisabled = false;
  const writeQueue = [];
  const heartbeatTimers = new Map();
  const snapshots = new Set();
  const cleanupRecords = (records, directory) => {
    for (const record of records) {
      record.cancelled = true;
    }
    if (directory) {
      const timer = heartbeatTimers.get(directory);
      if (timer) clearInterval(timer);
      heartbeatTimers.delete(directory);
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  };
  const ensureSpillDir = () => {
    if (spillDir) return spillDir;
    const root = tmpdir();
    writeFileSync(
      join(root, `mixdog-transcript-owner-${process.pid}.json`),
      JSON.stringify({ pid: process.pid, nonce: TRANSCRIPT_PROCESS_NONCE }),
      'utf8',
    );
    spillDir = mkdtempSync(join(root, `mixdog-transcript-${process.pid}-${TRANSCRIPT_PROCESS_NONCE}-`));
    writeFileSync(
      join(spillDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, nonce: TRANSCRIPT_PROCESS_NONCE }),
      'utf8',
    );
    const heartbeat = join(spillDir, 'heartbeat');
    writeFileSync(heartbeat, String(Date.now()), 'utf8');
    const heartbeatTimer = setInterval(() => {
      try { writeFileSync(heartbeat, String(Date.now()), 'utf8'); } catch {}
    }, TRANSCRIPT_SPILL_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    heartbeatTimers.set(spillDir, heartbeatTimer);
    return spillDir;
  };
  const workerSource = `
    const { parentPort } = require('node:worker_threads');
    const { renameSync, writeFileSync } = require('node:fs');
    parentPort.on('message', ({ id, targetPath, tempPath, items }) => {
      try {
        writeFileSync(tempPath, JSON.stringify(items), 'utf8');
        renameSync(tempPath, targetPath);
        parentPort.postMessage({ id, ok: true });
      } catch (error) {
        parentPort.postMessage({ id, ok: false, error: String(error && error.message || error) });
      }
    });`;
  const ensureWorker = () => {
    if (spillWorker) return spillWorker;
    try {
      const worker = workerFactory(workerSource);
      spillWorker = worker;
      workerSpawnCount += 1;
      worker.stdout?.on?.('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
      worker.stderr?.on?.('data', (chunk) => { try { process.stderr.write(chunk); } catch { /* best-effort */ } });
      worker.on('message', (result) => {
        if (spillWorker !== worker || result?.id !== activeWrite?.id) return;
        finishWrite(result?.ok === true, result?.error);
      });
      const failWorker = (error) => {
        if (spillWorker !== worker) return;
        if (activeWriteTimer) clearTimeout(activeWriteTimer);
        activeWriteTimer = null;
        const failed = activeWrite;
        activeWrite = null;
        spillWorker = null;
        try { worker.terminate?.(); } catch {}
        if (failed) retryOrPin(failed, error?.message);
        pumpWrites();
      };
      worker.on('error', failWorker);
      worker.on('exit', (code) => {
        failWorker(new Error(`spill worker exited (${code})`));
      });
      worker.unref?.();
    } catch (error) {
      spillWorker = null;
      if (activeWrite) {
        const failed = activeWrite;
        activeWrite = null;
        retryOrPin(failed, error?.message);
      }
    }
    return spillWorker;
  };
  const retryOrPin = (record, error) => {
    if (record.cancelled) return;
    record.attempts += 1;
    if (record.attempts <= 2) {
      writeQueue.unshift(record);
      return;
    }
    record.pinned = true;
    spillDisabled = true;
    for (const queued of writeQueue.splice(0)) {
      if (!queued.cancelled) queued.pinned = true;
    }
    if (!warningEmitted) {
      warningEmitted = true;
      try { onWarning(`transcript spill write failed; history pinned in memory (${error || 'unknown error'})`); } catch {}
    }
  };
  const finishWrite = (ok, error) => {
    if (activeWriteTimer) clearTimeout(activeWriteTimer);
    activeWriteTimer = null;
    const record = activeWrite;
    activeWrite = null;
    if (record && !record.cancelled) {
      if (ok) record.pendingItems = null;
      else retryOrPin(record, error);
    }
    pumpWrites();
  };
  const pumpWrites = () => {
    if (activeWrite) return;
    while (writeQueue.length && writeQueue[0].cancelled) writeQueue.shift();
    if (!writeQueue.length) return;
    activeWrite = writeQueue.shift();
    const worker = ensureWorker();
    if (!worker) {
      if (activeWrite) {
        const failed = activeWrite;
        activeWrite = null;
        retryOrPin(failed, 'worker unavailable');
      }
      queueMicrotask(pumpWrites);
      return;
    }
    // Pages are capped at chunkSize (128 by default), so the structured-clone
    // post cost is bounded. Serialization and filesystem I/O stay in the worker.
    // Every attempt writes a distinct temporary file; atomic rename is the sole
    // commit point. A timed-out old worker can therefore expose only a complete
    // page (the retry payload is identical), never a partial target JSON file.
    const tempPath = `${activeWrite.path}.attempt-${activeWrite.attempts}-${randomUUID()}.tmp`;
    worker.postMessage({
      id: activeWrite.id,
      targetPath: activeWrite.path,
      tempPath,
      items: activeWrite.pendingItems,
    });
    activeWriteTimer = setTimeout(() => {
      if (!activeWrite || spillWorker !== worker) return;
      const failed = activeWrite;
      activeWrite = null;
      activeWriteTimer = null;
      spillWorker = null;
      try { worker.terminate?.(); } catch {}
      retryOrPin(failed, `write timed out after ${writeTimeoutMs}ms`);
      pumpWrites();
    }, Math.max(1, Number(writeTimeoutMs) || 5000));
    activeWriteTimer.unref?.();
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
    writeQueue.push(record);
    pumpWrites();
    return record;
  };
  const decode = (record) => record.pendingItems || JSON.parse(readFileSync(record.path, 'utf8'));
  return {
    get hasOlder() { return cursor == null ? pages.length > 0 : cursor > 0; },
    get hasNewer() { return cursor != null; },
    reset() {
      const retained = [...snapshots].some((snapshot) => snapshot.spillDir === spillDir);
      const oldPages = pages.splice(0);
      const oldDir = spillDir;
      pages.length = 0;
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
      for (const timer of heartbeatTimers.values()) clearInterval(timer);
      heartbeatTimers.clear();
      writeQueue.length = 0;
      activeWrite = null;
      if (activeWriteTimer) clearTimeout(activeWriteTimer);
      activeWriteTimer = null;
      try { spillWorker?.terminate(); } catch {}
      spillWorker = null;
    },
    get workerCount() { return workerSpawnCount; },
    get pendingWriteCount() {
      return writeQueue.length + (activeWrite ? 1 : 0);
    },
    get pinnedPageCount() {
      return pages.filter((page) => page.pinned).length;
    },
    get disabled() { return spillDisabled; },
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
      const restored = decode(pages[cursor]);
      const following = cursor + 1 < pages.length
        ? decode(pages[cursor + 1])
        : (Array.isArray(liveItems) ? liveItems : []);
      return [...restored, ...following.slice(0, TRANSCRIPT_RESTORE_OVERLAP_ITEMS)];
    },
    restoreNewer(liveItems) {
      if (cursor == null) return null;
      const nextCursor = cursor + 1;
      if (nextCursor >= pages.length) {
        cursor = null;
        return { items: null, atLive: true };
      }
      cursor = nextCursor;
      const restored = decode(pages[cursor]);
      const following = cursor + 1 < pages.length
        ? decode(pages[cursor + 1])
        : (Array.isArray(liveItems) ? liveItems : []);
      return [...restored, ...following.slice(0, TRANSCRIPT_RESTORE_OVERLAP_ITEMS)];
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

// Re-export the shared tool-result/notification helpers so importers (and tests)
// keep resolving them from engine.mjs unchanged.
export { toolResultText, toolAggregateDetailFallback, toolGroupedDisplayFallback };
export { parseBackgroundTaskEnvelope };
// Re-export the pure notification delivery plan (moved to ./engine/notification-plan.mjs)
// so importers/tests keep resolving resolveTuiRuntimeNotificationDelivery from engine.mjs.
export { resolveTuiRuntimeNotificationDelivery };

export function replaceEngineItemsState({
  state,
  items,
  itemIndexById,
  preserveStreamingTail = false,
  extra = {},
}) {
  const nextItems = Array.isArray(items) ? items : [];
  itemIndexById.clear();
  for (let i = 0; i < nextItems.length; i++) {
    const id = nextItems[i]?.id;
    if (id != null) itemIndexById.set(id, i);
  }
  return {
    ...state,
    ...extra,
    items: nextItems,
    structureRevision: (Number(state.structureRevision) || 0) + 1,
    streamingTail: preserveStreamingTail ? state.streamingTail : null,
  };
}

// Shared by the live engine and focused transcript tests so revision/tail
// regressions exercise the exact mutation implementation used in production.
export function createEngineItemMutators({
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
      ...(tail || {}),
      ...patch,
      kind: 'assistant',
      id,
      streaming: false,
    };
    const index = state.items.length;
    const items = normalizeItems([...state.items, item]);
    itemIndexById.clear();
    for (let i = 0; i < items.length; i++) {
      const itemId = items[i]?.id;
      if (itemId != null) itemIndexById.set(itemId, i);
    }
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
