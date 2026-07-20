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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  aggregateToolCategoryEntry,
  classifyToolCategory,
  formatAggregateDetail,
  summarizeToolResult,
} from '../runtime/shared/tool-surface.mjs';
import {
  isModelVisibleToolCompletionWrapper,
  isLikelyToolCompletionWrapper,
} from '../runtime/shared/tool-execution-contract.mjs';
import { isLateToolAnnouncement } from '../session-runtime/session-text.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { sessionPath } from '../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { listThemes, getThemeSetting, setThemeSetting } from './theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from './markdown/streaming-markdown.mjs';
import { bootProfile } from './engine/boot-profile.mjs';
import { createSessionStats, applyUsageDelta } from './engine/session-stats.mjs';
import {
  pickVerb,
  pickDoneVerb,
  formatElapsedSeconds,
  compactEventLabel,
  compactEventDetail,
  projectNameFromPath,
} from './engine/labels.mjs';
import { polishNoticeText } from './engine/notice-text.mjs';
import {
  toolResultText,
  toolAggregateDetailFallback,
  toolGroupedDisplayFallback,
  toolErrorDisplay,
} from './engine/tool-result-text.mjs';
import {
  toolCallId,
  toolResultCallId,
  toolCallName,
  toolCallArgs,
} from './engine/tool-call-fields.mjs';
import {
  parseBackgroundTaskEnvelope,
  parseSyntheticAgentMessage,
  toolResultStatus,
  isErrorToolStatus,
} from './engine/agent-envelope.mjs';
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
} from './engine/queue-helpers.mjs';
import {
  resolveTuiRuntimeNotificationDelivery,
} from './engine/notification-plan.mjs';
import { yieldToRenderer } from './engine/render-timing.mjs';
import {
  aggregateRawResult,
  aggregateBucketForCategory,
  aggregateSummaries,
  assignAggregateSummaryOrder,
} from './engine/tool-result-status.mjs';
import { createToolApproval } from './engine/tool-approval.mjs';
import { createToolCardResults } from './engine/tool-card-results.mjs';
import { createAgentJobFeed } from './engine/agent-job-feed.mjs';
import { appendAgentResponseTail } from './engine/agent-response-tail.mjs';
import {
  appendTuiSteeringPersist,
  dropTuiSteeringPersist,
  drainTuiSteeringPersist,
  flushTuiSteeringPersist,
} from './engine/tui-steering-persist.mjs';
import { createContextState } from './engine/context-state.mjs';
import { recomputePromptHistory } from './engine/prompt-history.mjs';
import {
  appendPromptHistory,
  buildMergedPromptHistory,
  loadPromptHistory,
} from './prompt-history-store.mjs';
import { createSessionFlow } from './engine/session-flow.mjs';
import { createRunTurn } from './engine/turn.mjs';
import { createEngineApi } from './engine/session-api.mjs';
import { createFrameBatchedStorePublisher } from './engine/frame-batched-store.mjs';
import { displayModelName } from '../ui/model-display.mjs';

// Source tests resolve from src/tui/engine.mjs; the built bundle resolves from
// src/tui/dist/index.mjs.
const SESSION_RUNTIME_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../mixdog-session-runtime.mjs'
  : '../mixdog-session-runtime.mjs';

const TOOL_APPROVAL_TIMEOUT_MS = (() => {
  const value = Number(process.env.MIXDOG_TOOL_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : 120_000;
})();

// Idle cap for a single lead TUI turn: the timer is reset by observable model,
// tool, usage, stage, compact, or steering progress. A provider call that stops
// producing progress otherwise leaves runTurn holding busy=true with no unwind,
// so submit() only ever queues and the UI is permanently input-dead. On trip we
// abort through the SAME interrupt path Esc uses; if that does not unwind, a
// short grace path force-releases busy=false and drains the queue. Default is
// intentionally finite (5min). Env-overridable for long local experiments.
const LEAD_TURN_TIMEOUT_MS = (() => {
  const value = Number(process.env.MIXDOG_LEAD_TURN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(10_000, Math.round(value)) : 5 * 60_000;
})();

// Opt-in diagnostic trace for the hang chain (runTurn start/end, busy-queue
// enqueue/drain, watchdog trip). Quiet by default so it can never tear through
// the alternate-screen render; enable with MIXDOG_TUI_DEBUG=1.
const TUI_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_DEBUG || ''));
const tuiDebug = (msg) => {
  if (!TUI_DEBUG) return;
  try { process.stderr.write(`[tui] ${msg}\n`); } catch {}
};

