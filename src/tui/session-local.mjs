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
import { bootProfile } from './session/boot-profile.mjs';
import { createGoalContinuation } from './session/goal-continuation.mjs';
import { createToolApproval } from './session/tool-approval.mjs';
import { createToolCardResults } from './session/tool-card-results.mjs';
import { createAgentJobFeed } from './session/agent-job-feed.mjs';
import { createContextState } from './session/context-state.mjs';
import { createSessionFlow } from './session/session-flow.mjs';
import { createRunTurn } from './session/turn.mjs';
import { createSessionApi } from './session/session-api.mjs';
import { createSessionDraftStore } from './session/draft-store.mjs';
import { createInitialSessionState } from './session/initial-state.mjs';
import { createActiveToolTracker } from './session/active-tool-summary.mjs';
import { createTranscriptStore } from './session/transcript-store.mjs';
import { createTranscriptIntake } from './session/transcript-intake.mjs';
import { createNoticeSurface } from './session/notice-surface.mjs';
import { attachCrossSurfaceShare } from './session/cross-surface-share.mjs';
import { createTranscriptRouteMetadata } from '../runtime/shared/transcript-metadata.mjs';
const SESSION_RUNTIME_MODULE = '../mixdog-session-runtime.mjs';

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
  agentLoopPrewarmPromise ??= import('../runtime/agent/orchestrator/session/manager/runtime-loaders.mjs').then(
    (module) => module.prewarmAgentLoop()
  );
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
  const bootFlag = String(process.env.MIXDOG_BOOT_CORE_MEMORY ?? '')
    .trim()
    .toLowerCase();
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
import { tuiDebug, nextId, createTranscriptSpillBuffer } from './session/transcript-spill.mjs';
export {
  cleanupStaleTranscriptSpillDirs,
  createTranscriptSpillBuffer,
  refillTranscriptViewOverlap,
  replaceSessionItemsState,
  createSessionItemMutators,
  TRANSCRIPT_LIVE_ITEM_CAP,
  TRANSCRIPT_SPILL_CHUNK_ITEMS,
} from './session/transcript-spill.mjs';
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
  // The one synchronous draft every collaborator reads through; the draft
  // store below publishes immutable snapshots from it once per frame.
  const draft = { state: null };
  // Bound once the goal-continuation controller exists: route publications
  // read the Goal through its archive mask, never the raw record.
  let visibleGoalStatus = null;
  // Route/context/agent-status derivations live in ./session/context-state.mjs.
  // getState()/updateState() are late-bound to the draft so they serve both
  // the pre-publication seed below and every later pulse.
  const { autoClearState, agentStatusState, baseRouteState, routeState, syncContextStats } = createContextState({
    runtime,
    getState: () => draft.state,
    updateState: (patch) => {
      draft.state = { ...draft.state, ...patch };
    },
    getPendingSessionReset: () => flags.pendingSessionReset,
    getVisibleGoal: () => (visibleGoalStatus ? visibleGoalStatus() : runtime.goalStatus?.() || null),
  });
  draft.state = createInitialSessionState({ runtime, runtimeCwd, baseRouteState });
  bootProfile('session:route-state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  bootProfile('session:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  const contextStartedAt = performance.now();
  syncContextStats({ allowEstimated: true });
  bootProfile('session:context-ready', { ms: (performance.now() - contextStartedAt).toFixed(1) });
  const listeners = new Set();
  const store = createSessionDraftStore({
    draft,
    listeners,
    isDisposed: () => flags.disposed,
    onBusyReleased: () => {
      void bag.drain?.();
      bag.scheduleGoalContinuation?.();
    },
  });
  const { getState, getPublishedState, set, flushEmit, flushEmitImmediate } = store;

  const itemIndexById = new Map();
  const transcriptSpill = createTranscriptSpillBuffer();
  const { markToolCallActive, markToolCallDone, clearActiveToolSummary, resetActiveToolCalls } =
    createActiveToolTracker({ getState, set });
  const {
    restoreOlderTranscript,
    restoreNewerTranscript,
    replaceItems,
    pushItem,
    appendItems,
    patchItem,
    updateStreamingTail,
    settleStreamingTail,
    clearStreamingTail,
  } = createTranscriptStore({
    draft,
    store,
    flags,
    transcriptSpill,
    itemIndexById,
    onBulkReplace: resetActiveToolCalls,
  });
  const transcriptRouteMetadata = (at = Date.now()) => createTranscriptRouteMetadata(runtime.session, routeState(), at);
  const { upsertSyntheticToolItem, pushUserOrSyntheticItem, pushAsyncAgentResponse } = createTranscriptIntake({
    getState,
    flags,
    pushItem,
    patchItem,
    transcriptRouteMetadata,
  });
  const { pushToast, pushNotice, removeNotice, setProgressHint, clearToastTimers } = createNoticeSurface({
    getState,
    set,
    isDisposed: () => flags.disposed,
    pushItem,
    replaceItems,
  });
  const { presentNextToolApproval, finishToolApproval, denyAllToolApprovals, requestToolApproval } = createToolApproval(
    {
      getState,
      set,
      nextId,
      getDisposed: () => flags.disposed,
      timeoutMs: TOOL_APPROVAL_TIMEOUT_MS,
    }
  );
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
      stats: { ...getState().stats },
      ...agentStatusState(),
    });
  }, 2000);
  lifecycle.runtimePulseTimer.unref?.();

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
    getState,
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
      bag.scheduleGoalContinuation?.();
    });
  }

  const { patchToolCardResult, flushToolResults } = createToolCardResults({
    getState,
    set,
    patchItem,
    markToolCallDone,
    updateAgentJobCard,
    buildAgentJobCardPatch,
    agentStatusState,
    itemIndexById,
  });

  Object.assign(bag, {
    runtime,
    nextId,
    tuiDebug,
    flags,
    lifecycle,
    pending,
    pendingNotificationKeys,
    displayedExecutionNotificationKeys,
    clearExecutionDedupState,
    listeners,
    itemIndexById,
    getState,
    getPublishedState,
    set,
    flushEmit,
    flushEmitImmediate,
    disposeEmit: store.disposeEmit,
    pushItem,
    appendItems,
    patchItem,
    replaceItems,
    restoreOlderTranscript,
    restoreNewerTranscript,
    updateStreamingTail,
    settleStreamingTail,
    clearStreamingTail,
    pushToast,
    pushNotice,
    removeNotice,
    setProgressHint,
    pushUserOrSyntheticItem,
    pushAsyncAgentResponse,
    upsertSyntheticToolItem,
    markToolCallActive,
    markToolCallDone,
    clearActiveToolSummary,
    clearToastTimers,
    autoClearState,
    agentStatusState,
    baseRouteState,
    routeState,
    transcriptRouteMetadata,
    syncContextStats,
    disposeTranscriptSpill: () => transcriptSpill.dispose(),
    snapshotTranscriptSpill: () => transcriptSpill.snapshot(),
    restoreTranscriptSpill: (snapshot) => transcriptSpill.restoreSnapshot(snapshot),
    releaseTranscriptSpill: (snapshot) => transcriptSpill.releaseSnapshot(snapshot),
    presentNextToolApproval,
    finishToolApproval,
    denyAllToolApprovals,
    requestToolApproval,
    patchToolCardResult,
    flushToolResults,
    kickExecutionPendingResume,
    flushDeferredExecutionPendingResumeKick,
    scheduleExecutionPendingResumeKick,
    discardExecutionPendingResume,
    updateAgentJobCard,
    subscribeRuntimeNotifications,
  });
  Object.assign(bag, createSessionFlow(bag));
  Object.assign(
    bag,
    createGoalContinuation({
      runtime,
      flags,
      getState,
      set,
      getPending: () => pending,
      enqueue: (...args) => bag.enqueue(...args),
    })
  );
  visibleGoalStatus = bag.visibleGoalStatus;
  bag.runTurn = createRunTurn(bag);
  const api = createSessionApi(bag);
  attachCrossSurfaceShare({ runtime, api, bag, flags, getState, getPublishedState, listeners, set });
  void Promise.resolve(bag.restoreLeadSteeringFromDisk())
    .catch(() => {})
    .finally(() => {
      bag.refreshGoalState?.();
      bag.scheduleGoalContinuation?.();
    });
  return api;
}
