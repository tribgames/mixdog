/**
 * src/tui/session/turn.mjs - lead TUI turn session runtime (createRunTurn).
 *
 * One turn = runtime.ask() with event handlers that route into two explicit
 * per-turn state objects — the streaming text/thinking state
 * (turn-stream.mjs) and the tool cards (turn-tool-cards.mjs) — plus the
 * turn record below that finalization publishes as the turndone item.
 */
import { applyUsageDelta } from './session-stats.mjs';
import { pickVerb, pickDoneVerb, compactEventLabel, compactEventDetail } from './labels.mjs';
import { toolErrorDisplay } from './tool-result-text.mjs';
import { errText, isCancelLikeError } from '../../runtime/shared/err-text.mjs';
import { preserveGoalStateAfterTurn } from './goal-turn-state.mjs';
export { preserveGoalStateAfterTurn } from './goal-turn-state.mjs';
export { transcriptToolCallDisplayMode } from './turn-tool-cards.mjs';
import { safeErrorDetails } from '../../runtime/shared/error-presentation.mjs';
import { promptDisplayText, STEERING_SUPPRESSED_DISPLAY } from './queue-helpers.mjs';
import { yieldToRenderer } from './render-timing.mjs';
import {
  createTurnStream,
  flushStreamBatch,
  commitAssistantSegment,
  closeThinkingSegment,
  closeThinkingForToolBatch,
  appendTextDelta,
  appendAssistantText,
  appendReasoningDelta,
  resetStreamedText,
  applyStageChange,
  settleFinalText,
  settleOpenSegmentOnCancel,
  settleStreamingTailAtClose,
  finalOutputTokens,
} from './turn-stream.mjs';
import {
  createTurnToolCards,
  builtinSkillNamesFor,
  visibleToolCalls,
  taskWaitSpinnerMode,
  openToolBatch,
  receiveToolResult,
  finalizeToolCards,
  collectClosingCards,
  startLiveTail,
} from './turn-tool-cards.mjs';

function isUsageLimitError(error) {
  if (!error) return false;
  const status = Number(error?.httpStatus || error?.status || error?.response?.status || 0);
  if (error?.providerQuota === true || error?.quotaExceeded === true || status === 429) return true;
  const text = String(error?.message || error);
  return /\brate[_ -]?limit\b|\bquota\b|too many requests|resource exhausted|insufficient_quota|quota_exceeded/i.test(
    text
  );
}

function turnOutcome(cancelled, failed) {
  if (cancelled) return 'cancelled';
  return failed ? 'failed' : 'done';
}

// Small fallbacks keep isolated createRunTurn harnesses source-compatible;
// the real session runtime supplies atomic implementations that also
// maintain revision.
function streamingTailStore({ updateStreamingTail, settleStreamingTail, clearStreamingTail, getState, set, pushItem }) {
  return {
    updateStreamingTail:
      updateStreamingTail ||
      ((id, patch = {}, extra = {}) => {
        set({
          streamingTail: { ...(getState().streamingTail || {}), ...patch, kind: 'assistant', id, streaming: true },
          ...extra,
        });
        return true;
      }),
    settleStreamingTail:
      settleStreamingTail ||
      ((id, patch = {}) => {
        const tail = getState().streamingTail;
        if (!tail || tail.id !== id) return false;
        pushItem({ ...tail, ...patch, kind: 'assistant', id, streaming: false });
        set({ streamingTail: null });
        return true;
      }),
    clearStreamingTail:
      clearStreamingTail ||
      ((id = null) => {
        if (id == null || getState().streamingTail?.id === id) set({ streamingTail: null });
        return true;
      }),
  };
}