let _idSeq = 0;
const nextId = () => `it_${++_idSeq}`;

export const TRANSCRIPT_LIVE_ITEM_CAP = 512;
export const TRANSCRIPT_SPILL_CHUNK_ITEMS = 128;
const TRANSCRIPT_RESTORE_OVERLAP_ITEMS = 64;
const TRANSCRIPT_SPILL_STALE_MS = 24 * 60 * 60 * 1000;
const TRANSCRIPT_SPILL_HEARTBEAT_MS = 10_000;
const TRANSCRIPT_PROCESS_NONCE = randomUUID();

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

export async function createEngineSession({
  provider: providerName,
  model,
  toolMode = 'full',
  remote = false,
  cwd,
  desktopSession,
} = {}) {
  const startedAt = performance.now();
  bootProfile('engine:create:start', { provider: providerName, model, toolMode, remote });
  // Silence provider/session diagnostics so they cannot tear through the
  // alternate-screen React/ink render.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_QUIET_SESSION_LOG = '1';
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  const importStartedAt = performance.now();
  const { createMixdogSessionRuntime } = await import(SESSION_RUNTIME_MODULE);
  bootProfile('session-runtime:imported', { ms: (performance.now() - importStartedAt).toFixed(1) });
  const runtime = await createMixdogSessionRuntime({
    provider: providerName,
    model,
    toolMode,
    remote,
    ...(cwd ? { cwd } : {}),
    ...(desktopSession ? { desktopSession } : {}),
  });
  bootProfile('engine:create:runtime-ready', { ms: (performance.now() - startedAt).toFixed(1) });
  const runtimeCwd = runtime.cwd || process.cwd();
  const stateStartedAt = performance.now();
  const flags = {
    disposed: false,
    draining: false,
    autoClearRunning: false,
    pendingSessionReset: false,
    lastUserActivityAt: Date.now(),
    leadTurnEpoch: 0,
    activePromptRestore: null,
    pushingFromDeferredEntry: false,
    flushDeferredBeforeImmediatePush: null,
    pendingTranscriptMeta: null,
  };
  const lifecycle = { runtimePulseTimer: null, unsubscribeRuntimeNotifications: null, unsubscribeRemoteState: null };
  const pending = [];
  const pendingNotificationKeys = new Set();
  const displayedExecutionNotificationKeys = new Set();
  const bag = {};
  let state;
  // Route/context/agent-status derivations live in ./engine/context-state.mjs.
  // getState()/getPendingSessionReset() are late-bound to the `state` and
  // `pendingSessionReset` closures declared below; the sync helpers mutate
  // state.stats / display fields IN PLACE exactly as the old inline versions
  // did (callers follow with a set({ stats: { ...state.stats }, ... })).
  const {
    autoClearState,
    agentStatusState,
    baseRouteState,
    routeState,
    syncContextStats,
  } = createContextState({
    runtime,
    getState: () => state,
    updateState: (patch) => { state = { ...state, ...patch }; },
    getPendingSessionReset: () => flags.pendingSessionReset,
  });

  const initialAgentState = {
    agentWorkers: [],
    agentJobs: [],
    agentScope: null,
  };
  state = {
    items: [],
    transcriptViewItems: null,
    transcriptViewRevision: 0,
    transcriptHistoryBefore: false,
    transcriptHistoryAfter: false,
    structureRevision: 0,
    streamingTail: null,
    toasts: [],
    progressHint: null,
    busy: false,
    commandBusy: false,
    commandStatus: null,
    spinner: null,
    queued: [],
    thinking: null,
    toolApproval: null,
    lastTurn: null,
    stats: createSessionStats(),
    // Incremental derivations published by the engine so App does not scan all
    // transcript items on every change:
    //  - activeToolSummary: running Explore/Search active counts + earliest
    //    startedAt for the prompt-line status (replaces App.jsx O(n) items scan).
    //  - promptHistoryList: newest-first deduped user-prompt history, rebuilt
    //    only when a user item is appended (replaces the per-change rescan).
    activeToolSummary: null,
    // Seed from the persisted cwd-scoped store so up-arrow history is available
    // on a fresh start, before any bulk swap / first submit republishes it.
    promptHistoryList: buildMergedPromptHistory([], loadPromptHistory(runtimeCwd)),
    ...baseRouteState(),
    displayContextWindow: 0,
    compactBoundaryTokens: 0,
    autoCompactTokenLimit: 0,
    ...initialAgentState,
    toolMode: runtime.toolMode,
    cwd: runtimeCwd,
    themeEpoch: 0,
  };
  bootProfile('engine:route-state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  bootProfile('engine:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  const contextStartedAt = performance.now();
  syncContextStats({ allowEstimated: true });
  bootProfile('engine:context-ready', { ms: (performance.now() - contextStartedAt).toFixed(1) });
  const listeners = new Set();
  // React/useSyncExternalStore reads only this immutable published snapshot.
  // `state` remains the engine's synchronous draft until a frame flush swaps
  // the complete draft (including its single revision bump) into this slot.
  let publishedState = process.env.NODE_ENV === 'production' ? state : Object.freeze(state);
  // The mutable engine draft must never be the object exposed to React.
  state = { ...state, stats: { ...state.stats } };
  // Mutations stay synchronous, but React publications are frame-coalesced.
  // structureRevision is committed by the publisher exactly once immediately
  // before listeners observe the terminal snapshot for that frame.
  const publisher = createFrameBatchedStorePublisher({
    getState: () => state,
    publishState: (next) => {
      publishedState = process.env.NODE_ENV === 'production' ? next : Object.freeze(next);
      // Detach the next draft, including the only intentionally mutable nested
      // record, so legacy/internal draft writes cannot mutate the publication.
      state = { ...next, stats: { ...next.stats } };
    },
    listeners,
    isDisposed: () => flags.disposed,
  });
  const emit = publisher.emit;
  const flushEmit = publisher.flush;
  const flushEmitImmediate = publisher.flushImmediate;
  const set = (patch) => {
    if (!patch || typeof patch !== 'object') return false;
    const requestsStructureChange = Object.prototype.hasOwnProperty.call(patch, 'structureRevision')
      && !Object.is(patch.structureRevision, state.structureRevision);
    const effectivePatch = requestsStructureChange
      ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'structureRevision'))
      : patch;
    let changed = false;
    for (const [key, value] of Object.entries(effectivePatch)) {
      if (!Object.is(state[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed && !requestsStructureChange) return false;
    // Detect commandBusy releasing (true -> false). Submits that arrived while a
    // session command was in flight were queued and drain bailed on commandBusy;
    // re-kick drain here — one central point covers every command releaser
    // (setModel/newSession/resume/clear/...) so queued prompts are never stranded.
    const commandBusyReleased = state.commandBusy === true
      && Object.prototype.hasOwnProperty.call(patch, 'commandBusy')
      && patch.commandBusy === false;
    state = { ...state, ...effectivePatch };
    if (requestsStructureChange) publisher.markStructureChange();
    emit();
    // Preserve the old microtask-latency behavior for interaction gates and
    // long command spinners that intentionally yield before doing heavy work.
    if (effectivePatch.commandStatus || effectivePatch.toolApproval) {
      flushEmitImmediate();
    }
    if (commandBusyReleased) queueMicrotask(() => { void bag.drain?.(); });
    return true;
  };

  const itemIndexById = new Map();
  const transcriptSpill = createTranscriptSpillBuffer();
  const reindexLiveItems = (items) => {
    itemIndexById.clear();
    for (let i = 0; i < items.length; i++) {
      const id = items[i]?.id;
      if (id != null) itemIndexById.set(id, i);
    }
  };
  const transcriptHistoryFlags = () => ({
    transcriptHistoryBefore: transcriptSpill.hasOlder,
    transcriptHistoryAfter: transcriptSpill.hasNewer,
  });
  const restoreOlderTranscript = () => {
    const transcriptViewItems = transcriptSpill.restoreOlder(state.items);
    if (!transcriptViewItems) return false;
    set({
      transcriptViewItems,
      transcriptViewRevision: state.transcriptViewRevision + 1,
      ...transcriptHistoryFlags(),
    });
    flushEmitImmediate();
    return true;
  };
  const restoreNewerTranscript = () => {
    const restored = transcriptSpill.restoreNewer(state.items);
    if (!restored) return false;
    set({
      transcriptViewItems: restored.atLive ? null : restored,
      transcriptViewRevision: state.transcriptViewRevision + 1,
      ...transcriptHistoryFlags(),
    });
    flushEmitImmediate();
    return true;
  };
  const replaceItems = (items, {
    preserveStreamingTail = false,
    preserveSpill = false,
    preserveTranscriptView = false,
  } = {}) => {
    const nextItems = Array.isArray(items) ? items : [];
    if (!preserveSpill) transcriptSpill.reset();
    const liveItems = transcriptSpill.capLive(nextItems);
    const previousTranscriptView = state.transcriptViewItems;
    const nextTranscriptView = preserveTranscriptView && previousTranscriptView
      ? refillTranscriptViewOverlap(previousTranscriptView, state.items, liveItems)
      : null;
    const transcriptViewChanged = nextTranscriptView !== previousTranscriptView;
    // Bulk item swap (session load / clear / compact). Derive the prompt-history
    // list from the NEW items and stage it onto state here so App never rescans;
    // the callers that invoke replaceItems always follow with a set({items:...,
    // ...}) that carries fresh references, so this pre-stage does not defeat any
    // emit (the accompanying set() diffs the full patch). A bulk swap also
    // discards the old transcript, so drop any tracked active tool calls.
    activeToolCalls.clear();
    const structureRevision = state.structureRevision;
    state = replaceEngineItemsState({
      state,
      items: liveItems,
      itemIndexById,
      preserveStreamingTail,
      extra: {
        promptHistoryList: preserveSpill
          ? state.promptHistoryList
          : buildMergedPromptHistory(recomputePromptHistory(nextItems), loadPromptHistory(state.cwd)),
        activeToolSummary: null,
        transcriptViewItems: nextTranscriptView,
        transcriptViewRevision: preserveTranscriptView
          ? state.transcriptViewRevision + (transcriptViewChanged ? 1 : 0)
          : state.transcriptViewRevision + 1,
        ...transcriptHistoryFlags(),
      },
    });
    // replaceEngineItemsState retains its standalone/test contract. In the live
    // store, defer its revision increment to the frame publication boundary.
    state = { ...state, structureRevision };
    publisher.markStructureChange();
    // replaceItems stages the bulk state before its callers compose their
    // accompanying patch. Emit here as well so an items-only replacement
    // (for example removeNotice) cannot be hidden by the outer set seeing the
    // already-installed array identity.
    emit();
    return liveItems;
  };
  // --- Prompt-history list (newest-first, deduped) maintained incrementally ---
  // App previously rebuilt this from state.items on EVERY transcript change
  // (App.jsx recentPromptHistory useMemo). It only changes when a user item is
  // appended, so rebuild it there and on bulk item swaps, publishing to
  // state.promptHistoryList. Pure derivation now lives in
  // ./engine/prompt-history.mjs (recomputePromptHistory); callers still pass the
  // NEW items array explicitly and publish via set().
  // --- Active-tool summary (Explore/Search) maintained incrementally ---
  // App previously scanned every transcript item on every change to derive the
  // prompt-line "Exploring N / Searching N" status. Instead the tool lifecycle
  // below tracks per-callId category + started-at in activeToolCalls and derives
  // the small summary from it, publishing state.activeToolSummary only when the
  // aggregate (counts + earliest start) actually changes.
  const activeToolCalls = new Map(); // callKey -> { category, count, startedAt }
  const recomputeActiveToolSummary = () => {
    let exploreCount = 0, exploreStart = 0, searchCount = 0, searchStart = 0;
    for (const rec of activeToolCalls.values()) {
      if (!rec) continue;
      const c = Math.max(1, Number(rec.count || 1));
      const started = Number(rec.startedAt || 0);
      if (rec.category === 'Explore') {
        exploreCount += c;
        if (started > 0 && (exploreStart === 0 || started < exploreStart)) exploreStart = started;
      } else if (rec.category === 'Web Research') {
        // L2 "Web Searching" segment tracks WEB searches (search/web_fetch —
        // category 'Web Research'), not local file search ('Search' =
        // grep/find/glob/list). Local search is routine transcript noise and
        // is intentionally NOT surfaced on the statusline.
        searchCount += c;
        if (started > 0 && (searchStart === 0 || started < searchStart)) searchStart = started;
      }
    }
    const next = (exploreCount || searchCount)
      ? `${exploreCount}:${exploreStart}:${searchCount}:${searchStart}`
      : '';
    const prev = state.activeToolSummary || '';
    if (next !== prev) set({ activeToolSummary: next || null });
  };
  const markToolCallActive = (callKey, category, count, startedAt) => {
    if (!callKey || (category !== 'Explore' && category !== 'Web Research')) return;
    activeToolCalls.set(callKey, { category, count: Math.max(1, Number(count || 1)), startedAt: Number(startedAt || Date.now()) });
    recomputeActiveToolSummary();
  };
  const markToolCallDone = (callKey) => {
    if (!callKey || !activeToolCalls.has(callKey)) return;
    activeToolCalls.delete(callKey);
    recomputeActiveToolSummary();
  };
  const clearActiveToolSummary = () => {
    if (activeToolCalls.size === 0 && !state.activeToolSummary) return;
    activeToolCalls.clear();
    if (state.activeToolSummary) set({ activeToolSummary: null });
  };
  const transcriptRouteMetadata = (at = Date.now()) => {
    const route = routeState();
    const modelName = displayModelName(route.model, route.provider);
    const workflowLabel = String(route.workflow?.name || route.workflow?.id || '').trim();
    return {
      at,
      ...(modelName ? { model: modelName } : {}),
      ...(route.provider ? { provider: String(route.provider) } : {}),
      ...(workflowLabel ? { agent: workflowLabel } : {}),
    };
  };
  const pushItem = (item) => {
    if (!flags.pushingFromDeferredEntry && flags.flushDeferredBeforeImmediatePush) {
      flags.flushDeferredBeforeImmediatePush();
    }
    const uncappedItems = [...state.items, item];
    const items = transcriptSpill.capLive(uncappedItems);
    if (items !== uncappedItems) reindexLiveItems(items);
    const index = items.length - 1;
    if (item?.id != null) itemIndexById.set(item.id, index);
    if (item?.kind === 'user') {
      // Rebuild the derived history against the NEW list (not yet in state) and
      // publish items + the fresh list in ONE set(). Do NOT pre-assign to state
      // first — set() diffs against the current state, so a pre-assign would make
      // the references identical and skip emit().
      const promptHistoryList = buildMergedPromptHistory(recomputePromptHistory(items), loadPromptHistory(state.cwd));
      set({ items, structureRevision: state.structureRevision + 1, promptHistoryList, ...transcriptHistoryFlags() });
      flushEmitImmediate();
    } else {
      set({ items, structureRevision: state.structureRevision + 1, ...transcriptHistoryFlags() });
    }
  };
  const appendItems = (newItems, extra = {}) => {
    if (!Array.isArray(newItems) || newItems.length === 0) return set(extra);
    const items = transcriptSpill.capLive([...state.items, ...newItems]);
    reindexLiveItems(items);
    return set({
      items,
      structureRevision: state.structureRevision + 1,
      ...transcriptHistoryFlags(),
      ...extra,
    });
  };
  const updateStreamingTail = (id, patch = {}, extra = {}) => {
    if (id == null) return false;
    const current = state.streamingTail?.id === id
      ? state.streamingTail
      : { kind: 'assistant', id, text: '', streaming: true };
    const next = { ...current, ...patch, kind: 'assistant', id, streaming: true };
    let changed = state.streamingTail !== current;
    if (!changed) {
      for (const [key, value] of Object.entries(next)) {
        if (!Object.is(current[key], value)) {
          changed = true;
          break;
        }
      }
    }
    return set(changed ? { streamingTail: next, ...extra } : extra);
  };
  const clearStreamingTail = (id = null, extra = {}) => {
    if (!state.streamingTail || (id != null && state.streamingTail.id !== id)) {
      return set(extra);
    }
    return set({ streamingTail: null, ...extra });
  };
  const { patchItem, settleStreamingTail } = createEngineItemMutators({
    getState: () => state,
    set,
    itemIndexById,
    normalizeItems: (items) => transcriptSpill.capLive(items),
    itemStateExtra: transcriptHistoryFlags,
  });
  const upsertSyntheticToolItem = (text, id = nextId(), parsed = null) => {
    const synthetic = parseSyntheticAgentMessage(text);
    if (!synthetic) return false;
    const label = synthetic.label || 'notification';
    const args = synthetic.args || {
      type: label,
      task_id: synthetic.taskId || parsed?.taskId || undefined,
      description: synthetic.summary || 'agent notification',
    };
    const isError = synthetic.isError ?? /^(failed|error|timeout|killed|cancelled)$/i.test(label);
    pushItem({
      kind: 'tool',
      id,
      name: synthetic.name || 'agent',
      args,
      result: synthetic.result,
      rawResult: synthetic.rawResult ?? text,
      isError,
      expanded: false,
      count: 1,
      completedCount: 1,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    return true;
  };
  const pushUserOrSyntheticItem = (text, id = nextId(), origin = 'user', extra = null) => {
    // The lenient shape-only wrapper check is display-suppression only and
    // must never hide a real, directly-typed/pasted user prompt just because
    // it happens to resemble "instruction + Result: + quoted body". Only
    // apply it for injected origins (mid-turn steer relay of async
    // notifications, or non-editable task-notification queue entries) where
    // the text is known to have been synthesized by the runtime, not typed
    // by the user. Direct user submissions always go through the strict
    // detector only, same as before this change.
    if (origin === 'injected' && isLikelyToolCompletionWrapper(text)) return;
    if (isModelVisibleToolCompletionWrapper(text)) return;
    // Late-MCP deferred-tool announcement (model-visible <system-reminder>):
    // keep it in model context, but render NOTHING user-facing — not even the
    // collapsed one-line notice (user request: hide late-tool notices entirely).
    if (isLateToolAnnouncement(text)) return;
    if (upsertSyntheticToolItem(text, id)) return;
    // Genuine, directly-typed/pasted user submissions only (never injected or
    // synthetic paths, which returned above): persist to the cwd-scoped store so
    // up-arrow history survives across sessions. Runs before pushItem so the
    // merge in pushItem's user branch (loadPromptHistory) already sees it.
    if (origin === 'user') appendPromptHistory(state.cwd, text);
    const transcriptMeta = transcriptRouteMetadata();
    if (origin === 'user') flags.pendingTranscriptMeta = transcriptMeta;
    pushItem({
      kind: 'user', id, text, ...transcriptMeta,
      // Byte-free attachment metadata (name/mime/size) from the queue entry —
      // lets the desktop transcript render image chips without ever carrying
      // base64 payloads through snapshots.
      ...(extra && Array.isArray(extra.images) && extra.images.length ? { images: extra.images } : {}),
    });
  };
  const pushAsyncAgentResponse = (text, id = nextId(), origin = 'injected', metadata = {}) => {
    const synthetic = parseSyntheticAgentMessage(text);
    const isAgent = synthetic?.name === 'agent';
    if (!isAgent) return pushUserOrSyntheticItem(text, id, origin);
    const responseHasBody = /\n\s*\n[\s\S]*\S/.test(String(text || ''));
    const rawResult = synthetic.rawResult ?? text;
    const args = {
      ...(synthetic.args && typeof synthetic.args === 'object' ? synthetic.args : {}),
      type: 'result',
    };
    const responseKey = String(metadata.responseKey || metadata.executionId || args.task_id || '').trim();
    const previous = state.items.at(-1);
    // Tail-only aggregation prevents a later completion from mutating a card
    // above any outbound tool, assistant, user, or preview/body boundary.
    if (
      previous?.kind === 'tool'
      && previous.agentDirection === 'inbound'
    ) {
      const patch = appendAgentResponseTail(previous, {
        key: responseKey,
        args,
        result: synthetic.result,
        rawResult,
        hasBody: responseHasBody,
        isError: synthetic.isError === true,
      });
      if (patch) {
        patchItem(previous.id, patch);
        return true;
      }
    }
    pushItem({
      kind: 'tool',
      id,
      name: 'agent',
      args,
      result: synthetic.result,
      rawResult,
      isError: synthetic.isError === true,
      expanded: false,
      count: 1,
      completedCount: 1,
      startedAt: Date.now(),
      completedAt: Date.now(),
      agentDirection: 'inbound',
      agentResponseKey: responseKey,
      agentResponseHasBody: responseHasBody,
      agentResponseAggregate: false,
      agentResponseEntries: [{
        key: responseKey,
        raw: String(rawResult ?? '').trim(),
        result: synthetic.result,
        hasBody: responseHasBody,
        isError: synthetic.isError === true,
      }],
    });
    return true;
  };
  const pushToast = (text, tone = 'info', ttlMs = 3000) => {
    const id = nextId();
    const value = String(text ?? '').trim();
    if (!value) return null;
    set({ toasts: [...state.toasts.filter((toast) => toast.id !== id), { id, text: value, tone }] });
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      if (flags.disposed) return;
      set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
    }, ttlMs);
    toastTimers.add(timer);
    timer.unref?.();
    return id;
  };
  const pushNotice = (text, tone = 'info', options = {}) => {
    const value = polishNoticeText(text);
    if (!value) return null;
    const forceTranscript = options.transcript === true;
    if (!forceTranscript) return pushToast(value, tone, options.ttlMs);
    const id = nextId();
    pushItem({ kind: 'notice', id, text: value, tone });
    return id;
  };
  // Remove a transcript notice previously created via pushNotice(...,
  // {transcript:true}). Used for transient-but-persistent notices (e.g. the
  // manual OAuth URL) that must disappear once their flow concludes.
  const removeNotice = (id) => {
    if (id == null) return false;
    const items = state.items.filter((it) => !(it?.kind === 'notice' && it?.id === id));
    if (items.length === state.items.length) return false;
    set({ items: replaceItems(items, { preserveStreamingTail: true }) });
    return true;
  };
  // Sticky (non-TTL) input-hint-line progress state, for long-running
  // installs (e.g. voice runtime download) that would otherwise spam the
  // 3s toast queue. Distinct from pushToast/pushNotice: it persists across
  // renders until explicitly cleared (setProgressHint('', ...) or a falsy
  // text), and App.jsx's inputHint falls back to it only when no promptHint
  // and no live toast currently cover the same line.
  const setProgressHint = (text, tone = 'info') => {
    const value = String(text ?? '').trim();
    set({ progressHint: value ? { text: value, tone } : null });
  };
  const {
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
  } = createToolApproval({
    getState: () => state,
    set,
    nextId,
    getDisposed: () => flags.disposed,
    timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
  });
  const toastTimers = new Set();
  lifecycle.runtimePulseTimer = setInterval(() => {
    if (flags.disposed) return;
    if (flags.pendingSessionReset) return;
    syncContextStats({ allowEstimated: true });
    set({
      ...routeState(),
      stats: { ...state.stats },
      ...agentStatusState(),
    });
  }, 2000);
  lifecycle.runtimePulseTimer.unref?.();

  function clearToastTimers() {
    for (const timer of toastTimers) {
      clearTimeout(timer);
    }
    toastTimers.clear();
  }

  const {
    kickExecutionPendingResume,
    flushDeferredExecutionPendingResumeKick,
    scheduleExecutionPendingResumeKick,
    discardExecutionPendingResume,
    updateAgentJobCard,
    buildAgentJobCardPatch,
    subscribeRuntimeNotifications,
    clearExecutionDedupState,
  } = createAgentJobFeed({
    runtime,
    getState: () => state,
    set,
    nextId,
    getDisposed: () => flags.disposed,
    patchItem,
    enqueue: (...args) => bag.enqueue(...args),
    drain: (...args) => bag.drain(...args),
    pushUserOrSyntheticItem,
    pushAsyncAgentResponse,
    makeQueueEntry: (...args) => bag.makeQueueEntry(...args),
    getPending: () => pending,
    agentStatusState,
    displayedExecutionNotificationKeys,
    pushNotice,
    itemIndexById,
  });
  lifecycle.unsubscribeRuntimeNotifications = subscribeRuntimeNotifications();

  // Remote seat superseded by another session: runtime already stopped its
  // worker; sync the indicator and tell the user. Non-user-initiated, so a
  // toast (not transcript) is right.
  if (typeof runtime.onRemoteStateChange === 'function') {
    lifecycle.unsubscribeRemoteState = runtime.onRemoteStateChange(({ enabled, reason }) => {
      if (flags.disposed) return;
      set({ remoteEnabled: enabled === true });
      if (reason === 'superseded') {
        pushNotice('Remote mode OFF — another session took over remote.', 'warn');
      }
    });
  }

  const { patchToolCardResult, flushToolResults } = createToolCardResults({
    getState: () => state,
    set,
    patchItem,
    markToolCallDone,
    updateAgentJobCard,
    buildAgentJobCardPatch,
    agentStatusState,
    itemIndexById,
  });


  Object.assign(bag, {
    runtime, nextId, tuiDebug, LEAD_TURN_TIMEOUT_MS,
    flags, lifecycle, pending, pendingNotificationKeys, displayedExecutionNotificationKeys, clearExecutionDedupState, listeners, itemIndexById,
    getState: () => state, getPublishedState: () => publishedState,
    set, flushEmit, flushEmitImmediate, disposeEmit: publisher.dispose,
    pushItem, appendItems, patchItem, replaceItems, restoreOlderTranscript, restoreNewerTranscript, updateStreamingTail, settleStreamingTail, clearStreamingTail,
    pushToast, pushNotice, removeNotice, setProgressHint,
    pushUserOrSyntheticItem, pushAsyncAgentResponse, upsertSyntheticToolItem,
    markToolCallActive, markToolCallDone, clearActiveToolSummary, clearToastTimers,
    autoClearState, agentStatusState, baseRouteState, routeState, transcriptRouteMetadata, syncContextStats,
    disposeTranscriptSpill: () => transcriptSpill.dispose(),
    snapshotTranscriptSpill: () => transcriptSpill.snapshot(),
    restoreTranscriptSpill: (snapshot) => transcriptSpill.restoreSnapshot(snapshot),
    releaseTranscriptSpill: (snapshot) => transcriptSpill.releaseSnapshot(snapshot),
    presentNextToolApproval, finishToolApproval, denyAllToolApprovals, requestToolApproval,
    patchToolCardResult, flushToolResults,
    kickExecutionPendingResume, flushDeferredExecutionPendingResumeKick, scheduleExecutionPendingResumeKick, discardExecutionPendingResume, updateAgentJobCard, subscribeRuntimeNotifications,
  });
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  const api = createEngineApi(bag);
  // Cross-surface share tick: one 3s timer covers all three legs of the
  // shared-conversation model (desktop <-> terminal <-> mobile cross-open).
  //  - presence: mark OUR current session as held open (idle included) so a
  //    cross-open elsewhere attaches as a viewer instead of splitting
  //    ownership; cleared on session switch here and on dispose
  //    (session-api-ext), with sidecar staleness covering crashes.
  //  - owner leg: drain foreign user injections from the shared spool and
  //    run them through the normal queue — full user bubble + streaming,
  //    exactly as if typed here. Cheap: one spool mtime stat per idle tick.
  //  - viewer leg: while attached to a session another live process owns,
  //    quiet re-resume when its on-disk JSON advances so the owner's turns
  //    appear here; once the owner is gone the same re-resume promotes this
  //    surface to real ownership.
  let heldPresenceId = '';
  let viewerStoreMtime = 0;
  const remoteAttachTimer = setInterval(() => {
    if (flags.disposed || flags.pendingSessionReset) return;
    try {
      const heldId = runtime.publishSessionPresence?.() || '';
      if (heldPresenceId && heldPresenceId !== heldId) runtime.clearSessionPresence?.(heldPresenceId);
      heldPresenceId = heldId;
    } catch { /* best-effort */ }
    try {
      if (state.busy || state.commandBusy) return;
      if (state.sessionRemoteAttached) {
        const id = String(state.sessionId || '');
        if (!id) return;
        let mtime = 0;
        try { mtime = statSync(sessionPath(id)).mtimeMs || 0; } catch { return; }
        // First attached tick only baselines: the resume that attached this
        // surface already loaded the current on-disk transcript.
        if (!viewerStoreMtime) { viewerStoreMtime = mtime; return; }
        if (mtime > viewerStoreMtime) {
          viewerStoreMtime = mtime;
          void Promise.resolve(api.resume(id, { quiet: true })).catch(() => { /* next tick retries */ });
        }
        return;
      }
      viewerStoreMtime = 0;
      const injected = runtime.takeRemoteInjections?.() || [];
      if (injected.length === 0) return;
      for (const text of injected) bag.enqueue(text);
      void bag.drain();
    } catch { /* best-effort */ }
  }, 3000);
  remoteAttachTimer.unref?.();
  void bag.restoreLeadSteeringFromDisk();
  return api;
}
