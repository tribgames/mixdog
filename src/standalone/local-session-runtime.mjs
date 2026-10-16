/**
 * Daemon-hosted session store shared by terminal, desktop and remote clients.
 *
 * Runs mixdog's session manager inside the singleton daemon and exposes the
 * subscribable store projected to clients. React/ink consumes the matching
 * remote view through useSyncExternalStore (src/tui/hooks/useSession.mjs).
 *
 * Product TUI/CLI callers use src/tui/session.mjs, never this implementation.
 * The singleton daemon and explicit parity tests are the only callers.
 */
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { bootProfile } from '../tui/session/boot-profile.mjs';
import { createGoalContinuation } from '../tui/session/goal-continuation.mjs';
import { createToolApproval } from '../tui/session/tool-approval.mjs';
import { createToolCardResults } from '../tui/session/tool-card-results.mjs';
import { createAgentJobFeed } from '../tui/session/agent-job-feed.mjs';
import { createContextState } from '../tui/session/context-state.mjs';
import { createSessionFlow } from '../tui/session/session-flow.mjs';
import { createRunTurn } from '../tui/session/turn.mjs';
import { createQuotaResumeLane } from '../tui/session/quota-resume.mjs';
import { createGitHeadWatcher } from '../runtime/shared/worktrees/git-head.mjs';
import { publicQuotaResume, quotaResumeEntry } from '../runtime/shared/quota-resume-store.mjs';
import { createSessionApi } from '../tui/session/session-api.mjs';
import { createSessionDraftStore } from '../tui/session/draft-store.mjs';
import { createInitialSessionState } from '../tui/session/initial-state.mjs';
import { createActiveToolTracker } from '../tui/session/active-tool-summary.mjs';
import { createTranscriptStore } from '../tui/session/transcript-store.mjs';
import { createTranscriptIntake } from '../tui/session/transcript-intake.mjs';
import { createNoticeSurface } from '../tui/session/notice-surface.mjs';
import { attachCrossSurfaceShare } from '../tui/session/cross-surface-share.mjs';
import { createTranscriptRouteMetadata } from '../runtime/shared/transcript-metadata.mjs';
import { formatDoctorReport, runDoctorChecks } from '../tui/app/doctor.mjs';
// tuiDebug is an opt-in diagnostic trace for the hang chain (runTurn start/end,
// busy-queue enqueue/drain). Quiet by default so it can never tear through
// the alternate-screen render; enable with MIXDOG_TUI_DEBUG=1.
import {
  tuiDebug,
  nextId,
  createTranscriptSpillBuffer,
  sweepStaleTranscriptSpillDirsOnce,
} from '../tui/session/transcript-spill.mjs';

const SESSION_RUNTIME_MODULE = '../mixdog-session-runtime.mjs';

// Shared across create calls so concurrent session startups import the
// runtime graph once.
let sessionRuntimeModulePromise = null;
let sessionRuntimeImporter = () => import(SESSION_RUNTIME_MODULE);
function importSessionRuntimeModule() {
  // A failed import is forgotten so the next caller retries lazily.
  sessionRuntimeModulePromise ??= Promise.resolve()
    .then(() => sessionRuntimeImporter())
    .catch((error) => {
      sessionRuntimeModulePromise = null;
      throw error;
    });
  return sessionRuntimeModulePromise;
}

/**
 * Background warm-up for the daemon (scheduled after the ready signal): loads
 * the session-runtime module tree and runs the one-per-process transcript
 * spill sweep, so the first session.create pays for neither. Failures are
 * swallowed — create falls back to the same lazy import.
 */