// The turn record: identity, transcript metadata, and the outcome fields
// finalization publishes.
function beginTurn({ flags, getState, transcriptRouteMetadata }, options) {
  const index = getState().stats.turns || 0;
  const startedAt = Date.now();
  const completionVerb = pickDoneVerb(index);
  const transcriptMeta = {
    ...(flags.pendingTranscriptMeta || transcriptRouteMetadata?.(startedAt) || { at: startedAt }),
    ...(options.transcriptMeta && typeof options.transcriptMeta === 'object' ? options.transcriptMeta : {}),
    completionVerb,
  };
  flags.pendingTranscriptMeta = null;
  const { at: _userItemAt, ...routeMeta } = transcriptMeta;
  return {
    index,
    startedAt,
    completionVerb,
    transcriptMeta,
    routeMeta,
    // Per-turn epoch prevents a disposed/replaced surface from publishing a
    // terminal snapshot after another turn has become the visible owner.
    epoch: ++flags.leadTurnEpoch,
    inputBaseline: getState().stats.inputTokens,
    outputBaseline: getState().stats.outputTokens,
    submittedIds: Array.isArray(options.submittedIds) ? options.submittedIds : [],
    itemsAtStart: 0,
    currentItemsStart: 0,
    promptCommitted: false,
    cancelled: false,
    failed: false,
    failureDetail: '',
    failureDiagnostic: '',
    usageLimited: false,
    askResult: null,
    finishedNormally: false,
    transcriptCompacted: false,
  };
}

// The submitted user row is pushed immediately before runTurn. Keep it and
// everything produced after it if compaction succeeds mid-turn; dropping all
// items would invalidate live tool-card ids and the streaming assistant tail.
function markTranscriptStart(turn, items) {
  const submittedIdSet = new Set(turn.submittedIds.filter((id) => id != null));
  const firstSubmittedIndex = items.findIndex((item) => submittedIdSet.has(item?.id));
  turn.itemsAtStart = items.length;
  turn.currentItemsStart = firstSubmittedIndex >= 0 ? firstSubmittedIndex : items.length;
}

function promptRestoreFor(displayText, options, submittedIds) {
  return {
    text: String(displayText || '').trim(),
    pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
    pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
    onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
    restorable: options.restorable !== false,
    submittedIds,
    reclaimed: false,
    committed: false,
    requeueEntries: Array.isArray(options.requeueOnAbort) ? options.requeueOnAbort.slice() : [],
    discardExecutionPendingResumeKeys: Array.isArray(options.discardExecutionPendingResumeKeys)
      ? options.discardExecutionPendingResumeKeys.slice()
      : [],
  };
}

function commitPromptRestore(flags, turn) {
  const restore = flags.activePromptRestore;
  if (!restore) return;
  if (!turn.promptCommitted && typeof restore.onCommitted === 'function') {
    turn.promptCommitted = true;
    try {
      restore.onCommitted();
    } catch {}
  }
  restore.restorable = false;
  restore.committed = true;
  restore.requeueEntries = [];
  restore.pastedImages = null;
  restore.pastedTexts = null;
}

function steeringItemExtras(steeringMeta) {
  return {
    // Queue mode + execution provenance: a task notification is rendered as
    // a tool card, never as an injected user bubble.
    ...(steeringMeta?.mode === 'task-notification' ? { mode: 'task-notification' } : {}),
    ...(steeringMeta?.execution && typeof steeringMeta.execution === 'object'
      ? { execution: steeringMeta.execution }
      : {}),
    ...(Array.isArray(steeringMeta?.images) && steeringMeta.images.length ? { images: steeringMeta.images } : {}),
    ...(typeof steeringMeta?.transcriptMeta?.sender === 'string' && steeringMeta.transcriptMeta.sender
      ? { sender: steeringMeta.transcriptMeta.sender }
      : {}),
  };
}

// Steering can be injected after a terminal no-tool response has already
// streamed but before runTurn finalizes: seal the current assistant segment
// first (including a streamed tail that never got a trailing '\n') so the
// steered user turn and the next assistant response do not merge into one
// bubble and the tail is not dropped when the injection races finalization.
function injectSteerMessage({ stream, cards, pushUserOrSyntheticItem }, text, steeringMeta = {}) {
  // A suppressed live-completion twin is model-visible only; its Response
  // card was already pushed at delivery time.
  if (text === STEERING_SUPPRESSED_DISPLAY) return;
  flushStreamBatch(stream);
  commitAssistantSegment(stream, { sealToolBlock: true });
  stream.assistantText = '';
  const value = String(text || '').trim();
  if (!value) return;
  // Any non-tool transcript item is a block boundary: seal the aggregate
  // continuation so a later same-category tool call opens a fresh card
  // instead of reusing one whose count would change ABOVE this item.
  cards.aggregates.clearAggregateContinuation();
  const steeringIds = Array.isArray(steeringMeta?.ids)
    ? steeringMeta.ids.filter((id) => id !== undefined && id !== null)
    : [];
  pushUserOrSyntheticItem(value, steeringIds[0], 'injected', steeringItemExtras(steeringMeta));
}

