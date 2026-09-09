/**
 * src/tui/session/turn.mjs - lead TUI turn session runtime (createRunTurn). Extracted from session-local.mjs.
 */
import { aggregateToolCategoryEntries, classifyToolCategory, isTaskWaitToolCall } from '../../runtime/shared/tool-surface.mjs';
import { applyUsageDelta } from './session-stats.mjs';
import { pickVerb, pickDoneVerb, compactEventLabel, compactEventDetail } from './labels.mjs';
import { toolErrorDisplay } from './tool-result-text.mjs';
import { errText, isCancelLikeError } from '../../runtime/shared/err-text.mjs';
import { preserveGoalStateAfterTurn } from './goal-turn-state.mjs';
export { preserveGoalStateAfterTurn } from './goal-turn-state.mjs';
import { safeErrorDetails } from '../../runtime/shared/error-presentation.mjs';
import { toolCallId, toolResultCallId, toolCallName, toolCallArgs } from './tool-call-fields.mjs';
import { promptDisplayText, STEERING_SUPPRESSED_DISPLAY } from './queue-helpers.mjs';
import { TUI_FRAME_MS, yieldToRenderer } from './render-timing.mjs';
import { aggregateBucketForCategory } from './tool-result-status.mjs';
import { isTranscriptHiddenControlToolName, isTranscriptSkillToolName } from '../../runtime/shared/tool-execution-contract.mjs';
import { createDeferredCardRegistry } from './turn-deferred-cards.mjs';
import { createAggregateCardTracker } from './turn-aggregate-cards.mjs';

export const STREAM_BATCH_INTERVAL_MS = TUI_FRAME_MS;

/**
 * `builtinSkillNames` (optional Set) lets a live turn hide a built-in skill
 * load before its result exists; restore paths use the result stub instead
 * (isTranscriptHiddenToolItem).
 */
export function transcriptToolCallDisplayMode(name, args, builtinSkillNames = null) {
  if (isTaskWaitToolCall(name, args)) return 'task-wait';
  if (isTranscriptHiddenControlToolName(name)) return 'hidden-control';
  if (builtinSkillNames?.size && isTranscriptSkillToolName(name)) {
    const skill = String(args?.name || args?.skill || args?.skill_name || '').trim().toLowerCase();
    if (skill && builtinSkillNames.has(skill)) return 'hidden-control';
  }
  return 'visible';
}

// Skill source lookup is a status read (a promise over the daemon wire), so
// it runs only when the batch actually carries a skill call.
async function builtinSkillNamesFor(runtime, calls) {
  if (!calls.some((call) => isTranscriptSkillToolName(toolCallName(call)))) return null;
  try {
    const status = await Promise.resolve(runtime?.skillsStatus?.());
    const skills = Array.isArray(status?.skills) ? status.skills : [];
    return new Set(skills
      .filter((skill) => skill?.source === 'builtin')
      .map((skill) => String(skill?.name || '').trim().toLowerCase())
      .filter(Boolean));
  } catch {
    return null;
  }
}

function isUsageLimitError(error) {
  if (!error) return false;
  const status = Number(error?.httpStatus || error?.status || error?.response?.status || 0);
  if (error?.providerQuota === true || error?.quotaExceeded === true || status === 429) return true;
  const text = String(error?.message || error);
  return /\brate[_ -]?limit\b|\bquota\b|too many requests|resource exhausted|insufficient_quota|quota_exceeded/i.test(text);
}