export async function warmLocalSessionRuntime() {
  try {
    await importSessionRuntimeModule();
    // Separate turn: let queued I/O run between the import and the sync sweep.
    await new Promise((resolve) => setImmediate(resolve));
    sweepStaleTranscriptSpillDirsOnce();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: replace the dynamic import of the session-runtime module. */
export function setSessionRuntimeImporterForTest(importer) {
  sessionRuntimeImporter = importer || (() => import(SESSION_RUNTIME_MODULE));
  sessionRuntimeModulePromise = null;
}

const TOOL_APPROVAL_TIMEOUT_MS = (() => {
  const value = Number(process.env.MIXDOG_TOOL_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : 120_000;
})();

export {
  cleanupStaleTranscriptSpillDirs,
  createTranscriptSpillBuffer,
  refillTranscriptViewOverlap,
  replaceSessionItemsState,
  createSessionItemMutators,
  TRANSCRIPT_LIVE_ITEM_CAP,
  TRANSCRIPT_SPILL_CHUNK_ITEMS,
} from '../tui/session/transcript-spill.mjs';
export { parseBackgroundTaskEnvelope } from '../tui/session/agent-envelope.mjs';

/**
 * The 2s runtime pulse picks up runtime-derived state that changes without a
 * notification: the route (model/effort/context window/cwd/Goal), the context
 * gauge stats, and agent status. It publishes ONLY when one of those values
 * actually differs from the draft or the published snapshot. Re-publishing an
 * unchanged session minted a fresh snapshot every 2s, which the session
 * service projected as a new revision and which kept its idle-projection
 * release from ever firing for a watched session.
 */
export function createRuntimePulse({
  flags,
  liveShareMirroring,
  getState,
  getPublishedState,
  set,
  emit,
  routeState,
  agentStatusState,
  syncContextStats,
}) {
  const publishChanged = (patch) => {
    const draftState = getState();
    const published = getPublishedState();
    const changed = {};
    let dirty = false;
    for (const [key, value] of Object.entries(patch)) {
      // syncContextStats stages its fields straight into the draft without
      // scheduling a frame, so a value equal to the draft may still be
      // unpublished.
      if (isDeepStrictEqual(draftState[key], value) && isDeepStrictEqual(published[key], value)) continue;
      changed[key] = value;
      dirty = true;
    }
    if (!dirty) return false;
    if (!set(changed)) emit();
    return true;
  };
  const pulse = () => {
    if (flags.disposed) return;
    if (flags.pendingSessionReset) return;
    // Attached viewer with a live pipe: the owner's frames are authoritative
    // for stats/agent/tool state. Recomputing them locally here would stomp
    // the mirror with this process's empty registries every 2s.
    if (liveShareMirroring()) {
      publishChanged({ ...routeState() });
      return;
    }
    syncContextStats({ allowEstimated: true });
    publishChanged({
      ...routeState(),
      stats: { ...getState().stats },
      ...agentStatusState(),
    });
  };
  /** Publishes just the workspace (a HEAD change): no stats or agent recompute. */
  pulse.publishWorkspace = () => {
    if (flags.disposed || flags.pendingSessionReset) return;
    publishChanged({ workspace: routeState().workspace });
  };
  return pulse;
}

export async function createLocalSessionRuntime({
  provider: providerName,
  model,
  effort,
  fast,
  autoEffort,
  modelParameters,
  contextPercent,
  contextTokens,
  selectedContextWindow,
  toolMode = 'full',
  remote = false,
  cwd,
  desktopSession,
  sessionProfile,
  worktree,
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
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    selectedContextWindow,
    toolMode,
    remote,
    ...(cwd ? { cwd } : {}),
    ...(desktopSession ? { desktopSession } : {}),
    ...(sessionProfile && typeof sessionProfile === 'object' ? { sessionProfile } : {}),
    // Session creation worktree intent; consumed by the workspace transition scope.
    ...(worktree && typeof worktree === 'object' ? { worktree } : {}),
    ...(typeof executeAgentControl === 'function' ? { executeAgentControl } : {}),
  });
  bootProfile('session:create:runtime-ready', { ms: (performance.now() - startedAt).toFixed(1) });
  const runtimeCwd = runtime.cwd || process.cwd();
  const stateStartedAt = performance.now();
  const flags = {
    disposed: false,
    // Canonical-close execution fence: 'open' | 'closing' | 'terminal'.
    admission: 'open',
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
  // Route/context/agent-status derivations live in src/tui/session/context-state.mjs.
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
    getQuotaResume: () => publicQuotaResume(quotaResumeEntry(runtime.id)),
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
  const runtimePulse = createRuntimePulse({
    flags,
    liveShareMirroring: () => bag.liveShareMirroring?.() === true,
    getState,
    getPublishedState,
    set,
    emit: store.emit,
    routeState,
    agentStatusState,
    syncContextStats,
  });
  // A `git switch` from any terminal reaches the island within ~a frame; the
  // pulse retargets the watch when the session's folder moves.
  const headWatch = createGitHeadWatcher({
    getCwd: () => runtime.getLiveWorkspace?.()?.cwd || runtime.cwd,
    onChange: runtimePulse.publishWorkspace,
  });
  headWatch.retarget();
  lifecycle.unsubscribeGitHeadWatch = headWatch.dispose;
  lifecycle.runtimePulseTimer = setInterval(() => {
    headWatch.retarget();
    runtimePulse();
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
    getAdmission: () => flags.admission || 'open',
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
  // Runtime-driven completion wakes (no attached surface acked the completion)
  // get the same idle auto-clear as a user submit.
  lifecycle.unsubscribeCompletionWakeGate = runtime.setCompletionWakeGate?.(() => bag.autoClearBeforeWake()) || null;
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
  Object.assign(bag, createQuotaResumeLane(bag));
  bag.runTurn = createRunTurn(bag);
  bag.doctor = { runDoctorChecks, formatDoctorReport };
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