async function openToolCalls(ctx, calls) {
  const { stream, cards, runtime } = ctx;
  ctx.markPromptCommitted();
  // Flush buffered mid-turn assistant text before the tool card appears;
  // otherwise, with neither a thinking panel nor a spinner active, the
  // message above the tool card vanished.
  flushStreamBatch(stream);
  const batchCalls = (calls || []).filter(Boolean);
  if (batchCalls.length === 0) return;
  const displayCalls = visibleToolCalls(cards, batchCalls, await builtinSkillNamesFor(runtime, batchCalls));
  closeThinkingForToolBatch(stream, taskWaitSpinnerMode(cards));
  commitAssistantSegment(stream, { sealToolBlock: true });
  openToolBatch(cards, displayCalls);
  await yieldToRenderer();
}

async function approveToolRequest(ctx, request) {
  const { stream, getState, set, requestToolApproval, isCurrentTurn } = ctx;
  ctx.markPromptCommitted();
  flushStreamBatch(stream);
  if (getState().spinner) set({ spinner: { ...getState().spinner, mode: 'tool-approval' } });
  const approval = await requestToolApproval(request);
  if (!isCurrentTurn()) return { approved: false, reason: 'turn no longer active' };
  return approval;
}

// Pre-send context readout, emitted by the loop at the exact point the
// auto-compact decision is made, so the gauge reads 100% on the same frame
// compaction starts. Routine pre-send checks stay on the canonical
// contextStatus path instead of competing with its provider-aligned value.
function publishContextPressure({ syncContextStats, getState, set }, info) {
  if (info?.willCompact !== true) return;
  const used = Math.max(0, Number(info?.usedTokens) || 0);
  if (!used) return;
  syncContextStats({ allowEstimated: true });
  set({ stats: { ...getState().stats } });
}

// Compaction itself remains owned by the pre-provider-send pass. This event
// trims the visible transcript to the current turn and refreshes the gauge
// from the already-mutated transcript before another render can show stale
// pressure.
function applyCompactEvent(ctx, event) {
  const { turn, stream, cards, getState, set, replaceItems, pushItem, nextId, syncContextStats, routeState } = ctx;
  flushStreamBatch(stream);
  // Non-tool transcript item — same block-boundary rule as the steered user
  // item: seal any live aggregate first.
  cards.aggregates.clearAggregateContinuation();
  const compactStatus = String(event?.status || '').toLowerCase();
  const compactChanged = !['failed', 'skipped', 'no_change'].includes(compactStatus);
  if (compactChanged) {
    set({ items: replaceItems(getState().items.slice(turn.currentItemsStart), { preserveStreamingTail: true }) });
    turn.currentItemsStart = 0;
    turn.transcriptCompacted = true;
  }
  pushItem({ kind: 'statusdone', id: nextId(), label: compactEventLabel(event), detail: compactEventDetail(event) });
  syncContextStats({ allowEstimated: true, invalidateExact: compactChanged });
  // syncContextStats only STAGES its patch; publication is the caller's, and
  // without this set the post-compact gauge reached React only if some later
  // mutation happened to carry it.
  set({ ...routeState(), stats: { ...getState().stats } });
}

function applyTurnUsageDelta({ turn, getState, set, syncContextStats }, delta) {
  const stats = { ...getState().stats };
  applyUsageDelta(stats, delta);
  set({ stats });
  syncContextStats({ allowEstimated: true });
  const inputTokens = Math.max(0, getState().stats.inputTokens - turn.inputBaseline);
  const outputTokens = Math.max(0, getState().stats.outputTokens - turn.outputBaseline);
  const spinner = getState().spinner;
  set({ stats: { ...getState().stats }, ...(spinner ? { spinner: { ...spinner, inputTokens, outputTokens } } : {}) });
}