export function createRunTurn(bag) {
  const {
    runtime, nextId, tuiDebug, flags, pending, itemIndexById, getState, set, flushEmit, flushEmitImmediate, pushItem, appendItems, patchItem, replaceItems, updateStreamingTail: updateStreamingTailFromStore, settleStreamingTail: settleStreamingTailFromStore, clearStreamingTail: clearStreamingTailFromStore, pushNotice, pushUserOrSyntheticItem, markToolCallActive, markToolCallDone, clearActiveToolSummary, agentStatusState, routeState, transcriptRouteMetadata, syncContextStats, denyAllToolApprovals, requestToolApproval, patchToolCardResult, flushToolResults, flushDeferredExecutionPendingResumeKick, drainPendingSteering,
  } = bag;
  // Small fallbacks keep isolated createRunTurn harnesses source-compatible;
  // the real session runtime supplies atomic implementations that also maintain revision.
  const updateStreamingTail = updateStreamingTailFromStore || ((id, patch = {}, extra = {}) => {
    set({
      streamingTail: { ...(getState().streamingTail || {}), ...patch, kind: 'assistant', id, streaming: true },
      ...extra,
    });
    return true;
  });
  const settleStreamingTail = settleStreamingTailFromStore || ((id, patch = {}) => {
    const tail = getState().streamingTail;
    if (!tail || tail.id !== id) return false;
    pushItem({ ...tail, ...patch, kind: 'assistant', id, streaming: false });
    set({ streamingTail: null });
    return true;
  });
  const clearStreamingTail = clearStreamingTailFromStore || ((id = null) => {
    if (id == null || getState().streamingTail?.id === id) set({ streamingTail: null });
    return true;
  });

    async function runTurn(userText, options = {}) {
    const turnIndex = getState().stats.turns || 0;
    const startedAt = Date.now();
    const completionVerb = pickDoneVerb(turnIndex);
    const baseTranscriptMeta = {
      ...(flags.pendingTranscriptMeta
        || transcriptRouteMetadata?.(startedAt)
        || { at: startedAt }),
      ...(options.transcriptMeta && typeof options.transcriptMeta === 'object'
        ? options.transcriptMeta
        : {}),
    };
    const turnTranscriptMeta = { ...baseTranscriptMeta, completionVerb };
    flags.pendingTranscriptMeta = null;
    const { at: _userItemAt, ...turnRouteMeta } = turnTranscriptMeta;
    // Per-turn epoch prevents a disposed/replaced surface from publishing a
    // terminal snapshot after another turn has become the visible owner.
    const turnEpoch = ++flags.leadTurnEpoch;
    const isCurrentTurn = () => !flags.disposed && flags.leadTurnEpoch === turnEpoch;
    const inputBaseline = getState().stats.inputTokens;
    const outputBaseline = getState().stats.outputTokens;
    const submittedIds = Array.isArray(options.submittedIds) ? options.submittedIds : [];
    const displayText = promptDisplayText(userText, options);
    let promptCommittedCallbackCalled = false;
    flags.activePromptRestore = {
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
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, responseLength: 0, inputTokens: 0, outputTokens: 0, mode: 'requesting' } });
    try { await bag.onGoalTurnStarted?.(); } catch {}

    let assistantText = '';
    let currentAssistantId = null;

    tuiDebug(`runTurn start turn=${turnIndex} pending=${pending.length}`);
    const markTurnProgress = () => isCurrentTurn();
    let currentAssistantText = '';
    // Segments sealed as their own assistant item(s) this turn via
    // commitAssistantSegment (e.g. a tool preamble, then a no-newline tail
    // committed by onSteerMessage before an injected steering row). Kept as an
    // ordered list — NOT one concatenated string — so finalization can strip
    // each committed segment out of the provider's final content individually.
    // A single concatenation breaks when the provider omits an earlier segment
    // (e.g. a tool preamble) from result.content: the combined prefix no longer
    // matches and the tail would duplicate after the steering row.
    const committedSegments = [];
    let thinkingText = '';
    let thinkingStartedAt = 0;
    let thinkingSegmentStartedAt = 0;
    let accumulatedThinkingMs = 0;
    let cancelled = false;
    let failed = false;
    let turnFailureDetail = '';
    let turnFailureDiagnostic = '';
    let turnFailureUsageLimited = false;
    let askResult = null;
    let turnFinishedNormally = false;
    let transcriptCompactedThisTurn = false;
    const itemsAtTurnStart = getState().items.length;
    const submittedIdSet = new Set(submittedIds.filter((id) => id != null));
    const firstSubmittedIndex = getState().items.findIndex((item) => submittedIdSet.has(item?.id));
    // The submitted user row is pushed immediately before runTurn. Keep it and
    // everything produced after it if compaction succeeds mid-turn; dropping all
    // items would invalidate live tool-card ids and the streaming assistant tail.
    let currentTurnItemsStart = firstSubmittedIndex >= 0 ? firstSubmittedIndex : itemsAtTurnStart;
    const cardByCallId = new Map();
    const toolCards = [];
    const toolGroups = new Map();
    const resultsDone = new Set();
    // Passive task waits and internal Goal/load controls are runtime flow, not
    // user-visible work. Keep ids only long enough to suppress result cards.
    const suppressedTranscriptCallIds = new Set();
    const activeTaskWaitCallIds = new Set();
    const refreshTaskWaitSpinner = () => {
      if (!getState().spinner) return;
      set({
        spinner: {
          ...getState().spinner,
          mode: activeTaskWaitCallIds.size > 0 ? 'task-wait' : 'tool-use',
        },
      });
    };
    // ── Live shell-output tail → running tool card ─────────────────────────
    // 1 s poll of orchestrator liveness while this turn runs. When exactly one
    // standalone (non-aggregate) card is unresolved and the runtime reports a
    // fresh toolOutputTail for the running tool, patch it onto the card as
    // `liveOutput` so transcript consumers (desktop) can render live command
    // output. The result patch clears the field; timer dies with the turn.
    let liveTailTimer = null;
    let lastLiveTailPatched = '';
    const clearLiveTailTimer = () => {
      if (liveTailTimer) { clearInterval(liveTailTimer); liveTailTimer = null; }
    };
    liveTailTimer = setInterval(() => {
      if (!isCurrentTurn()) { clearLiveTailTimer(); return; }
      let liveness = null;
      try { liveness = runtime.getTurnLiveness?.(); } catch { return; }
      if (!liveness || liveness.stage !== 'tool_running') return;
      const tail = typeof liveness.toolOutputTail === 'string' ? liveness.toolOutputTail : '';
      if (!tail || tail === lastLiveTailPatched) return;
      const running = toolCards.filter((c) => !c.done && !c.aggregate);
      if (running.length !== 1) return;
      const card = running[0];
      // Real output proves the tool is genuinely running — surface the card
      // even if its deferred-display timer has not fired yet.
      card.ensureVisible?.();
      lastLiveTailPatched = tail;
      patchItem(card.itemId, { liveOutput: tail });
    }, 1000);
    liveTailTimer.unref?.();
    // Streaming providers can deliver eager onToolResult before onToolCall registers
    // cards (send() still in flight). Hold those by callId until the batch lands.
    const earlyResultBuffer = new Map();
    let providerToolBatch = 0;

    // ── Ordered tool-card push ────────────────────────────────────────────────
    // Cards enter the transcript in call order once their headers are ready
    // (see turn-deferred-cards.mjs).
    const deferredCards = createDeferredCardRegistry({
      isCurrentTurn, flags, pushItem, appendItems, getState, set, itemIndexById,
    });
    const { appendItemsBatch } = deferredCards;
    flags.flushDeferredBeforeImmediatePush = () => deferredCards.flushAll();
    // Consecutive same-bucket calls merge into one aggregate card (see
    // turn-aggregate-cards.mjs).
    const aggregates = createAggregateCardTracker({
      toolCards, cardByCallId, nextId, getState, set, patchItem, itemIndexById, markToolCallDone,
      registerDeferredAggregate: deferredCards.registerAggregate,
    });
    const { finalizeToolHeaders, clearAggregateContinuation } = aggregates;

    const markPromptCommitted = () => {
      if (flags.activePromptRestore) {
        if (!promptCommittedCallbackCalled && typeof flags.activePromptRestore.onCommitted === 'function') {
          promptCommittedCallbackCalled = true;
          try { flags.activePromptRestore.onCommitted(); } catch {}
        }
        flags.activePromptRestore.restorable = false;
        flags.activePromptRestore.committed = true;
        flags.activePromptRestore.requeueEntries = [];
        flags.activePromptRestore.pastedImages = null;
        flags.activePromptRestore.pastedTexts = null;
      }
    };

    const ensureAssistant = (initialText = '') => {
      if (!currentAssistantId) {
        currentAssistantId = nextId();
        const assistantAt = Number.isFinite(Number(turnTranscriptMeta.assistantAt))
          && Number(turnTranscriptMeta.assistantAt) > 0
          ? Number(turnTranscriptMeta.assistantAt)
          : Date.now();
        turnTranscriptMeta.assistantAt = assistantAt;
        // Do NOT reset currentAssistantText here. The first onTextDelta has
        // already accumulated the opening chunk before this batched flush runs;
        // wiping it dropped the leading characters and forced a later set() to
        // re-add them. Segment resets are owned by closeAssistantSegment().
        // Seed the new row with the already-visible text so the ● gutter and the
        // first body line appear in the SAME set()/emit() — no empty "●-only"
        // row that scrolls once on its own and again when the body lands.
        updateStreamingTail(currentAssistantId, { text: String(initialText || ''), at: assistantAt, ...turnRouteMeta });
      }
      return currentAssistantId;
    };

    const closeAssistantSegment = () => {
      currentAssistantId = null;
      currentAssistantText = '';
      // Reset incremental-flush getState() so the next segment rescans from scratch.
      _streamScanLen = 0;
      _lastNewlineIdx = -1;
      _emittedNewlineIdx = -2;
      _emittedVisibleText = '';
    };

    const commitAssistantSegment = ({ sealToolBlock = false } = {}) => {
      const text = currentAssistantText || '';
      if (!text.trim()) {
        closeAssistantSegment();
        return false;
      }
      if (sealToolBlock) clearAggregateContinuation();
      const id = currentAssistantId || ensureAssistant(text);
      settleStreamingTail(id, { text });
      committedSegments.push(text);
      closeAssistantSegment();
      return true;
    };

    const startThinkingSegment = () => {
      const now = Date.now();
      if (!thinkingStartedAt) thinkingStartedAt = now;
      if (!thinkingSegmentStartedAt) thinkingSegmentStartedAt = now;
      return now;
    };

    const closeThinkingSegment = () => {
      if (!thinkingSegmentStartedAt) return;
      const now = Date.now();
      accumulatedThinkingMs += Math.max(0, now - thinkingSegmentStartedAt);
      thinkingSegmentStartedAt = 0;
      return now;
    };

    // --- Streaming-delta batcher ---
    // onTextDelta and onReasoningDelta fire on every tiny chunk (often <10 chars).
    // Each call previously called set() → emit() → full React reconcile. We
    // batch accumulated text and flush at most once per STREAM_BATCH_INTERVAL_MS.
    // A forced flush happens before any tool call,
    // finalization, or error so those code paths see the correct text getState().
    // Share Ink's exact 120fps cadence with the frame-batched store. A separate
    // 16ms timer left every other terminal frame idle, so completed script lines
    // accumulated and then climbed into view in coarse two-step chunks.
    let _batchTimer = null;
    let _pendingTextFlush = false;   // true when a text/spinner update is queued
    let _pendingThinkFlush = false;  // true when a thinking update is queued
    let _pendingThinkingLastEndedAt = 0;
    let compactingActive = false;
    // Incremental streaming-flush getState(): avoids rescanning the full accumulated
    // assistant text (lastIndexOf) and re-finding the row index on every flush.
    let _streamScanLen = 0;        // chars of currentAssistantText already scanned for '\n'
    let _lastNewlineIdx = -1;      // offset of the last completed-line '\n' found so far
    let _emittedNewlineIdx = -2;   // newline offset backing _emittedVisibleText (-2 forces first compute)
    let _emittedVisibleText = '';  // cached visible slice for the current newline offset
    // Session runtime-local streaming scalars. Neither responseLength nor thinkingText is
    // rendered per-token by any consumer: App reads getState().thinking only as a
    // boolean (App.jsx `!!(getState().thinking || liveSpinner?.thinking)`) and the
    // Spinner takes outputTokens, not responseLength. So we keep these growing
    // values in session runtime-local vars and publish to the store only on a visible
    // transition (thinking on↔off), a completed visible text line, tool/usage
    // updates, or finalization — not on every 8ms streaming flush.
    let _publishedThinkingActive = false; // last thinking boolean pushed to store
    // responseLength is only consumed at finalize as an outputTokens fallback
    // (Math.round(responseLength/4)); we refresh getState().spinner.responseLength on
    // visible-line flush and finalize so that fallback stays valid.

    const flushStreamBatch = () => {
      if (_batchTimer !== null) {
        clearTimeout(_batchTimer);
        _batchTimer = null;
      }
      if (!isCurrentTurn()) {
        _pendingTextFlush = false;
        _pendingThinkFlush = false;
        _pendingThinkingLastEndedAt = 0;
        return;
      }
      if (_pendingTextFlush) {
        _pendingTextFlush = false;
        // Show only COMPLETED lines while streaming. The in-progress trailing
        // line stays hidden until its '\n' arrives, so the visible text never
  // grows a glyph at a time (no "Wh"→pause→"What happened…" partial reveal, no
        // CJK-width reflow jitter). The final non-streaming patch
        // (streaming:false) always carries the full text, so the tail line that
        // never got a newline still lands once at finalize.
        // Incrementally track the last completed-line '\n' offset instead of
        // rescanning the whole accumulated text every flush. Each char is
        // examined once across the stream (amortized O(n) total, not O(n) per
        // flush); when the newline offset hasn't advanced the visible text is
        // byte-identical to the last flush, so the slice below is skipped and
        // reused. Reveal semantics are unchanged: still only completed lines.
        const textLen = currentAssistantText.length;
        if (textLen < _streamScanLen) { _streamScanLen = 0; _lastNewlineIdx = -1; }
        for (let i = _streamScanLen; i < textLen; i++) {
          if (currentAssistantText.charCodeAt(i) === 10) _lastNewlineIdx = i;
        }
        _streamScanLen = textLen;
        let streamingVisibleText;
        if (_lastNewlineIdx === _emittedNewlineIdx) {
          streamingVisibleText = _emittedVisibleText;
        } else {
          streamingVisibleText = _lastNewlineIdx >= 0
            ? currentAssistantText.slice(0, _lastNewlineIdx + 1)
            : '';
          _emittedNewlineIdx = _lastNewlineIdx;
          _emittedVisibleText = streamingVisibleText;
        }
        const patch = {};
        // Do NOT create the assistant row (and scroll the transcript) before
        // there is a completed line with VISIBLE content to show. Until the
        // first '\n' the only pending getState() is the spinner; the row appears
        // together with its first visible line, so no empty "●-only" row
        // flashes/scrolls ahead of text. `.trim()` also guards the
        // whitespace-only case: a response that opens with leading newlines
        // ("\n\n# …") completes a blank line first, whose estimated height
        // still reserves rows and scrolls the transcript, but Markdown trims
        // the body to nothing — so the scroll advances onto an empty band for
        // a few seconds until a non-blank line lands. Don't create the row
        // until there is real content to paint.
        if (currentAssistantId || streamingVisibleText.trim()) {
          const id = ensureAssistant(streamingVisibleText);
          const current = getState().streamingTail;
          if (!current || current.id !== id || !Object.is(current.text, streamingVisibleText)) {
            patch.streamingTail = {
              ...(current || {}),
              kind: 'assistant',
              id,
              text: streamingVisibleText,
              streaming: true,
              at: current?.at || Date.now(),
              ...turnRouteMeta,
            };
          }
        }
        // Only touch the spinner when there is a real reason: a visible-line
        // change (patch.items set above), a thinking→responding transition, or a
        // pending thinking end timestamp. Refresh responseLength here so the
        // finalize outputTokens fallback stays valid without a per-token push.
        const responseLengthVal = assistantText.length + thinkingText.length;
        const visibleLineChanged = patch.streamingTail !== undefined;
        const thinkingTransition = _publishedThinkingActive === true; // was thinking, now responding
        if (getState().spinner && (visibleLineChanged || thinkingTransition || _pendingThinkingLastEndedAt)) {
          patch.spinner = { ...getState().spinner, responseLength: responseLengthVal, thinking: false, thinkingLastEndedAt: _pendingThinkingLastEndedAt || getState().spinner.thinkingLastEndedAt, mode: compactingActive ? 'compacting' : 'responding' };
          _publishedThinkingActive = false;
        }
        if (patch.streamingTail) {
          const { streamingTail, ...extra } = patch;
          updateStreamingTail(streamingTail.id, streamingTail, extra);
        } else if (Object.keys(patch).length > 0) {
          set(patch);
        }
        _pendingThinkingLastEndedAt = 0;
      }
      if (_pendingThinkFlush) {
        _pendingThinkFlush = false;
        // App only consumes getState().thinking as a boolean and the Spinner only
        // reads the thinking flag + timing anchors — none of them render the
        // growing thinkingText. So publish the thinking boolean only on the
        // OFF→ON transition (or when compacting toggles the flag), not on every
        // 8ms reasoning chunk. The full thinkingText stays session runtime-local and is
        // emitted at finalize via the normal spinner/thinking teardown.
        const nextThinkingActive = !compactingActive;
        // Skip the push when the published thinking boolean is unchanged: neither
        // the growing thinkingText nor responseLength is rendered per-token, and
        // the Spinner derives its live elapsed from the (already-published)
        // thinkingSegmentStartedAt anchor. Applies to both thinking and
        // compacting steady getState().
        if (nextThinkingActive === _publishedThinkingActive) {
          // no-op: boolean unchanged
        } else {
          const responseLengthVal = assistantText.length + thinkingText.length;
          const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
          // getState().thinking stays a truthy sentinel while active; consumers read it
          // as a boolean. Keep the value stable (thinkingText) so a late consumer
          // still sees real text, but only push on transition.
          const patch = { thinking: compactingActive ? null : thinkingText };
          if (getState().spinner) {
            patch.spinner = compactingActive
              ? { ...getState().spinner, responseLength: responseLengthVal, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: getState().spinner.thinkingLastEndedAt || 0, mode: 'compacting' }
              : { ...getState().spinner, responseLength: responseLengthVal, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' };
          }
          set(patch);
          _publishedThinkingActive = nextThinkingActive;
        }
      }
    };

    const scheduleStreamFlush = () => {
      if (_batchTimer !== null) return; // already scheduled; do not re-arm
      _batchTimer = setTimeout(flushStreamBatch, STREAM_BATCH_INTERVAL_MS);
      if (_batchTimer?.unref) _batchTimer.unref(); // don't prevent process exit
    };

    const deliverToolResultMessage = (message) => {
      const suppressedCallId = toolResultCallId(message);
      if (suppressedCallId && suppressedTranscriptCallIds.has(suppressedCallId)) {
        activeTaskWaitCallIds.delete(suppressedCallId);
        refreshTaskWaitSpinner();
        return;
      }
      if (message?.__earlyNotify === true) {
        const earlyCallId = toolResultCallId(message);
        if (earlyCallId) {
          aggregates.markToolCardCompletedState(earlyCallId, message);
        }
        return;
      }
      flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
    };

    try {
      const { result, session } = await runtime.ask(userText, {
        id: submittedIds[0],
        submittedAt: options.submittedAt,
        transcriptMeta: turnTranscriptMeta,
        context: options.context || null,
        drainSteering: (_sessionId, drainOptions) => (isCurrentTurn() ? drainPendingSteering(drainOptions) : []),
        onStreamDelta: () => {
          markTurnProgress('stream-delta');
        },
        onSteerMessage: (text, steeringMeta = {}) => {
          if (!markTurnProgress('steer-message')) return;
          // A suppressed live-completion twin is model-visible only; its
          // Response card was already pushed at delivery time. Skip the
          // duplicate transcript item (progress is still marked above since
          // the content WAS injected into the model turn).
          if (text === STEERING_SUPPRESSED_DISPLAY) return;
          // Steering can be injected after a terminal no-tool response has
          // already streamed but before runTurn finalizes. Seal the current
          // assistant segment first so the steered user turn and the next
          // assistant response do not get visually merged into one bubble.
          flushStreamBatch();
          // Commit any pending assistant segment — including a streamed tail
          // that never got a trailing '\n' (no row/currentAssistantId created
          // yet). Using the shared segment-commit helper ensures that tail is
          // materialized as an assistant item instead of being dropped when a
          // steering/agent-completion injection races turn finalization.
          commitAssistantSegment({ sealToolBlock: true });
          assistantText = '';
          const value = String(text || '').trim();
          if (value) {
            // Any non-tool transcript item is a block boundary: seal the
            // aggregate continuation (not just finalize headers) so a later
            // same-category tool call opens a fresh card instead of reusing
            // one whose count would then change ABOVE this steered user item.
            clearAggregateContinuation();
            const steeringIds = Array.isArray(steeringMeta?.ids)
              ? steeringMeta.ids.filter((id) => id !== undefined && id !== null)
              : [];
            pushUserOrSyntheticItem(
              value,
              steeringIds[0],
              'injected',
              {
                // Queue mode + execution provenance: a task notification is
                // rendered as a tool card, never as an injected user bubble.
                ...(steeringMeta?.mode === 'task-notification' ? { mode: 'task-notification' } : {}),
                ...(steeringMeta?.execution && typeof steeringMeta.execution === 'object'
                  ? { execution: steeringMeta.execution }
                  : {}),
                ...(Array.isArray(steeringMeta?.images) && steeringMeta.images.length
                  ? { images: steeringMeta.images }
                  : {}),
                ...(typeof steeringMeta?.transcriptMeta?.sender === 'string'
                  && steeringMeta.transcriptMeta.sender
                  ? { sender: steeringMeta.transcriptMeta.sender }
                  : {}),
              },
            );
          }
        },
        onToolCall: async (_iter, calls) => {
          if (!markTurnProgress('tool-call')) return;
          markPromptCommitted();
          // Always flush any buffered mid-turn assistant text before the tool
          // card appears. Without this, when neither a thinking panel nor a
          // spinner is active the buffered text was dropped by the following
          // closeAssistantSegment(), so the message above the tool card vanished.
          flushStreamBatch();
          const batchCalls = (calls || []).filter(Boolean);
          if (batchCalls.length === 0) return;
          const displayCalls = [];
          const builtinSkillNames = await builtinSkillNamesFor(runtime, batchCalls);
          for (const call of batchCalls) {
            const name = toolCallName(call);
            const args = toolCallArgs(call);
            const displayMode = transcriptToolCallDisplayMode(name, args, builtinSkillNames);
            if (displayMode === 'visible') {
              displayCalls.push(call);
              continue;
            }
            const callId = toolCallId(call);
            // Tool protocol calls normally always carry ids. If a malformed
            // provider omits one, keep the ordinary card so its result cannot
            // strand an unaddressable hidden spinner.
            if (!callId) {
              displayCalls.push(call);
              continue;
            }
            suppressedTranscriptCallIds.add(callId);
            if (displayMode === 'task-wait') activeTaskWaitCallIds.add(callId);
          }
          if (thinkingText && getState().thinking) {
            const thinkingLastEndedAt = closeThinkingSegment();
            set({ thinking: null, spinner: getState().spinner ? { ...getState().spinner, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingLastEndedAt, mode: activeTaskWaitCallIds.size > 0 ? 'task-wait' : 'tool-use' } : getState().spinner });
            _publishedThinkingActive = false;
          } else if (getState().spinner) {
            refreshTaskWaitSpinner();
          }
          const agentBatch = ++providerToolBatch;
          commitAssistantSegment({ sealToolBlock: true });

          const touchedAggregates = new Set();
          // [jitter fix] Last standalone (Agent) card in this batch to reserve a
          // row for. Flushed AFTER the syncAggregateHeader loop so any earlier-seq
          // aggregate it would flush-through already has its pendingSpec built.
          let standaloneReserve = null;
          // Shell-after-edit tracking: a shell call that follows an edit call
          // in the SAME provider batch is its verification — the Shell card
          // header renders Verifying/Verified instead of Running/Ran.
          let sawEditInBatch = false;
          for (let i = 0; i < displayCalls.length; i++) {
            const c = displayCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            // Category drives the aggregate bucket so only same-category calls
            // merge into one card; classify first, then bucket by it.
            const category = classifyToolCategory(name, args);
            const shellAfterEdit = category === 'Shell' && sawEditInBatch;
            if (category === 'Patch' && args?.dry_run !== true) sawEditInBatch = true;
            // Agent actions aggregate only within this provider-emitted batch.
            // They stay outbound category cards; asynchronous inbound Responses
            // are separately tailed by the notification feed and never mix here.
            const bucket = aggregateBucketForCategory(category, { agentBatch });
            const callId = toolCallId(c);
            const callKey = callId || `__tool_${toolCards.length}_${i}`;
            // The old App scan counted multi-pattern calls via category work
            // units, not a flat 1. Derive the same
            // count here so the incremental web-search summary matches.
            const categoryEntries = aggregateToolCategoryEntries(name, args, category);
            const activeCount = categoryEntries.reduce((total, entry) => total + Number(entry.count || 1), 0);
            // Track web-search calls as active for the incremental prompt-
            // line summary; cleared when their result lands or the turn ends.
            markToolCallActive(callKey, category, activeCount, Date.now());

            if (!bucket) {
              const itemId = nextId();
              // Defer the visible push: hold the spec and only enter the
              // transcript when the real header/detail will paint (delay
              // elapsed) or its result lands first. Avoids reserving blank
              // placeholder height that scrolls the body ahead of the glyphs.
              const card = {
                itemId,
                callId: callKey,
                done: false,
                pushed: false,
                spec: {
                  kind: 'tool',
                  id: itemId,
                  name,
                  args,
                  result: null,
                  isError: false,
                  expanded: false,
                  headerFinalized: false,
                  count: 1,
                  completedCount: 0,
                  startedAt: Date.now(),
                },
              };
              deferredCards.registerCard(card);
              if (callId) {
                cardByCallId.set(callId, card);
              }
              toolCards.push(card);
              // [jitter fix] Immediate row-reserve is deferred to after the
              // syncAggregateHeader loop below (see standaloneReserve): calling
              // ensureVisible() here would flush every earlier-seq deferred
              // entry — including an aggregate whose pendingSpec syncAggregateHeader
              // hasn't built yet — marking it pushed without inserting (lost/
              // out-of-order card). Record it and flush once headers exist.
              standaloneReserve = card;
              // A standalone card (Agent) breaks the consecutive run too: a
              // later same-bucket call must open a fresh card BELOW it, not
              // merge into an aggregate above it.
              aggregates.sealTail();
              continue;
            }

            const aggregateCard = aggregates.ensureAggregateCard(bucket);
            if (shellAfterEdit) aggregateCard.verifyShell = true;
            for (const categoryEntry of categoryEntries) {
              if (!aggregateCard.categories.has(categoryEntry.key)) aggregateCard.categoryOrder.push(categoryEntry.key);
              const prevCategory = aggregateCard.categories.get(categoryEntry.key);
              aggregateCard.categories.set(categoryEntry.key, {
                ...categoryEntry,
                count: Number(prevCategory?.count || 0) + Number(categoryEntry.count || 1),
              });
            }
            aggregateCard.calls.set(callKey, { callId: callKey, name, args, category, summary: null, summarySeq: null, isError: false, isCallError: false, isExitError: false, exitCode: null, resultText: null, rawResultText: null, resolved: false, completedEarly: false, startedAt: Date.now(), completedAt: null });
            touchedAggregates.add(aggregateCard);
            const card = { itemId: aggregateCard.itemId, callId: callKey, done: false, aggregate: aggregateCard };
            if (callId) {
              cardByCallId.set(callId, card);
            }
            toolCards.push(card);
          }

          for (const aggregateCard of touchedAggregates) {
            aggregates.syncAggregateHeader(aggregateCard);
          }
          // [jitter fix] Now that every touched aggregate has its pendingSpec,
          // every entry is push-ready. Flush through the standalone and final
          // aggregate entries so the complete batch becomes visible before this
          // callback yields, while preserving creation order.
          standaloneReserve?.ensureVisible?.();
          const lastTouchedAggregate = [...touchedAggregates].at(-1) || null;
          lastTouchedAggregate?.ensureVisible?.();
          for (const [bufferedCallId, bufferedMessage] of earlyResultBuffer) {
            if (suppressedTranscriptCallIds.has(bufferedCallId)) {
              deliverToolResultMessage(bufferedMessage);
              earlyResultBuffer.delete(bufferedCallId);
              continue;
            }
            if (!cardByCallId.has(bufferedCallId)) continue;
            deliverToolResultMessage(bufferedMessage);
            earlyResultBuffer.delete(bufferedCallId);
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          if (!markTurnProgress('tool-result')) return;
          try { options.onToolResult?.(message); } catch {}
          const callId = toolResultCallId(message);
          if (callId && !cardByCallId.has(callId) && !resultsDone.has(callId)) {
            earlyResultBuffer.set(callId, message);
            return;
          }
          deliverToolResultMessage(message);
        },
        onToolPhaseCompleted: () => {
          if (!markTurnProgress('tool-phase-completed')) return;
          const spinner = getState().spinner;
          if (!spinner || spinner.mode === 'requesting') return;
          // A completed tool batch is not the end of the turn. Publish the
          // provider-resume phase immediately instead of leaving the last tool
          // state parked on screen until the next model event arrives.
          set({ spinner: { ...spinner, mode: 'requesting' } });
        },
        onToolApproval: async (request) => {
          if (!markTurnProgress('tool-approval')) return { approved: false, reason: 'turn no longer active' };
          markPromptCommitted();
          flushStreamBatch();
          if (getState().spinner) set({ spinner: { ...getState().spinner, mode: 'tool-approval' } });
          const approval = await requestToolApproval(request);
          if (!isCurrentTurn()) return { approved: false, reason: 'turn no longer active' };
          return approval;
        },
        // Pre-send context readout, emitted by the loop at the exact point the
        // auto-compact decision is made. It carries the decision's own
        // numerator, so the gauge stops lagging a tool batch behind and reads
        // 100% on the same frame compaction starts (user: 좀 남아 보였는데 바로
        // 컴팩트). No transcript rescan happens here — the loop already
        // computed this number.
        onContextPressure: (info) => {
          if (!markTurnProgress('context-pressure')) return;
          // This direct pressure publication exists only to make the gauge hit
          // 100% on the exact frame auto-compaction starts. Routine pre-send
          // checks stay on the canonical contextStatus path instead of
          // competing with its provider-aligned value.
          if (info?.willCompact !== true) return;
          const used = Math.max(0, Number(info?.usedTokens) || 0);
          if (!used) return;
          // Pressure drives compaction, not the measured-input display.
          syncContextStats({ allowEstimated: true });
          set({ stats: { ...getState().stats } });
        },
        onCompactEvent: (event) => {
          if (!markTurnProgress('compact-event')) return;
          flushStreamBatch();
          // Non-tool transcript item — same block-boundary rule as the
          // steered user item above: seal any live aggregate first so a
          // later same-category tool call doesn't reuse a card whose count
          // would then change above this statusdone item.
          clearAggregateContinuation();
          const compactStatus = String(event?.status || '').toLowerCase();
          const compactChanged = !['failed', 'skipped', 'no_change'].includes(compactStatus);
          if (compactChanged) {
            const currentTurnItems = getState().items.slice(currentTurnItemsStart);
            set({ items: replaceItems(currentTurnItems, { preserveStreamingTail: true }) });
            currentTurnItemsStart = 0;
            transcriptCompactedThisTurn = true;
          }
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: compactEventLabel(event),
            detail: compactEventDetail(event),
          });
          // Compaction itself remains owned by the pre-provider-send pass.
          // This event only refreshes the gauge from the already-mutated
          // transcript before another render can show stale pressure.
          syncContextStats({
            allowEstimated: true,
            invalidateExact: compactChanged,
          });
          // syncContextStats only STAGES its patch on the draft (context-state
          // mjs stages through updateState); publication is the caller's, and
          // every other compact path already follows with this exact set. The
          // auto path did not, so the post-compact gauge reached React only if
          // some later mutation happened to carry it — the manual path
          // repainted immediately while auto looked stuck on the pre-compact
          // number (user: 오토 컴팩트 이후에 컨텍스트 원형바가 동기화가 안됨).
          set({ ...routeState(), stats: { ...getState().stats } });
        },
        onStageChange: async (stage, detail = null) => {
          if (!markTurnProgress(`stage:${String(stage || '')}`)) return;
          if (!getState().spinner) return;
          const value = String(stage || '');
          if (value === 'compacting') {
            compactingActive = true;
            const thinkingLastEndedAt = closeThinkingSegment();
            _pendingThinkFlush = false;
            _publishedThinkingActive = false; // compacting cleared the thinking flag
            set({
              thinking: null,
              spinner: {
                ...getState().spinner,
                thinking: false,
                thinkingSegmentStartedAt: 0,
                thinkingAccumulatedMs: accumulatedThinkingMs,
                thinkingLastEndedAt: thinkingLastEndedAt || getState().spinner.thinkingLastEndedAt || 0,
                mode: 'compacting',
              },
            });
            await yieldToRenderer();
            return;
          }
          if (value === 'reconnecting') {
            compactingActive = false;
            const retryVerb = String(detail?.message || 'Reconnecting');
            set({ spinner: { ...getState().spinner, mode: 'reconnecting', verb: retryVerb } });
            await yieldToRenderer();
            return;
          }
          if (value === 'requesting' || value === 'streaming') compactingActive = false;
          const mode = value === 'requesting'
            ? 'requesting'
            : value === 'streaming'
              ? (getState().spinner.thinking ? 'thinking' : 'responding')
              : null;
          if (!mode || getState().spinner.mode === mode) return;
          set({ spinner: { ...getState().spinner, mode } });
        },
        onTextDelta: (chunk) => {
          const textChunk = String(chunk ?? '');
          if (!textChunk) return;
          if (!markTurnProgress('text-delta')) return;
          markPromptCommitted();
          const thinkingLastEndedAt = closeThinkingSegment();
          // Drop any queued think-flush too: it would otherwise re-publish
          // spinner.thinking:true from flushStreamBatch and resurrect the
          // indicator after we cleared it here.
          _pendingThinkFlush = false;
          if (getState().thinking) { set({ thinking: null }); _publishedThinkingActive = false; } // collapse thinking panel immediately, no batch delay
          assistantText += textChunk;
          currentAssistantText += textChunk;
          // Accumulate text and schedule a batched flush (≤1 render per
          // STREAM_BATCH_INTERVAL_MS). Without scheduling, mid-turn text only
          // surfaced via the tool-call/finalize flush, so a text→tool segment
          // with no spinner/thinking dropped the message above the tool card.
          _pendingTextFlush = true;
          if (thinkingLastEndedAt) _pendingThinkingLastEndedAt = thinkingLastEndedAt;
          scheduleStreamFlush();
        },
        onTextReset: ({ chars, reasoning } = {}) => {
          if (!isCurrentTurn()) return false;
          const count = Math.max(0, Number(chars) || 0);
          if (reasoning) {
            closeThinkingSegment();
            _pendingThinkFlush = false;
            if (getState().thinking) { set({ thinking: null }); _publishedThinkingActive = false; }
          }
          if (!count) return reasoning === true;
          flushStreamBatch();
          assistantText = assistantText.slice(0, Math.max(0, assistantText.length - count));
          currentAssistantText = currentAssistantText.slice(
            0,
            Math.max(0, currentAssistantText.length - count),
          );
          _streamScanLen = 0;
          _lastNewlineIdx = -1;
          _emittedNewlineIdx = -2;
          _emittedVisibleText = '';
          if (currentAssistantId) {
            if (currentAssistantText) {
              updateStreamingTail(currentAssistantId, {
                text: currentAssistantText,
                at: getState().streamingTail?.at || Date.now(),
                ...turnRouteMeta,
              }, {}, { resetText: true });
            } else {
              clearStreamingTail(currentAssistantId);
              currentAssistantId = null;
            }
          }
          return true;
        },
        onAssistantText: (text) => {
          // Mid-turn assistant text that precedes a tool call. Providers that
          // stream via onTextDelta already accumulated it into assistantText;
          // providers that only return the final response.content (no deltas)
          // never fired onTextDelta, so without this the preamble shows nothing
          // before the tool card. De-dup against already-streamed text so the
          // streaming path is unaffected.
          const full = String(text ?? '');
          if (!full.trim()) return;
          if (!markTurnProgress('assistant-text')) return;
          // If the streaming path already produced text for THIS segment,
          // onTextDelta owns the render — content is the same accumulated text
          // (or a superset), so skip to avoid double-printing the preamble.
          // Do not check turn-global assistantText: earlier closed preambles stay
          // there across tool calls, and would suppress later non-streaming
          // preambles even though currentAssistantText has been reset.
          if (currentAssistantText.trim()) return;
          markPromptCommitted();
          closeThinkingSegment();
          _pendingThinkFlush = false; // see onTextDelta: prevent a stale think flush resurrecting the indicator
          if (getState().thinking) { set({ thinking: null }); _publishedThinkingActive = false; }
          assistantText += full;
          currentAssistantText += full;
          _pendingTextFlush = true;
          flushStreamBatch();
        },
        onReasoningDelta: (chunk) => {
          if (!isCurrentTurn()) return;
          if (String(chunk ?? '')) {
            if (!markTurnProgress('reasoning-delta')) return;
          }
          // Reasoning is not a commit boundary: a turn
          // interrupted while it is still thinking produced no model-visible
          // message, so Esc must hand the prompt back to the input box. Text,
          // tool calls and turn end still commit it below.
          startThinkingSegment();
          thinkingText += String(chunk ?? '');
          // Accumulate reasoning text; fire at most one render per STREAM_BATCH_INTERVAL_MS.
          _pendingThinkFlush = true;
          scheduleStreamFlush();
        },
        onUsageDelta: (delta) => {
          if (!markTurnProgress('usage-delta')) return;
          const stats = { ...getState().stats };
          applyUsageDelta(stats, delta);
          set({ stats });
          syncContextStats({ allowEstimated: true });
          const currentTurnInput = Math.max(0, getState().stats.inputTokens - inputBaseline);
          const currentTurnOutput = Math.max(0, getState().stats.outputTokens - outputBaseline);
          if (getState().spinner) {
            set({ stats: { ...getState().stats }, spinner: { ...getState().spinner, inputTokens: currentTurnInput, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...getState().stats } });
          }
        },
      });
      if (!isCurrentTurn()) {
        cancelled = true;
      } else {
        askResult = result;
        markPromptCommitted();
        if (result?.terminationReason === 'refusal') {
          pushNotice(
            'The model refused to respond (safety refusal) — retry or rephrase your prompt.',
            'warn',
            { transcript: true },
          );
        }

        flushToolResults(session?.messages || [], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
        finalizeToolHeaders();
        flushStreamBatch(); // force-flush any batched streaming text before finalization writes
        syncContextStats({ allowEstimated: true });
        // Terminal reading for the turn. Without its own publication the last
        // gauge number React ever saw is the one the previous usage delta
        // carried, so an idle session sat on a stale count until the next turn.
        set({ stats: { ...getState().stats } });

        const finalText = result?.content != null ? String(result.content) : '';
        // Strip text already sealed as its own item(s) this turn (a tool
        // preamble, then a no-newline tail committed by onSteerMessage before an
        // injected steering row) so finalization reconciles only the uncommitted
        // remainder — never re-creating a committed segment as a duplicate item
        // that also reorders after the steering row. Walk the segments IN ORDER,
        // peeling each off the front of the remaining content; skip leading
        // whitespace/newlines between segments. A segment that does not match at
        // the current position (provider omitted it from result.content, e.g. a
        // tool preamble) is left in place and the walk moves on.
        let finalRemainder = finalText;
        for (const seg of committedSegments) {
          // Compare against the whitespace-skipped remainder AND a
          // whitespace-trimmed segment: a segment sealed with its own leading
          // newline ('\nTAIL') would otherwise never match the skipped remainder
          // ('TAIL') and duplicate after the steering row.
          const skipped = finalRemainder.replace(/^\s+/, '');
          const trimmedSeg = seg ? seg.replace(/^\s+/, '') : '';
          if (trimmedSeg && skipped.startsWith(trimmedSeg)) {
            finalRemainder = skipped.slice(trimmedSeg.length);
          }
        }
        if (finalRemainder.trim()) {
          // The persisted transcript is written from the provider's final content,
          // while the live TUI row is fed by streaming deltas. If a provider/parser
          // misses or suppresses an early delta, keeping the streamed buffer here
          // leaves the final on-screen assistant row missing leading characters even
          // though the transcript is correct. Always reconcile the active segment to
          // the final provider text when it is available.
          const id = currentAssistantId || ensureAssistant(finalRemainder);
          currentAssistantText = finalRemainder;
          settleStreamingTail(id, { text: finalRemainder });
        } else if (currentAssistantId && (currentAssistantText.trim() || assistantText.trim())) {
          const streamedText = currentAssistantText || assistantText;
          settleStreamingTail(currentAssistantId, { text: streamedText });
        }
        turnFinishedNormally = true;
      }
    } catch (error) {
      const staleCatch = !isCurrentTurn();
      if (staleCatch) {
        cancelled = true;
      } else {
        flushStreamBatch(); // ensure any batched text lands before the error notice
        if (isCancelLikeError(error)) {
          cancelled = true;
          // Tool boundaries already sealed prior progress segments into their
          // own rows. On abort, preserve only the still-open segment; replaying
          // turn-global assistantText creates one giant duplicate after the
          // cancelled tool card.
          if (currentAssistantText.trim()) {
            const id = currentAssistantId || ensureAssistant(currentAssistantText);
            settleStreamingTail(id, { text: currentAssistantText });
          }
          // Finalize pending tool cards so they don't stay "Running..." forever
          // after cancellation. Without this, the spinner vanishes and TurnDone
          // shows "cancelled", but in-flight tool cards remain in a perpetual
          // pending/blinking getState() because the normal finalize path (line 992)
          // was skipped when the error interrupted the try block.
          flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true, cancelled: true });
          finalizeToolHeaders();
        } else {
          failed = true;
          finalizeToolHeaders();
          turnFailureUsageLimited = isUsageLimitError(error);
          turnFailureDetail = toolErrorDisplay(error, 'turn').replace(/^Error:\s*/i, '');
          turnFailureDiagnostic = safeErrorDetails(errText(error));
          pushNotice(turnFailureDetail, 'error', { owner: 'transcript' });
        }
      }
    } finally {
      const isStaleUnwind = !isCurrentTurn();
      if (!isStaleUnwind) denyAllToolApprovals(cancelled ? 'turn cancelled' : 'turn finished');
      clearLiveTailTimer();
      // A replaced/disposed surface must not write shared state owned by the
      // current visible turn.
      let closingItems = [];
      if (deferredCards.hasEntries()) {
        // Flush any still-deferred tool cards into the transcript and cancel
        // their pending push timers so nothing fires (or leaks) after the turn
        // ends. The finalize path above already patches results onto visible
        // cards; this just guarantees every registered card is materialized
        // before the turn closes. Collect (don't emit) the still-deferred cards
        // so the turn-close flush and the turndone item append in ONE set()
        // below instead of one render bounce per row. Order/ids are preserved
        // (creation order, then turndone last).
        if (!isStaleUnwind) closingItems = deferredCards.collectAll();
        deferredCards.clearTimers();
      }
      if (!isStaleUnwind) flags.flushDeferredBeforeImmediatePush = null;
      closeThinkingSegment();
      if (isStaleUnwind) {
        tuiDebug(`runTurn STALE UNWIND turn=${turnIndex} — skipping shared UI/state writes`);
      } else {
        if (currentAssistantId && getState().streamingTail?.id === currentAssistantId) {
          if (currentAssistantText.trim()) {
            settleStreamingTail(currentAssistantId, { text: currentAssistantText });
          } else {
            clearStreamingTail(currentAssistantId);
          }
        }
        const producedTranscriptItem =
          transcriptCompactedThisTurn
          || getState().items.length + closingItems.length > itemsAtTurnStart;
        const reclaimed = cancelled && flags.activePromptRestore?.reclaimed === true;
        flags.activePromptRestore = null;
        const elapsedMs = Date.now() - startedAt;
        const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
        // responseLength is session runtime-local now (not pushed per-token), so compute the
        // fallback from the live accumulator instead of the possibly-stale
        // getState().spinner.responseLength. Final-only / non-streaming turns never
        // accumulate `assistantText` (only currentAssistantText is set at the
        // finalize reconcile above), so take the larger of the two text sources so
        // a no-usage turn still estimates tokens from the final content.
        const finalAssistantLen = Math.max(assistantText.length, currentAssistantText.length);
        const finalResponseLength = finalAssistantLen + thinkingText.length;
        const finalOutputTokens = Math.max(0, Number(getState().spinner?.outputTokens || 0), Math.round(finalResponseLength / 4));
        const turnStatus = cancelled ? 'cancelled' : (failed ? 'failed' : 'done');
        const resultContent = askResult?.content != null ? String(askResult.content).trim() : '';
        const assistantOutput = (currentAssistantText || assistantText || '').trim();
        // Suppress only true pending-resume no-ops: no transcript items added and no model output; cancelled/error turns and any visible turn stay marked.
        const isNoOpTurn = turnFinishedNormally
          && !cancelled
          && toolCards.length === 0
          && !resultContent
          && !assistantOutput
          && !producedTranscriptItem;
        if (!isNoOpTurn) {
          set({ stats: { ...getState().stats, turns: (getState().stats.turns || 0) + 1 } });
        }
        // Pin the post-think summary into the transcript right after this turn's
        // output so it scrolls up with the answer and stays in the scrollback,
        // in scrollback. (Previously TurnDone rendered only in the
        // bottom-fixed live-status slot and vanished on the next turn.)
        if (!reclaimed && !isNoOpTurn) {
          closingItems.push({
            kind: 'turndone',
            id: nextId(),
            elapsedMs,
            status: turnStatus,
            outputTokens: finalOutputTokens,
            thinkingElapsedMs,
            verb: completionVerb,
            at: Date.now(),
            ...(turnFailureDetail ? { detail: turnFailureDetail } : {}),
            ...(turnFailureDiagnostic ? { errorDetails: turnFailureDiagnostic } : {}),
            ...turnRouteMeta,
          });
        }
        // Deferred cards + turndone + status all land in ONE set() (one commit).
        appendItemsBatch(closingItems, {
          busy: false,
          spinner: null,
          thinking: null,
          lastTurn: null,
          stats: { ...getState().stats },
          ...routeState(),
          toolMode: runtime.toolMode,
          ...agentStatusState({ force: true }),
        });
        flushDeferredExecutionPendingResumeKick();
      }
    }
    // Shared UI getState(): a stale unwind must not wipe a newer turn's live
    // tool-summary line (same epoch rule as the shared-getState() block above).
    if (flags.leadTurnEpoch === turnEpoch) clearActiveToolSummary();
    // Turn completion is latency-sensitive and must publish busy=false plus all
    // terminal transcript/card mutations as one final snapshot.
    flushEmit?.();
    _publishedThinkingActive = false; // turn teardown cleared getState().thinking
    const finalStatus = cancelled ? 'cancelled' : (failed ? 'failed' : 'done');
    try {
      await bag.onGoalTurnSettled?.({
        status: finalStatus,
        error: turnFailureDetail || null,
        usageLimited: turnFailureUsageLimited,
        preserveGoalState: preserveGoalStateAfterTurn({
          cancelled,
          stale: !isCurrentTurn(),
          pendingSessionReset: flags.pendingSessionReset,
          disposed: flags.disposed,
          interruptedForSteering: flags.goalSteeringAbortEpoch === turnEpoch,
        }),
      });
    } catch {}
    if (flags.goalSteeringAbortEpoch === turnEpoch) flags.goalSteeringAbortEpoch = null;
    try {
      options.onSettled?.({
        status: finalStatus,
        result: askResult,
        session: runtime.session || null,
        error: turnFailureDetail || null,
      });
    } catch {}
    tuiDebug(`runTurn end turn=${turnIndex} status=${finalStatus} elapsedMs=${Date.now() - startedAt} pending=${pending.length}`);
    return finalStatus;
  }

  return runTurn;
}
