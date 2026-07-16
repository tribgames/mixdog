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
export function createEngineItemMutators({ getState, set, itemIndexById }) {
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
    const items = [...state.items, item];
    itemIndexById.set(id, index);
    set({
      items,
      structureRevision: (Number(state.structureRevision) || 0) + 1,
      streamingTail: null,
      ...extra,
    });
    return true;
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
  };
  const lifecycle = { runtimePulseTimer: null, unsubscribeRuntimeNotifications: null, unsubscribeRemoteState: null };
  const pending = [];
  const pendingNotificationKeys = new Set();
  const displayedExecutionNotificationKeys = new Set();
  const bag = {};
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
    getPendingSessionReset: () => flags.pendingSessionReset,
  });

  const initialAgentState = {
    agentWorkers: [],
    agentJobs: [],
    agentScope: null,
  };
  let state = {
    items: [],
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
  // Coalesce store notifications: a single onToolCall batch / finalize path
  // fires many set() calls in one synchronous block (aggregate header sync,
  // spinner, item pushes). Notifying React on every set() painted the
  // intermediate layouts (jerky, stuttering header/count jitter). Collapsing the
  // notifications into one microtask means listeners see only the final state
  // of the current tick — "draw twice, keep the last one". getState() stays
  // synchronous and always returns the latest snapshot, so useSyncExternalStore
  // never tears.
  let emitScheduled = false;
  const flushEmit = () => {
    emitScheduled = false;
    for (const l of listeners) l();
  };
  const emit = () => {
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(flushEmit);
  };
  const set = (patch) => {
    if (!patch || typeof patch !== 'object') return false;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(state[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    // Detect commandBusy releasing (true -> false). Submits that arrived while a
    // session command was in flight were queued and drain bailed on commandBusy;
    // re-kick drain here — one central point covers every command releaser
    // (setModel/newSession/resume/clear/...) so queued prompts are never stranded.
    const commandBusyReleased = state.commandBusy === true
      && Object.prototype.hasOwnProperty.call(patch, 'commandBusy')
      && patch.commandBusy === false;
    state = { ...state, ...patch };
    emit();
    if (commandBusyReleased) queueMicrotask(() => { void bag.drain?.(); });
    return true;
  };

  const itemIndexById = new Map();
  const replaceItems = (items, { preserveStreamingTail = false } = {}) => {
    const nextItems = Array.isArray(items) ? items : [];
    // Bulk item swap (session load / clear / compact). Derive the prompt-history
    // list from the NEW items and stage it onto state here so App never rescans;
    // the callers that invoke replaceItems always follow with a set({items:...,
    // ...}) that carries fresh references, so this pre-stage does not defeat any
    // emit (the accompanying set() diffs the full patch). A bulk swap also
    // discards the old transcript, so drop any tracked active tool calls.
    activeToolCalls.clear();
    state = replaceEngineItemsState({
      state,
      items: nextItems,
      itemIndexById,
      preserveStreamingTail,
      extra: {
        promptHistoryList: buildMergedPromptHistory(recomputePromptHistory(nextItems), loadPromptHistory(state.cwd)),
        activeToolSummary: null,
      },
    });
    // replaceItems stages the bulk state before its callers compose their
    // accompanying patch. Emit here as well so an items-only replacement
    // (for example removeNotice) cannot be hidden by the outer set seeing the
    // already-installed array identity.
    emit();
    return nextItems;
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
  const pushItem = (item) => {
    if (!flags.pushingFromDeferredEntry && flags.flushDeferredBeforeImmediatePush) {
      flags.flushDeferredBeforeImmediatePush();
    }
    const index = state.items.length;
    const items = [...state.items, item];
    if (item?.id != null) itemIndexById.set(item.id, index);
    if (item?.kind === 'user') {
      // Rebuild the derived history against the NEW list (not yet in state) and
      // publish items + the fresh list in ONE set(). Do NOT pre-assign to state
      // first — set() diffs against the current state, so a pre-assign would make
      // the references identical and skip emit().
      const promptHistoryList = buildMergedPromptHistory(recomputePromptHistory(items), loadPromptHistory(state.cwd));
      set({ items, structureRevision: state.structureRevision + 1, promptHistoryList });
    } else {
      set({ items, structureRevision: state.structureRevision + 1 });
    }
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
  const pushUserOrSyntheticItem = (text, id = nextId(), origin = 'user') => {
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
    pushItem({ kind: 'user', id, text });
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
    getState: () => state, set,
    pushItem, patchItem, replaceItems, updateStreamingTail, settleStreamingTail, clearStreamingTail,
    pushToast, pushNotice, removeNotice, setProgressHint,
    pushUserOrSyntheticItem, pushAsyncAgentResponse, upsertSyntheticToolItem,
    markToolCallActive, markToolCallDone, clearActiveToolSummary, clearToastTimers,
    autoClearState, agentStatusState, baseRouteState, routeState, syncContextStats,
    presentNextToolApproval, finishToolApproval, denyAllToolApprovals, requestToolApproval,
    patchToolCardResult, flushToolResults,
    kickExecutionPendingResume, flushDeferredExecutionPendingResumeKick, scheduleExecutionPendingResumeKick, discardExecutionPendingResume, updateAgentJobCard, subscribeRuntimeNotifications,
  });
  Object.assign(bag, createSessionFlow(bag));
  bag.runTurn = createRunTurn(bag);
  void bag.restoreLeadSteeringFromDisk();
  return createEngineApi(bag);
}