function turnHandlers(ctx) {
  const { isCurrentTurn, drainPendingSteering } = ctx;
  return {
    drainSteering: (_sessionId, drainOptions) =>
      isCurrentTurn() ? drainPendingSteering({ ...drainOptions, turnEpoch: ctx.turn.epoch }) : [],
    onStreamDelta: () => {},
    onSteerMessage: (text, steeringMeta = {}) => {
      if (isCurrentTurn()) injectSteerMessage(ctx, text, steeringMeta);
    },
    onContextPressure: (info) => {
      if (isCurrentTurn()) publishContextPressure(ctx, info);
    },
    onCompactEvent: (event) => {
      if (isCurrentTurn()) applyCompactEvent(ctx, event);
    },
    onUsageDelta: (delta) => {
      if (isCurrentTurn()) applyTurnUsageDelta(ctx, delta);
    },
  };
}

function toolHandlers(ctx) {
  const { isCurrentTurn, cards, getState, set, options } = ctx;
  return {
    onToolCall: async (_iter, calls) => {
      if (isCurrentTurn()) await openToolCalls(ctx, calls);
    },
    onToolResult: (message) => {
      if (!isCurrentTurn()) return;
      try {
        options.onToolResult?.(message);
      } catch {}
      receiveToolResult(cards, message);
    },
    onToolPhaseCompleted: () => {
      if (!isCurrentTurn()) return;
      const spinner = getState().spinner;
      if (!spinner || spinner.mode === 'requesting') return;
      // A completed tool batch is not the end of the turn: publish the
      // provider-resume phase immediately instead of leaving the last tool
      // state parked on screen until the next model event arrives.
      set({ spinner: { ...spinner, mode: 'requesting' } });
    },
    onToolApproval: async (request) => {
      if (!isCurrentTurn()) return { approved: false, reason: 'turn no longer active' };
      return approveToolRequest(ctx, request);
    },
  };
}

function streamHandlers(ctx) {
  const { isCurrentTurn, stream } = ctx;
  return {
    onStageChange: async (stage, detail = null) => {
      if (isCurrentTurn()) await applyStageChange(stream, stage, detail);
    },
    onTextDelta: (chunk) => {
      const textChunk = String(chunk ?? '');
      if (!textChunk || !isCurrentTurn()) return;
      ctx.markPromptCommitted();
      appendTextDelta(stream, textChunk);
    },
    onTextReset: (reset = {}) => (isCurrentTurn() ? resetStreamedText(stream, reset) : false),
    onAssistantText: (text) => {
      const full = String(text ?? '');
      if (!full.trim() || !isCurrentTurn()) return;
      // The streaming path owns this segment when it already produced text.
      // Do not check turn-global assistantText: earlier closed preambles stay
      // there across tool calls.
      if (stream.currentAssistantText.trim()) return;
      ctx.markPromptCommitted();
      appendAssistantText(stream, full);
    },
    onReasoningDelta: (chunk) => {
      if (isCurrentTurn()) appendReasoningDelta(stream, String(chunk ?? ''));
    },
  };
}

function completeTurn(ctx, result, session) {
  const { turn, stream, cards, pushNotice, syncContextStats, getState, set } = ctx;
  turn.askResult = result;
  ctx.markPromptCommitted();
  if (result?.terminationReason === 'refusal') {
    pushNotice('The model refused to respond (safety refusal) — retry or rephrase your prompt.', 'warn', {
      transcript: true,
    });
  }
  finalizeToolCards(cards, session?.messages || []);
  flushStreamBatch(stream); // force-flush any batched streaming text before finalization writes
  syncContextStats({ allowEstimated: true });
  // Terminal reading for the turn: without its own publication the last
  // gauge number React ever saw is the previous usage delta's.
  set({ stats: { ...getState().stats } });
  settleFinalText(stream, result?.content != null ? String(result.content) : '');
  turn.finishedNormally = true;
}

