/**
 * src/tui/session-local.mjs - daemon-hosted local session store.
 *
 * Runs mixdog's session manager inside the singleton daemon and exposes the
 * subscribable store projected to clients. React/ink consumes the matching
 * remote view through useSyncExternalStore (see hooks/useSession.mjs).
 *
 * Product TUI/CLI callers use ./session.mjs and never load this module directly.
 * The singleton daemon and explicit parity tests are the only callers.
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
} from '../runtime/shared/tool-surface.mjs';
import {
  isInternalTranscriptDisplayText,
  isModelVisibleToolCompletionWrapper,
} from '../runtime/shared/tool-execution-contract.mjs';
import { isLateToolAnnouncement } from '../session-runtime/session-text.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { sessionPath } from '../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { listThemes, getThemeSetting, setThemeSetting } from './theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from './markdown/streaming-markdown.mjs';
import { bootProfile } from './session/boot-profile.mjs';
import { createSessionStats, applyUsageDelta } from './session/session-stats.mjs';
import { createGoalContinuation } from './session/goal-continuation.mjs';
import {
  pickVerb,
  pickDoneVerb,
  formatElapsedSeconds,
  compactEventLabel,
  compactEventDetail,
  projectNameFromPath,
} from './session/labels.mjs';
import { polishNoticeText } from './session/notice-text.mjs';
import {
  toolResultText,
  toolAggregateDetailFallback,
  toolGroupedDisplayFallback,
  toolErrorDisplay,
} from './session/tool-result-text.mjs';
import {
  toolCallId,
  toolResultCallId,
  toolCallName,
  toolCallArgs,
} from './session/tool-call-fields.mjs';
import {
  buildExecutionResponseToolItem,
  parseBackgroundTaskEnvelope,
  parseModelVisibleCompletionWrapper,
  parseSyntheticAgentMessage,
  toolResultStatus,
  isErrorToolStatus,
} from './session/agent-envelope.mjs';
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
} from './session/queue-helpers.mjs';
import {
  resolveTuiRuntimeNotificationDelivery,
} from './session/notification-plan.mjs';
import {
  TUI_FRAME_MS,
  cancelRenderAlignedStoreFlush,
  scheduleRenderAlignedStoreFlush,
  yieldToRenderer,
} from './session/render-timing.mjs';
import {
  aggregateRawResult,
  aggregateBucketForCategory,
  aggregateSummaries,
  assignAggregateSummaryOrder,
} from './session/tool-result-status.mjs';
import { createToolApproval } from './session/tool-approval.mjs';
import { createToolCardResults } from './session/tool-card-results.mjs';
import { createAgentJobFeed } from './session/agent-job-feed.mjs';
import { appendAgentResponseTail } from './session/agent-response-tail.mjs';
import {
  appendTuiSteeringPersist,
  dropTuiSteeringPersist,
  drainTuiSteeringPersist,
  flushTuiSteeringPersist,
} from './session/tui-steering-persist.mjs';
import { createContextState } from './session/context-state.mjs';
import { recomputePromptHistory } from './session/prompt-history.mjs';
import {
  appendPromptHistory,
  buildMergedPromptHistory,
  loadPromptHistory,
} from './prompt-history-store.mjs';
import { createSessionFlow } from './session/session-flow.mjs';
import { createRunTurn } from './session/turn.mjs';
import { createSessionApi } from './session/session-api.mjs';
import { createFrameBatchedStorePublisher } from './session/frame-batched-store.mjs';
import { createLiveShare, forwardViewerSubmit, liveSharePipePath } from './session/live-share.mjs';
import { displayModelName } from '../ui/model-display.mjs';
import { prewarmImageResizer } from '../runtime/agent/orchestrator/tools/builtin/read-image-resize.mjs';

const SESSION_RUNTIME_MODULE = '../mixdog-session-runtime.mjs';
// Start the native binding load with daemon startup rather than making the
// user's first image attachment pay the cold dynamic-import cost.
void prewarmImageResizer();

// The runtime graph is imported lazily, but that import (measured ~250ms) used
// to land inside the FIRST session runtime creation, which desktop performs while it
// holds its transition lock — so the user's first navigation paid for it. Hosts
// can start it during their own idle startup instead; the promise is shared, so
// the create path either awaits an in-flight preload or does the import itself.
let sessionRuntimeModulePromise = null;
function importSessionRuntimeModule() {
  sessionRuntimeModulePromise ??= import(SESSION_RUNTIME_MODULE);
  return sessionRuntimeModulePromise;
}

export function preloadSessionRuntimeModule() {
  return importSessionRuntimeModule().catch(() => {
    // A real load failure surfaces on the authoritative create path.
    sessionRuntimeModulePromise = null;
  });
}

let agentLoopPrewarmPromise = null;
export function preloadAgentLoopRuntime() {
  agentLoopPrewarmPromise ??= import(
    '../runtime/agent/orchestrator/session/manager/runtime-loaders.mjs'
  ).then((module) => module.prewarmAgentLoop());
  void agentLoopPrewarmPromise.catch(() => {
    // Reservation-time prewarm retries through the same shared loader.
    agentLoopPrewarmPromise = null;
  });
  return agentLoopPrewarmPromise;
}

// Memory-runtime attach (PG proxy + embed warmup) measured ~6.5s cold and is
// the largest first-turn blocker: loadCoreMemoryContext races it with a 2s
// cap, but a cold attach stalls the event loop hard enough that even that
// timer fires seconds late (probe: core-memory settle at ~6.0s). Warm the
// EXACT shared proxy instance the session create path resolves —
// getStandaloneMemoryRuntime caches by entry+dataDir, so the first turn finds
// it initialized. Honors the same MIXDOG_BOOT_CORE_MEMORY opt-out.
let memoryRuntimePrewarmPromise = null;
export function preloadMemoryRuntime() {
  const bootFlag = String(process.env.MIXDOG_BOOT_CORE_MEMORY ?? '').trim().toLowerCase();
  if (bootFlag === '0' || bootFlag === 'false' || bootFlag === 'no' || bootFlag === 'off') {
    return Promise.resolve();
  }
  memoryRuntimePrewarmPromise ??= (async () => {
    const [{ getStandaloneMemoryRuntime }, { getPluginData }, { fileURLToPath }] = await Promise.all([
      import('../standalone/memory-runtime-proxy.mjs'),
      import('../runtime/agent/orchestrator/config.mjs'),
      import('node:url'),
    ]);
    const runtime = getStandaloneMemoryRuntime({
      entry: fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url)),
      dataDir: process.env.MIXDOG_DATA_DIR || getPluginData?.() || undefined,
    });
    await runtime.init();
  })();
  void memoryRuntimePrewarmPromise.catch(() => {
    // Opportunistic: loadCoreMemoryContext retries through the same proxy.
    memoryRuntimePrewarmPromise = null;
  });
  return memoryRuntimePrewarmPromise;
}

// Windows keychain reads go through a DPAPI PowerShell host whose cold start
// dominates a packaged boot (measured ~1.5s). The runtime batches every secret
// into one call, but it only starts that batch when the runtime is created —
// late enough that the first context switch waits on it. Hosts can start the
// same batch while their window is still coming up.
let keychainPrewarmPromise = null;
export function preloadKeychainSecrets() {
  keychainPrewarmPromise ??= (async () => {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const keychain = require('../lib/keychain-cjs.cjs');
      await keychain.prewarmSecrets?.();
    } catch {
      // Prewarm is opportunistic; the runtime still warms on its own path.
    }
  })();
  return keychainPrewarmPromise;
}

const TOOL_APPROVAL_TIMEOUT_MS = (() => {
  const value = Number(process.env.MIXDOG_TOOL_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : 120_000;
})();

// Opt-in diagnostic trace for the hang chain (runTurn start/end, busy-queue
// enqueue/drain). Quiet by default so it can never tear through
// the alternate-screen render; enable with MIXDOG_TUI_DEBUG=1.
import { tuiDebug, nextId, cleanupStaleTranscriptSpillDirs, createTranscriptSpillBuffer, refillTranscriptViewOverlap, replaceSessionItemsState, createSessionItemMutators, TRANSCRIPT_LIVE_ITEM_CAP, TRANSCRIPT_SPILL_CHUNK_ITEMS } from './session/transcript-spill.mjs';
export { cleanupStaleTranscriptSpillDirs, createTranscriptSpillBuffer, refillTranscriptViewOverlap, replaceSessionItemsState, createSessionItemMutators, TRANSCRIPT_LIVE_ITEM_CAP, TRANSCRIPT_SPILL_CHUNK_ITEMS } from './session/transcript-spill.mjs';
export { parseBackgroundTaskEnvelope } from './session/agent-envelope.mjs';

export async function createLocalSessionRuntime({
  provider: providerName,
  model,
  effort,
  fast,
  modelParameters,
  toolMode = 'full',
  remote = false,
  cwd,
  desktopSession,
  sessionProfile,
  executeAgentControl,
} = {}) {
  const startedAt = performance.now();
  bootProfile('session:create:start', { provider: providerName, model, toolMode, remote });
  // Silence provider/session diagnostics so they cannot tear through the
  // alternate-screen React/ink render.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_QUIET_SESSION_LOG = '1';
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  const importStartedAt = performance.now();
  const { createMixdogSessionRuntime } = await importSessionRuntimeModule();
  bootProfile('session-runtime:imported', { ms: (performance.now() - importStartedAt).toFixed(1) });
  const runtime = await createMixdogSessionRuntime({
    provider: providerName,
    model,
    effort,
    fast,
    modelParameters,
    toolMode,
    remote,
    ...(cwd ? { cwd } : {}),
    ...(desktopSession ? { desktopSession } : {}),
    ...(sessionProfile && typeof sessionProfile === 'object' ? { sessionProfile } : {}),
    ...(typeof executeAgentControl === 'function' ? { executeAgentControl } : {}),
  });
  bootProfile('session:create:runtime-ready', { ms: (performance.now() - startedAt).toFixed(1) });
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
  const lifecycle = {
    runtimePulseTimer: null,
    unsubscribeRuntimeNotifications: null,
    unsubscribeAgentStatus: null,
    unsubscribeRemoteState: null,
  };
  const pending = [];
  const pendingNotificationKeys = new Set();
  const displayedExecutionNotificationKeys = new Set();
  const bag = {};
  let state;
  // Route/context/agent-status derivations live in ./session/context-state.mjs.
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
    // Incremental derivations published by the session runtime so App does not scan all
    // transcript items on every change:
    //  - activeToolSummary/activeTools: running Shell, Agent, and web-search
    //    counts + earliest starts for status surfaces.
    //  - promptHistoryList: newest-first deduped user-prompt history, rebuilt
    //    only when a user item is appended (replaces the per-change rescan).
    activeToolSummary: null,
    activeTools: null,
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
  bootProfile('session:route-state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  bootProfile('session:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  const contextStartedAt = performance.now();
  syncContextStats({ allowEstimated: true });
  bootProfile('session:context-ready', { ms: (performance.now() - contextStartedAt).toFixed(1) });
  const listeners = new Set();
  // React/useSyncExternalStore reads only this immutable published snapshot.
  // `state` remains the session runtime's synchronous draft until a frame flush swaps
  // the complete draft (including its single revision bump) into this slot.
  let publishedState = process.env.NODE_ENV === 'production' ? state : Object.freeze(state);
  // The mutable session runtime draft must never be the object exposed to React.
  state = { ...state, stats: { ...state.stats } };
  // Mutations stay synchronous, but React publications are frame-coalesced.
  // structureRevision is committed by the publisher exactly once immediately
  // before listeners observe the terminal snapshot for that frame.
  const publisher = createFrameBatchedStorePublisher({
    getState: () => state,
    publishState: (next) => {
      publishedState = process.env.NODE_ENV === 'production' ? next : Object.freeze(next);
      // Detach the next draft, including the only intentionally mutable nested
      // record, so internal draft writes cannot mutate the publication.
      state = { ...next, stats: { ...next.stats } };
    },
    listeners,
    isDisposed: () => flags.disposed,
    frameMs: TUI_FRAME_MS,
    scheduleFrame: scheduleRenderAlignedStoreFlush,
    cancelFrame: cancelRenderAlignedStoreFlush,
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
    // Some recovery and externally-driven settlement paths release busy
    // without returning through drain's own finally. Re-kick centrally so a
    // prompt accepted during the old turn cannot remain queued indefinitely.
    const busyReleased = state.busy === true
      && Object.prototype.hasOwnProperty.call(patch, 'busy')
      && patch.busy === false;
    state = { ...state, ...effectivePatch };
    if (requestsStructureChange) publisher.markStructureChange();
    emit();
    // Preserve the old microtask-latency behavior for interaction gates and
    // long command spinners that intentionally yield before doing heavy work.
    if (effectivePatch.commandStatus || effectivePatch.toolApproval) {
      flushEmitImmediate();
    }
    if (commandBusyReleased || busyReleased) queueMicrotask(() => { void bag.drain?.(); });
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
    state = replaceSessionItemsState({
      state,
      items: liveItems,
      itemIndexById,
      preserveStreamingTail,
      extra: {
        promptHistoryList: preserveSpill
          ? state.promptHistoryList
          : buildMergedPromptHistory(recomputePromptHistory(nextItems), loadPromptHistory(state.cwd)),
        activeToolSummary: null,
        activeTools: null,
        transcriptViewItems: nextTranscriptView,
        transcriptViewRevision: preserveTranscriptView
          ? state.transcriptViewRevision + (transcriptViewChanged ? 1 : 0)
          : state.transcriptViewRevision + 1,
        ...transcriptHistoryFlags(),
      },
    });
    // replaceSessionItemsState retains its standalone/test contract. In the live
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
  // ./session/prompt-history.mjs (recomputePromptHistory); callers still pass the
  // NEW items array explicitly and publish via set().
  // --- Active surfaced-tool summary maintained incrementally ---
  // Status surfaces must react at tool start, before a shell is backgrounded
  // or an agent worker heartbeat exists. Track the three surfaced categories
  // directly; background shell records and worker rows later dedupe by max.
  const activeToolCalls = new Map(); // callKey -> { category, count, startedAt }
  const recomputeActiveToolSummary = () => {
    let shellCount = 0, shellStart = 0;
    let webSearchCount = 0, webSearchStart = 0;
    let agentCount = 0, agentStart = 0;
    for (const rec of activeToolCalls.values()) {
      if (!rec) continue;
      const c = Math.max(1, Number(rec.count || 1));
      const started = Number(rec.startedAt || 0);
      if (rec.category === 'Shell') {
        shellCount += c;
        if (started > 0 && (shellStart === 0 || started < shellStart)) shellStart = started;
      } else if (rec.category === 'Web Research') {
        webSearchCount += c;
        if (started > 0 && (webSearchStart === 0 || started < webSearchStart)) webSearchStart = started;
      } else if (rec.category === 'Agent') {
        agentCount += c;
        if (started > 0 && (agentStart === 0 || started < agentStart)) agentStart = started;
      }
    }
    const next = shellCount || webSearchCount || agentCount
      ? `${shellCount}:${shellStart}:${webSearchCount}:${webSearchStart}:${agentCount}:${agentStart}`
      : '';
    const activeTools = next ? {
      ...(shellCount ? { shell: { count: shellCount, startedAt: shellStart } } : {}),
      ...(webSearchCount ? { web_search: { count: webSearchCount, startedAt: webSearchStart } } : {}),
      ...(agentCount ? { agent: { count: agentCount, startedAt: agentStart } } : {}),
    } : null;
    const prev = state.activeToolSummary || '';
    if (next !== prev) set({ activeToolSummary: next || null, activeTools });
  };
  const markToolCallActive = (callKey, category, count, startedAt) => {
    if (!callKey || !['Shell', 'Web Research', 'Agent'].includes(category)) return;
    activeToolCalls.set(callKey, { category, count: Math.max(1, Number(count || 1)), startedAt: Number(startedAt || Date.now()) });
    recomputeActiveToolSummary();
  };
  const markToolCallDone = (callKey) => {
    if (!callKey || !activeToolCalls.has(callKey)) return;
    activeToolCalls.delete(callKey);
    recomputeActiveToolSummary();
  };
  const clearActiveToolSummary = () => {
    if (activeToolCalls.size === 0 && !state.activeToolSummary && !state.activeTools) return;
    activeToolCalls.clear();
    if (state.activeToolSummary || state.activeTools) set({ activeToolSummary: null, activeTools: null });
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
  // Non-enumerable so the marker never enters persisted transcript items,
  // live-share JSON, or renderer snapshots. The desktop host reads the shared
  // Symbol.for key before cloning and uses it to prove that a growing text is
  // an append, avoiding an O(total text) startsWith check on every frame.
  const streamingTailTextEpochKey = Symbol.for('mixdog.streaming-tail-text-epoch');
  let streamingTailTextEpoch = 0;
  const updateStreamingTail = (id, patch = {}, extra = {}, { resetText = false } = {}) => {
    if (id == null) return false;
    const current = state.streamingTail?.id === id
      ? state.streamingTail
      : { kind: 'assistant', id, text: '', streaming: true };
    const next = { ...current, ...patch, kind: 'assistant', id, streaming: true };
    const currentTextEpoch = current[streamingTailTextEpochKey];
    const textEpoch = !resetText && Number.isSafeInteger(currentTextEpoch)
      ? currentTextEpoch
      : ++streamingTailTextEpoch;
    Object.defineProperty(next, streamingTailTextEpochKey, {
      value: textEpoch,
      enumerable: false,
      configurable: false,
      writable: false,
    });
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
  const { patchItem, settleStreamingTail } = createSessionItemMutators({
    getState: () => state,
    set,
    itemIndexById,
    normalizeItems: (items) => transcriptSpill.capLive(items),
    itemStateExtra: transcriptHistoryFlags,
  });
  const upsertSyntheticToolItem = (text, id = nextId(), parsed = null) => {
    const synthetic = parsed || parseSyntheticAgentMessage(text);
    if (!synthetic) return false;
    const label = synthetic.label || 'notification';
    const args = synthetic.args || {
      type: label,
      task_id: synthetic.taskId || parsed?.taskId || undefined,
      description: synthetic.summary || 'agent notification',
    };
    const isError = synthetic.isError ?? /^(failed|error|timeout|killed|cancelled)$/i.test(label);
    // True upsert: one completion can reach the transcript twice (live
    // notification push + queued-twin drain render). Key on task_id + name so
    // the second arrival patches the existing card instead of duplicating it.
    const upsertTaskId = String(args?.task_id || synthetic.taskId || '').trim();
    if (upsertTaskId) {
      const existing = state.items.findLast((it) => it?.kind === 'tool'
        && String(it?.args?.task_id || '').trim() === upsertTaskId
        && (it.name || 'agent') === (synthetic.name || 'agent'));
      if (existing) {
        patchItem(existing.id, {
          args,
          result: synthetic.result,
          rawResult: synthetic.rawResult ?? text,
          isError,
          completedAt: Date.now(),
        });
        return true;
      }
    }
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
    if (origin === 'injected') {
      const completion = parseModelVisibleCompletionWrapper(text);
      if (completion && upsertSyntheticToolItem(text, id, completion)) return;
    }
    // The lenient shape-only wrapper check is display-suppression only and
    // must never hide a real, directly-typed/pasted user prompt just because
    // it happens to resemble "instruction + Result: + quoted body". Only
    // apply it for injected origins (mid-turn steer relay of async
    // notifications, or non-editable task-notification queue entries) where
    // the text is known to have been synthesized by the runtime, not typed
    // by the user. Direct user submissions always go through the strict
    // detector only, same as before this change.
    if (origin === 'injected' && isInternalTranscriptDisplayText(text)) return;
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
      ...(extra && typeof extra.sender === 'string' && extra.sender ? { sender: extra.sender } : {}),
      // Byte-free attachment metadata (name/mime/size) from the queue entry —
      // lets the desktop transcript render image chips without ever carrying
      // base64 payloads through snapshots.
      ...(extra && Array.isArray(extra.images) && extra.images.length ? { images: extra.images } : {}),
    });
  };
  const pushAsyncAgentResponse = (text, id = nextId(), origin = 'injected', metadata = {}) => {
    const responseItem = buildExecutionResponseToolItem(text, {
      id,
      responseKey: metadata.responseKey || metadata.executionId,
      executionSurface: metadata.executionSurface,
      executionStatus: metadata.executionStatus,
    });
    if (!responseItem) return pushUserOrSyntheticItem(text, id, origin);
    if (responseItem.name !== 'agent') {
      pushItem(responseItem);
      return true;
    }
    const previous = state.items.at(-1);
    // Tail-only aggregation prevents a later completion from mutating a card
    // above any outbound tool, assistant, user, or preview/body boundary.
    if (
      previous?.kind === 'tool'
      && previous.agentDirection === 'inbound'
    ) {
      const patch = appendAgentResponseTail(previous, {
        key: responseItem.agentResponseKey,
        args: responseItem.args,
        result: responseItem.result,
        rawResult: responseItem.rawResult,
        hasBody: responseItem.agentResponseHasBody,
        isError: responseItem.isError,
      });
      if (patch) {
        patchItem(previous.id, patch);
        return true;
      }
    }
    pushItem(responseItem);
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
  const setProgressHint = (text, tone = 'info', percent) => {
    const value = String(text ?? '').trim();
    const numericPercent = Number(percent);
    set({ progressHint: value ? {
      text: value,
      tone,
      ...(Number.isFinite(numericPercent)
        ? { percent: Math.max(0, Math.min(100, Math.round(numericPercent))) }
        : {}),
    } : null });
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
    // Attached viewer with a live pipe: the owner's frames are authoritative
    // for stats/agent/tool state. Recomputing them locally here would stomp
    // the mirror with this process's empty registries every 2s.
    if (bag.liveShareMirroring?.()) {
      set({ ...routeState() });
      return;
    }
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
  if (typeof runtime.onAgentStatusChange === 'function') {
    lifecycle.unsubscribeAgentStatus = runtime.onAgentStatusChange(() => {
      if (flags.disposed || flags.pendingSessionReset || bag.liveShareMirroring?.()) return;
      set({ ...agentStatusState({ force: true }) });
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
    runtime, nextId, tuiDebug,
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
  Object.assign(bag, createGoalContinuation({
    runtime,
    flags,
    getState: () => state,
    set,
    getPending: () => pending,
    enqueue: (...args) => bag.enqueue(...args),
  }));
  bag.runTurn = createRunTurn(bag);
  const api = createSessionApi(bag);
  // Cross-surface share: presence + the durable pending spool remain the
  // ownership/base layer; a local pipe layer (live-share) streams frame
  // deltas so co-open surfaces mirror each other in real time.
  //  - presence: mark OUR current session as held open (idle included) so a
  //    cross-open elsewhere attaches as a viewer instead of splitting
  //    ownership; cleared on session switch here and on dispose
  //    (session-api-ext), with sidecar staleness covering crashes.
  //  - owner leg: host the live pipe, push transcript/tail/spinner deltas,
  //    and run foreign submits through the normal queue — full user bubble +
  //    streaming on every surface. The spool drain stays as the fallback
  //    intake (instant via fs.watch, 3s tick as safety net).
  //  - viewer leg: connect to the owner's pipe and mirror its live state.
  //    While the pipe is up the disk-mtime re-resume is skipped (no turn-end
  //    flicker); when the owner disappears the quiet re-resume promotes this
  //    surface to real ownership.
  let heldPresenceId = '';
  let viewerStoreMtime = 0;
  // The spool drain waits for its cross-process lock OFF the event loop now,
  // so a watch event and the 3s tick can overlap: one drain at a time.
  let remoteInjectionDrain = null;
  const drainRemoteInjections = () => {
    if (remoteInjectionDrain) return remoteInjectionDrain;
    const run = (async () => {
      const injected = (await runtime.takeRemoteInjections?.()) || [];
      if (injected.length === 0) return;
      for (const item of injected) {
        if (!item || typeof item !== 'object' || (item.text == null && item.content == null)) continue;
        const content = item.content ?? item.text;
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
        bag.enqueue(content, {
          ...(item.options && typeof item.options === 'object' ? item.options : {}),
          ...(item.text ? { displayText: item.text } : {}),
          ...(id ? { id } : {}),
        });
      }
      void bag.drain();
    })().catch(() => { /* the watch/tick pair retries */ });
    const tracked = run.finally(() => {
      if (remoteInjectionDrain === tracked) remoteInjectionDrain = null;
    });
    remoteInjectionDrain = tracked;
    return tracked;
  };
  const liveShare = createLiveShare({
    ownerSessionId: () => (flags.disposed || flags.pendingSessionReset || state.sessionRemoteAttached
      ? '' : String(state.sessionId || '')),
    viewerSessionId: () => (flags.disposed || !state.sessionRemoteAttached
      ? '' : String(state.sessionId || '')),
    socketPathFor: (id) => liveSharePipePath(id, sessionPath(id)),
    getPublishedState: () => publishedState,
    listeners,
    onRemoteSubmit: (prompt, meta) => {
      // A refusal must be REPORTED, never silent. This session runtime can be unable to
      // take a foreign prompt (disposed, or it became an attached viewer
      // itself); swallowing it here is what made a submitted message vanish
      // with no transcript row and no error (user: 입력이 씹힘). The ack sent
      // by live-share carries this verdict back so the sender can re-deliver.
      if (flags.disposed || state.sessionRemoteAttached) return false;
      // Preserve the viewer's submission id end-to-end: the queue entry and
      // the settled user item then carry the id the submitting surface used
      // for its optimistic row, so that row releases instead of duplicating.
      const queued = bag.enqueue(
        prompt,
        meta && typeof meta === 'object' ? meta : {},
      ) !== false;
      void bag.drain();
      return queued;
    },
    onRemoteAbort: () => {
      // Forwarded viewer stop: interrupt OUR active turn (we are the owner).
      if (flags.disposed || state.sessionRemoteAttached) return;
      try { api.abort?.(); } catch { /* abort is best-effort */ }
    },
    onOwnerClosed: (id) => {
      // Owner left (clean close or crash): promote via the normal quiet
      // re-resume once its final save/presence-clear has landed.
      const timer = setTimeout(() => {
        if (flags.disposed || !state.sessionRemoteAttached) return;
        if (String(state.sessionId || '') !== id) return;
        if (liveShare.viewerConnected()) return;
        void Promise.resolve(api.resume(id, { quiet: true })).catch(() => { /* tick retries */ });
      }, 1500);
      timer.unref?.();
    },
    viewerApply: {
      getState: () => state,
      set,
      replaceItems: (...args) => bag.replaceItems(...args),
      patchItem: (...args) => bag.patchItem(...args),
      appendItems: (...args) => bag.appendItems(...args),
      updateStreamingTail: (...args) => bag.updateStreamingTail(...args),
      clearStreamingTail: (...args) => bag.clearStreamingTail(...args),
    },
  });
  // Immediate live-share reconcile for session entry/promotion. Waiting for
  // the 3s share tick left a just-resumed live-owned session showing the
  // stale disk snapshot, then full-swapped the transcript mid-view once the
  // pipe finally connected (visible up/down lurch until heights resettled).
  // resume() calls this right after installing the restored items so the
  // owner's full frame lands at the entry boundary instead of seconds later.
  bag.ensureLiveShare = () => { try { liveShare.ensure(); } catch { /* share tick retries */ } };
  // Pulse guard: while this surface is an attached viewer with a live pipe,
  // owner frames own stats/agent/tool state (see runtimePulseTimer above).
  bag.liveShareMirroring = () => state.sessionRemoteAttached && liveShare.viewerConnected();
  // Live viewer submits ride the owner's pipe (instant user bubble + shared
  // streaming); the durable spool remains the fallback. Returns null when this
  // surface is NOT an attached viewer, so the local session runtime keeps the prompt.
  const viewerSubmitIntake = (prompt, options = {}) => {
    if (!state.sessionRemoteAttached) return null;
    const text = String(promptDisplayText(prompt, options) || '').trim();
    if (!text) return { accepted: false };
    return {
      accepted: forwardViewerSubmit({
        prompt,
        text,
        options,
        share: liveShare,
        // Writing to the owner's spool instead of starting a fake local turn
        // that would render an error/synthetic assistant message here.
        spool: (submissionId) => runtime.enqueueRemoteAttachedPrompt?.({
          content: prompt,
          text,
          id: submissionId,
          options,
        }) === true,
      }),
    };
  };
  if (typeof api.submit === 'function') {
    const baseSubmit = api.submit;
    api.submit = (prompt, options = {}) => {
      const forwarded = viewerSubmitIntake(prompt, options);
      return forwarded ? forwarded.accepted : baseSubmit(prompt, options);
    };
  }
  // The daemon's intake boundary is submitAsync (session-service prefers
  // it over submit). Leaving it unwrapped let a daemon-hosted VIEWER — the
  // desktop pane on a session the terminal owns — queue the prompt locally, so
  // its own user row stood beside the owner's mirrored twin.
  if (typeof api.submitAsync === 'function') {
    const baseSubmitAsync = api.submitAsync;
    api.submitAsync = async (prompt, options = {}) => {
      const forwarded = viewerSubmitIntake(prompt, options);
      return forwarded ? forwarded.accepted : baseSubmitAsync(prompt, options);
    };
  }
  // Viewer stop button: the local session runtime has no in-flight turn to cancel —
  // forward the interrupt to the owner over the pipe. Falls back to the local
  // abort (no-op safe) when the pipe is down.
  if (typeof api.abort === 'function') {
    const baseAbort = api.abort;
    api.abort = (...args) => {
      if (state.sessionRemoteAttached && liveShare.viewerConnected() && liveShare.sendAbort()) {
        return true;
      }
      return baseAbort(...args);
    };
  }
  // Attach-time pipe fast-path: session entry (resume) reconciles the live
  // pipe IMMEDIATELY instead of waiting for the 3s share tick. The attach
  // render comes from the last disk save WITHOUT the in-flight turn, so that
  // tick-wide window is exactly when a running tool call / mid-turn
  // conversation looks missing and then pops in late (user report). The
  // owner leg benefits equally: its pipe server starts the moment the
  // session opens, so cross-surface viewers can connect at once.
  const reconcileLiveShareNow = () => { try { liveShare.ensure(); } catch { /* tick retries */ } };
  for (const method of ['resume', 'newSession', 'switchContext']) {
    if (typeof api[method] !== 'function') continue;
    const base = api[method].bind(api);
    api[method] = async (...args) => {
      const result = await base(...args);
      bag.cancelQueuedGoalContinuations?.();
      bag.refreshGoalState?.();
      bag.scheduleGoalContinuation?.();
      reconcileLiveShareNow();
      if (method === 'resume' && result === true && state.sessionRemoteAttached) {
        const id = String(state.sessionId || '');
        // The session projection holds renderer publications across resume. Keep that hold
        // until the owner's first FULL frame replaces the persisted transcript,
        // then synchronously publish the complete draft before getState().
        // A healthy local owner serves its full frame on connect within tens
        // of ms; a dead presence sidecar or an owner blocked mid-turn never
        // will. The old 1500ms default made exactly those sessions stall
        // entry for the full budget (measured 1571/1519ms resumes — user:
        // 세션 로드가 가끔 매우 느림). Cap the boundary wait low: late owner
        // frames still land through viewerApply and simply replace the disk
        // restore when they arrive.
        if (id && await liveShare.waitForViewerSync(id, 400)) bag.flushEmit();
      }
      return result;
    };
  }
  // Cover session runtimes whose runtime already has a session at construction time;
  // do not wait for a lifecycle method or the 3s safety pulse to open the pipe.
  reconcileLiveShareNow();
  // Instant input pickup: watch the shared pending spool so an attached
  // surface's fallback submit reaches this owner immediately instead of on
  // the 3s tick. Best-effort — the tick below remains the safety net.
  let spoolWatcher = null;
  let spoolDebounce = null;
  try {
    const spoolPath = String(runtime.pendingSpoolPath?.() || '');
    if (spoolPath) {
      const spoolFile = basename(spoolPath);
      spoolWatcher = watch(dirname(spoolPath), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== spoolFile) return;
        if (flags.disposed || spoolDebounce) return;
        spoolDebounce = setTimeout(() => {
          spoolDebounce = null;
          if (flags.disposed || flags.pendingSessionReset) return;
          if (state.busy || state.commandBusy || state.sessionRemoteAttached) return;
          try { void drainRemoteInjections(); } catch { /* tick fallback */ }
        }, 120);
        spoolDebounce.unref?.();
      });
      spoolWatcher.on?.('error', () => {
        try { spoolWatcher.close(); } catch { /* already closed */ }
        spoolWatcher = null;
      });
    }
  } catch { /* spool watch is an optimization; the 3s tick remains */ }
  const remoteAttachTimer = setInterval(() => {
    if (flags.disposed) {
      clearInterval(remoteAttachTimer);
      try { liveShare.dispose(); } catch { /* best-effort */ }
      try { spoolWatcher?.close(); } catch { /* already closed */ }
      if (spoolDebounce) { clearTimeout(spoolDebounce); spoolDebounce = null; }
      return;
    }
    if (flags.pendingSessionReset) return;
    try {
      const heldId = runtime.publishSessionPresence?.() || '';
      if (heldPresenceId && heldPresenceId !== heldId) runtime.clearSessionPresence?.(heldPresenceId);
      heldPresenceId = heldId;
    } catch { /* best-effort */ }
    try { liveShare.ensure(); } catch { /* next tick retries */ }
    try {
      if (state.busy || state.commandBusy) return;
      if (state.sessionRemoteAttached) {
        const id = String(state.sessionId || '');
        if (!id) return;
        // Pipe-connected viewers follow the owner live; the disk-mtime
        // re-resume would only reload mid-stream state and flicker.
        if (liveShare.viewerConnected()) { viewerStoreMtime = 0; return; }
        // Self-heal: a force-killed owner never announces onOwnerClosed and
        // its final save never bumps the store mtime, so without this probe
        // the surface stays a viewer forever, spooling messages to nobody.
        // When the resume guard says the owner is gone, promote via the same
        // quiet re-resume (it drains the pending spool on the next tick).
        if (runtime.sessionOwnerGone?.(id) === true) {
          viewerStoreMtime = 0;
          void Promise.resolve(api.resume(id, { quiet: true })).catch(() => { /* next tick retries */ });
          return;
        }
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
      void drainRemoteInjections();
    } catch { /* best-effort */ }
  }, 3000);
  remoteAttachTimer.unref?.();
  void Promise.resolve(bag.restoreLeadSteeringFromDisk())
    .catch(() => {})
    .finally(() => bag.scheduleGoalContinuation?.());
  return api;
}