function failTurn(ctx, error) {
  const { turn, stream, cards, pushNotice } = ctx;
  flushStreamBatch(stream); // ensure any batched text lands before the error notice
  if (isCancelLikeError(error)) {
    turn.cancelled = true;
    settleOpenSegmentOnCancel(stream);
    finalizeToolCards(cards, [], { cancelled: true });
    return;
  }
  turn.failed = true;
  cards.aggregates.finalizeToolHeaders();
  turn.usageLimited = isUsageLimitError(error);
  turn.failureDetail = toolErrorDisplay(error, 'turn').replace(/^Error:\s*/i, '');
  turn.failureDiagnostic = safeErrorDetails(errText(error));
  pushNotice(turn.failureDetail, 'error', { owner: 'transcript' });
}

function turnDoneItem({ turn, stream, cards, getState, nextId }) {
  return {
    kind: 'turndone',
    id: nextId(),
    elapsedMs: Date.now() - turn.startedAt,
    status: turnOutcome(turn.cancelled, turn.failed),
    outputTokens: finalOutputTokens(stream, getState().spinner?.outputTokens),
    thinkingElapsedMs: stream.thinkingStartedAt ? stream.accumulatedThinkingMs : 0,
    toolCount: cards.toolCards.length,
    verb: turn.completionVerb,
    at: Date.now(),
    ...(turn.failureDetail ? { detail: turn.failureDetail } : {}),
    ...(turn.failureDiagnostic ? { errorDetails: turn.failureDiagnostic } : {}),
    ...turn.routeMeta,
  };
}

// Shared-state writes at turn close: settle the streaming tail, count the
// turn, and land deferred cards + the turndone summary + status in ONE set().
function publishTurnClose(ctx, closingItems) {
  const { turn, stream, cards, flags, getState, set, routeState, runtime, agentStatusState } = ctx;
  settleStreamingTailAtClose(stream);
  const producedTranscriptItem =
    turn.transcriptCompacted || getState().items.length + closingItems.length > turn.itemsAtStart;
  const reclaimed = turn.cancelled && flags.activePromptRestore?.reclaimed === true;
  flags.activePromptRestore = null;
  const resultContent = turn.askResult?.content != null ? String(turn.askResult.content).trim() : '';
  const assistantOutput = (stream.currentAssistantText || stream.assistantText || '').trim();
  // Suppress only true pending-resume no-ops: no transcript items added and
  // no model output; cancelled/error turns and any visible turn stay marked.
  const isNoOpTurn =
    turn.finishedNormally &&
    !turn.cancelled &&
    cards.toolCards.length === 0 &&
    !resultContent &&
    !assistantOutput &&
    !producedTranscriptItem;
  if (!isNoOpTurn) set({ stats: { ...getState().stats, turns: (getState().stats.turns || 0) + 1 } });
  // The post-think summary is pinned into the transcript right after this
  // turn's output so it scrolls up with the answer and stays in scrollback.
  if (!reclaimed && !isNoOpTurn) closingItems.push(turnDoneItem(ctx));
  cards.deferredCards.appendItemsBatch(closingItems, {
    busy: false,
    spinner: null,
    thinking: null,
    lastTurn: null,
    stats: { ...getState().stats },
    ...routeState(),
    toolMode: runtime.toolMode,
    ...agentStatusState({ force: true }),
  });
  ctx.flushDeferredExecutionPendingResumeKick();
}

// A replaced/disposed surface must not write shared state owned by the
// current visible turn.
function closeTurn(ctx, stopLiveTail) {
  const { turn, stream, cards, flags, isCurrentTurn, denyAllToolApprovals, tuiDebug } = ctx;
  const stale = !isCurrentTurn();
  if (!stale) denyAllToolApprovals(turn.cancelled ? 'turn cancelled' : 'turn finished');
  stopLiveTail();
  const closingItems = collectClosingCards(cards, stale);
  if (!stale) flags.flushDeferredBeforeImmediatePush = null;
  closeThinkingSegment(stream);
  if (stale) {
    tuiDebug(`runTurn STALE UNWIND turn=${turn.index} — skipping shared UI/state writes`);
    return;
  }
  publishTurnClose(ctx, closingItems);
}

async function settleTurn(ctx) {
  const { turn, stream, flags, bag, options, runtime, isCurrentTurn } = ctx;
  // A stale unwind must not wipe a newer turn's live tool-summary line.
  if (flags.leadTurnEpoch === turn.epoch) ctx.clearActiveToolSummary();
  // Turn completion is latency-sensitive and must publish busy=false plus all
  // terminal transcript/card mutations as one final snapshot.
  ctx.flushEmit?.();
  stream.publishedThinkingActive = false; // turn teardown cleared thinking
  const finalStatus = turnOutcome(turn.cancelled, turn.failed);
  const detail = {
    status: finalStatus,
    result: turn.askResult,
    session: runtime.session || null,
    error: turn.failureDetail || null,
  };
  // Publish termination before optional Goal work can delay the caller.
  bag.settleSteeredSubmissions?.(turn.epoch, detail);
  try {
    options.onSettled?.(detail);
  } catch {}
  try {
    await bag.onGoalTurnSettled?.({
      status: finalStatus,
      error: turn.failureDiagnostic || turn.failureDetail || null,
      usageLimited: turn.usageLimited,
      preserveGoalState: preserveGoalStateAfterTurn({
        cancelled: turn.cancelled,
        stale: !isCurrentTurn(),
        pendingSessionReset: flags.pendingSessionReset,
        disposed: flags.disposed,
        interruptedForSteering: flags.goalSteeringAbortEpoch === turn.epoch,
      }),
    });
  } catch {}
  if (flags.goalSteeringAbortEpoch === turn.epoch) flags.goalSteeringAbortEpoch = null;
  ctx.tuiDebug(
    `runTurn end turn=${turn.index} status=${finalStatus} elapsedMs=${Date.now() - turn.startedAt} pending=${ctx.pending.length}`
  );
  return finalStatus;
}

export function createRunTurn(bag) {
  const { runtime, flags, getState, set, tuiDebug, pending } = bag;
  const tailStore = streamingTailStore(bag);

  async function runTurn(userText, options = {}) {
    const turn = beginTurn(bag, options);
    const isCurrentTurn = () => !flags.disposed && flags.leadTurnEpoch === turn.epoch;
    flags.activePromptRestore = promptRestoreFor(promptDisplayText(userText, options), options, turn.submittedIds);
    set({
      busy: true,
      lastTurn: null,
      spinner: {
        active: true,
        verb: pickVerb(turn.index),
        startedAt: turn.startedAt,
        responseLength: 0,
        inputTokens: 0,
        outputTokens: 0,
        mode: 'requesting',
      },
    });
    try {
      await bag.onGoalTurnStarted?.();
    } catch {}
    tuiDebug(`runTurn start turn=${turn.index} pending=${pending.length}`);
    markTranscriptStart(turn, getState().items);
    const cards = createTurnToolCards({ ...bag, isCurrentTurn });
    flags.flushDeferredBeforeImmediatePush = () => cards.deferredCards.flushAll();
    const stream = createTurnStream({
      getState,
      set,
      nextId: bag.nextId,
      ...tailStore,
      isCurrentTurn,
      transcriptMeta: turn.transcriptMeta,
      routeMeta: turn.routeMeta,
      sealToolBlock: cards.aggregates.clearAggregateContinuation,
    });
    const stopLiveTail = startLiveTail(cards);
    const ctx = {
      ...bag,
      bag,
      turn,
      stream,
      cards,
      options,
      isCurrentTurn,
      markPromptCommitted: () => commitPromptRestore(flags, turn),
    };
    try {
      const { result, session } = await runtime.ask(userText, {
        id: turn.submittedIds[0],
        submittedAt: options.submittedAt,
        promptSource: options.promptSource,
        retryFailedTurn: options.retryFailedTurn === true,
        transcriptMeta: turn.transcriptMeta,
        context: options.context || null,
        ...turnHandlers(ctx),
        ...toolHandlers(ctx),
        ...streamHandlers(ctx),
      });
      if (!isCurrentTurn()) turn.cancelled = true;
      else completeTurn(ctx, result, session);
    } catch (error) {
      if (!isCurrentTurn()) turn.cancelled = true;
      else failTurn(ctx, error);
    } finally {
      closeTurn(ctx, stopLiveTail);
    }
    return settleTurn(ctx);
  }

  return runTurn;
}
