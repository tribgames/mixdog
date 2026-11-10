// Per-turn streaming state for the lead TUI turn: the assistant text
// segments, the thinking (reasoning) timer, and the frame-batched flush that
// publishes completed visible lines and thinking transitions to the store,
// plus the desktop-only unfinished line (`streamingPartial`, see partialNow).
// `createTurnStream` returns one explicit state object (deps + mutable
// scalars); every function here takes it as its first argument.
import { TUI_FRAME_MS, yieldToRenderer } from './render-timing.mjs';
import { retryStatusLine } from '../../runtime/shared/err-text.mjs';
import { MODEL_THINKING_STAGE } from '../../runtime/shared/quiet-progress.mjs';
import { newTranscriptMessageId } from '../../runtime/shared/transcript-metadata.mjs';

// Share Ink's exact 120fps cadence with the frame-batched store. A separate
// 16ms timer left every other terminal frame idle, so completed script lines
// accumulated and then climbed into view in coarse two-step chunks.
const STREAM_BATCH_INTERVAL_MS = TUI_FRAME_MS;
// The desktop's unfinished-line channel (see partialNow): at most one
// publication per interval, the first chunk after an idle gap on the next
// frame. Forced flushes (tool calls, notices, finalization) publish at once.
const PARTIAL_INTERVAL_MS = 40;

// deps: getState, set, nextId, updateStreamingTail, settleStreamingTail,
// clearStreamingTail, isCurrentTurn, transcriptMeta, routeMeta, sealToolBlock.
export function createTurnStream(deps) {
  return {
    ...deps,
    assistantText: '',
    currentAssistantId: null,
    currentAssistantText: '',
    // Segments sealed as their own assistant item(s) this turn via
    // commitAssistantSegment (e.g. a tool preamble, then a no-newline tail
    // committed before an injected steering row). Kept as an ordered list —
    // NOT one concatenated string — so finalization can strip each committed
    // segment out of the provider's final content individually: the combined
    // prefix no longer matches when the provider omits an earlier segment.
    committedSegments: [],
    // The open segment was settled when the provider streamed a tool call
    // (turn.mjs); cleared when that response's tool calls open.
    settledBeforeToolCall: false,
    // The phase the provider named for the message this segment streams
    // (`commentary` / `final_answer`), or null; the desktop row carries it.
    phase: null,
    thinkingText: '',
    // Length of thinkingText when the current provider send began: a
    // `reasoning` retraction drops only what that send added.
    thinkingSendMark: 0,
    thinkingStartedAt: 0,
    thinkingSegmentStartedAt: 0,
    accumulatedThinkingMs: 0,
    compactingActive: false,
    // Streaming-delta batcher: onTextDelta/onReasoningDelta fire on every
    // tiny chunk; accumulated text flushes at most once per frame, and a
    // forced flush runs before any tool call, finalization or error so those
    // paths see the correct text.
    batchTimer: null,
    pendingTextFlush: false,
    pendingThinkFlush: false,
    pendingThinkingLastEndedAt: 0,
    // Incremental line scan: avoids rescanning the full accumulated text
    // (lastIndexOf) on every flush.
    scanLen: 0,
    lastNewlineIdx: -1,
    emittedNewlineIdx: -2, // -2 forces the first compute
    emittedVisibleText: '',
    // Last thinking boolean pushed to the store. Neither responseLength nor
    // thinkingText is rendered per-token by any consumer, so those grow
    // locally and publish only on a visible transition, a completed line,
    // tool/usage updates, or finalization.
    publishedThinkingActive: false,
    // Live countdown of a reconnect wait (see startReconnectCountdown).
    reconnectTimer: null,
    // The row identity (id, time, message id) claimed before the row exists,
    // while only the desktop's partial line shows it; the row takes it over.
    assistantIdentity: null,
    // Desktop partial-line publication timer and last publish time.
    partialTimer: null,
    partialPublishedAt: 0,
    // This segment's partial is on screen / was cleared by a transcript
    // replacement (and must not come back).
    partialShown: false,
    partialDropped: false,
  };
}

function claimAssistantIdentity(stream) {
  if (stream.assistantIdentity) return stream.assistantIdentity;
  const id = stream.nextId();
  const meta = stream.transcriptMeta;
  // A non-streaming continuation was persisted before its text reached this
  // row: the runtime left that message's id and time (ask-session
  // takeAssistant), and the row carries them instead of minting new ones.
  const persisted = stream.claimPersistedAssistant ? meta.persistedAssistant : null;
  if (persisted) meta.persistedAssistant = null;
  let assistantAt = persisted?.at;
  let messageId = persisted?.messageId;
  if (!persisted) {
    assistantAt =
      Number.isFinite(Number(meta.assistantAt)) && Number(meta.assistantAt) > 0 ? Number(meta.assistantAt) : Date.now();
    meta.assistantAt = assistantAt;
    // The reply this segment becomes is persisted with this stable id (the
    // runtime takes it with assistantAt), so a compaction that drops the
    // reply greys this row.
    if (!(typeof meta.assistantMessageId === 'string' && meta.assistantMessageId)) {
      meta.assistantMessageId = newTranscriptMessageId();
    }
    messageId = meta.assistantMessageId;
  }
  stream.assistantIdentity = { id, at: assistantAt, messageId };
  return stream.assistantIdentity;
}

function ensureAssistant(stream, initialText = '') {
  if (!stream.currentAssistantId) {
    const { id, at, messageId } = claimAssistantIdentity(stream);
    stream.assistantIdentity = null;
    stream.currentAssistantId = id;
    // Do NOT reset currentAssistantText here: the first onTextDelta has
    // already accumulated the opening chunk before this batched flush runs.
    // Segment resets are owned by closeAssistantSegment(). Seed the new row
    // with the already-visible text so the ● gutter and the first body line
    // appear in the SAME set()/emit() — no empty "●-only" row.
    stream.updateStreamingTail(id, {
      text: String(initialText || ''),
      at,
      messageId,
      ...phaseField(stream),
      ...stream.routeMeta,
    });
  }
  return stream.currentAssistantId;
}

// The desktop paints streamed text before its line completes; the terminal
// keeps the line-gated tail below. `streamingPartial` is the unfinished line
// beyond the published tail text (`from` is that text's length), cut from the
// same leak-guarded text the tail is, never raw provider output. Before the
// row's first completed line there is no tail: the partial then carries all
// visible text so far plus the row identity (`tail`) the row will take over.
// Terminal projections drop the field (session-proxy/projection.mjs).
function partialNow(stream) {
  const text = stream.currentAssistantText;
  const id = stream.currentAssistantId;
  if (id != null) {
    const tail = stream.getState().streamingTail;
    if (!tail || tail.id !== id) return null;
    const shown = typeof tail.text === 'string' ? tail.text : '';
    if (text.length <= shown.length || !text.startsWith(shown)) return null;
    return { id, from: shown.length, text: text.slice(shown.length) };
  }
  // Same rule as the row itself: nothing appears before visible content.
  if (!text.trim()) return null;
  const identity = claimAssistantIdentity(stream);
  return {
    id: identity.id,
    from: 0,
    text,
    tail: {
      kind: 'assistant',
      id: identity.id,
      streaming: true,
      at: identity.at,
      messageId: identity.messageId,
      ...phaseField(stream),
      ...stream.routeMeta,
    },
  };
}

// The row's `phase` field; absent when the provider named none.
function phaseField(stream) {
  return stream.phase ? { phase: stream.phase } : {};
}

function samePartial(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.id === right.id && left.from === right.from && left.text === right.text && !left.tail === !right.tail;
}

function clearPartialTimer(stream) {
  if (stream.partialTimer === null) return;
  clearTimeout(stream.partialTimer);
  stream.partialTimer = null;
}

function publishPartial(stream) {
  clearPartialTimer(stream);
  if (!stream.isCurrentTurn()) return;
  const current = stream.getState().streamingPartial ?? null;
  // A transcript replacement cleared the partial this segment showed: the
  // segment stays gone, like a tail the replacement dropped.
  if (stream.partialShown && current === null) stream.partialDropped = true;
  if (stream.partialDropped) return;
  const next = partialNow(stream);
  stream.partialShown = next !== null;
  if (samePartial(current, next)) return;
  stream.partialPublishedAt = Date.now();
  stream.set({ streamingPartial: next });
}

function schedulePartial(stream) {
  if (stream.partialTimer !== null) return;
  const wait = Math.max(STREAM_BATCH_INTERVAL_MS, PARTIAL_INTERVAL_MS - (Date.now() - stream.partialPublishedAt));
  stream.partialTimer = setTimeout(() => {
    stream.partialTimer = null;
    flushStreamBatch(stream);
  }, wait);
  stream.partialTimer?.unref?.();
}

// The segment's text settled (or was dropped): no partial line outlives it.
function clearPartial(stream) {
  clearPartialTimer(stream);
  stream.partialShown = false;
  if (stream.getState().streamingPartial != null && stream.isCurrentTurn()) stream.set({ streamingPartial: null });
}

function resetLineScan(stream) {
  stream.scanLen = 0;
  stream.lastNewlineIdx = -1;
  stream.emittedNewlineIdx = -2;
  stream.emittedVisibleText = '';
}

function closeAssistantSegment(stream) {
  stream.currentAssistantId = null;
  stream.currentAssistantText = '';
  stream.phase = null;
  stream.claimPersistedAssistant = false;
  stream.assistantIdentity = null;
  resetLineScan(stream);
  clearPartial(stream);
  stream.partialDropped = false;
}

export function commitAssistantSegment(stream, { sealToolBlock = false } = {}) {
  const text = stream.currentAssistantText || '';
  if (!text.trim()) {
    closeAssistantSegment(stream);
    return false;
  }
  if (sealToolBlock) stream.sealToolBlock();
  const id = stream.currentAssistantId || ensureAssistant(stream, text);
  stream.settleStreamingTail(id, { text });
  stream.committedSegments.push(text);
  closeAssistantSegment(stream);
  return true;
}

function startThinkingSegment(stream) {
  const now = Date.now();
  if (!stream.thinkingStartedAt) stream.thinkingStartedAt = now;
  if (!stream.thinkingSegmentStartedAt) stream.thinkingSegmentStartedAt = now;
  return now;
}

export function closeThinkingSegment(stream) {
  if (!stream.thinkingSegmentStartedAt) return;
  const now = Date.now();
  stream.accumulatedThinkingMs += Math.max(0, now - stream.thinkingSegmentStartedAt);
  stream.thinkingSegmentStartedAt = 0;
  return now;
}

// Show only COMPLETED lines while streaming. The in-progress trailing line
// stays hidden until its '\n' arrives, so the visible text never grows a
// glyph at a time (no partial reveal, no CJK-width reflow jitter). The final
// non-streaming patch always carries the full text, so a tail line that never
// got a newline still lands once at finalize. Each char is examined once
// across the stream; when the newline offset hasn't advanced the visible text
// is byte-identical to the last flush and the cached slice is reused.
function streamingVisibleTextNow(stream) {
  const text = stream.currentAssistantText;
  const textLen = text.length;
  if (textLen < stream.scanLen) {
    stream.scanLen = 0;
    stream.lastNewlineIdx = -1;
  }
  for (let i = stream.scanLen; i < textLen; i++) {
    if (text.charCodeAt(i) === 10) stream.lastNewlineIdx = i;
  }
  stream.scanLen = textLen;
  if (stream.lastNewlineIdx === stream.emittedNewlineIdx) return stream.emittedVisibleText;
  stream.emittedVisibleText = stream.lastNewlineIdx >= 0 ? text.slice(0, stream.lastNewlineIdx + 1) : '';
  stream.emittedNewlineIdx = stream.lastNewlineIdx;
  return stream.emittedVisibleText;
}

// Only consumed at finalize as an outputTokens fallback; refreshed on
// visible-line flush and finalize so that fallback stays valid.
function responseLength(stream) {
  return stream.assistantText.length + stream.thinkingText.length;
}

function flushTextBatch(stream) {
  const { getState, set } = stream;
  const visibleText = streamingVisibleTextNow(stream);
  const patch = {};
  let rowCreated = false;
  // Do NOT create the assistant row (and scroll the transcript) before there
  // is a completed line with VISIBLE content: the row appears together with
  // its first visible line. `.trim()` also guards a response that opens with
  // leading newlines, whose blank first line would reserve rows and scroll
  // onto an empty band until a non-blank line lands.
  if (stream.currentAssistantId || visibleText.trim()) {
    rowCreated = !stream.currentAssistantId;
    const id = ensureAssistant(stream, visibleText);
    const current = getState().streamingTail;
    if (!current || current.id !== id || !Object.is(current.text, visibleText)) {
      patch.streamingTail = {
        ...(current || {}),
        kind: 'assistant',
        id,
        text: visibleText,
        streaming: true,
        at: current?.at || Date.now(),
        phase: stream.phase || undefined,
        ...stream.routeMeta,
      };
    }
  }
  // Only touch the spinner for a real reason: a visible-line change, a
  // thinking→responding transition, or a pending thinking end timestamp.
  const visibleLineChanged = patch.streamingTail !== undefined;
  const thinkingTransition = stream.publishedThinkingActive === true;
  if (getState().spinner && (visibleLineChanged || thinkingTransition || stream.pendingThinkingLastEndedAt)) {
    patch.spinner = {
      ...getState().spinner,
      responseLength: responseLength(stream),
      thinking: false,
      thinkingLastEndedAt: stream.pendingThinkingLastEndedAt || getState().spinner.thinkingLastEndedAt,
      mode: stream.compactingActive ? 'compacting' : 'responding',
    };
    stream.publishedThinkingActive = false;
  }
  if (patch.streamingTail) {
    const { streamingTail, ...extra } = patch;
    stream.updateStreamingTail(streamingTail.id, streamingTail, extra);
  } else if (Object.keys(patch).length > 0) {
    set(patch);
  }
  stream.pendingThinkingLastEndedAt = 0;
  // A completed line created or moved the tail: the partial line restarts
  // after it in the same frame, so the two never disagree on screen.
  if (rowCreated || patch.streamingTail) publishPartial(stream);
}

function thinkingSpinnerPatch(stream, thinkingElapsedMs) {
  const spinner = stream.getState().spinner;
  const base = {
    ...spinner,
    responseLength: responseLength(stream),
    thinkingAccumulatedMs: stream.accumulatedThinkingMs,
    thinkingElapsedMs,
  };
  if (stream.compactingActive) {
    return { ...base, thinking: false, thinkingLastEndedAt: spinner.thinkingLastEndedAt || 0, mode: 'compacting' };
  }
  return {
    ...base,
    thinking: true,
    thinkingStartedAt: stream.thinkingStartedAt,
    thinkingSegmentStartedAt: stream.thinkingSegmentStartedAt,
    thinkingLastEndedAt: 0,
    mode: 'thinking',
  };
}

// Consumers read getState().thinking as a boolean and the Spinner derives
// its live elapsed from the published thinkingSegmentStartedAt anchor, so
// publish only on the OFF→ON transition (or when compacting toggles the
// flag), not on every reasoning chunk. The full thinkingText stays local and
// is emitted at finalize via the normal spinner/thinking teardown.
function flushThinkBatch(stream) {
  const nextThinkingActive = !stream.compactingActive;
  if (nextThinkingActive === stream.publishedThinkingActive) return;
  const thinkingElapsedMs =
    stream.accumulatedThinkingMs +
    (stream.thinkingSegmentStartedAt ? Math.max(0, Date.now() - stream.thinkingSegmentStartedAt) : 0);
  // thinking stays a truthy sentinel while active (thinkingText) so a late
  // consumer still sees real text.
  const patch = { thinking: stream.compactingActive ? null : stream.thinkingText };
  if (stream.getState().spinner) patch.spinner = thinkingSpinnerPatch(stream, thinkingElapsedMs);
  stream.set(patch);
  stream.publishedThinkingActive = nextThinkingActive;
}

function flushPendingBatches(stream) {
  if (stream.batchTimer !== null) {
    clearTimeout(stream.batchTimer);
    stream.batchTimer = null;
  }
  if (!stream.isCurrentTurn()) {
    stream.pendingTextFlush = false;
    stream.pendingThinkFlush = false;
    stream.pendingThinkingLastEndedAt = 0;
    clearPartialTimer(stream);
    return;
  }
  if (stream.pendingTextFlush) {
    stream.pendingTextFlush = false;
    flushTextBatch(stream);
  }
  if (stream.pendingThinkFlush) {
    stream.pendingThinkFlush = false;
    flushThinkBatch(stream);
  }
}

// A forced flush is a boundary (tool call, notice, finalization, error, or
// the partial-line tick): the line-gated batch lands, and so does the
// desktop's unfinished line.
export function flushStreamBatch(stream) {
  flushPendingBatches(stream);
  publishPartial(stream);
}

function scheduleStreamFlush(stream) {
  if (stream.batchTimer !== null) return; // already scheduled; do not re-arm
  stream.batchTimer = setTimeout(() => flushPendingBatches(stream), STREAM_BATCH_INTERVAL_MS);
  stream.batchTimer?.unref?.(); // don't prevent process exit
}

// Collapse the thinking panel immediately (no batch delay) and drop any
// queued think-flush: it would otherwise re-publish spinner.thinking:true
// from flushStreamBatch and resurrect the indicator after it was cleared.
function endThinkingForText(stream) {
  const thinkingLastEndedAt = closeThinkingSegment(stream);
  stream.pendingThinkFlush = false;
  if (stream.getState().thinking) {
    stream.set({ thinking: null });
    stream.publishedThinkingActive = false;
  }
  return thinkingLastEndedAt;
}

// Accumulate text and schedule a batched flush. Without scheduling, mid-turn
// text only surfaced via the tool-call/finalize flush, so a text→tool segment
// with no spinner/thinking dropped the message above the tool card.
export function appendTextDelta(stream, textChunk) {
  const thinkingLastEndedAt = endThinkingForText(stream);
  stream.assistantText += textChunk;
  stream.currentAssistantText += textChunk;
  stream.pendingTextFlush = true;
  if (thinkingLastEndedAt) stream.pendingThinkingLastEndedAt = thinkingLastEndedAt;
  scheduleStreamFlush(stream);
  schedulePartial(stream);
}

// Mid-turn assistant text that precedes a tool call from a provider that only
// returns the final response.content (no deltas); the streaming path owns
// the render when it already produced text for this segment.
export function appendAssistantText(stream, full, { committed = false } = {}) {
  endThinkingForText(stream);
  stream.assistantText += full;
  stream.currentAssistantText += full;
  stream.pendingTextFlush = true;
  // Only post-commit text is the persisted message's own: its row takes that
  // id. Any other text (a tool preamble published before its message commits)
  // leaves an earlier recorded id unclaimed, so drop it.
  stream.claimPersistedAssistant = committed;
  // A committed message's row takes its persisted identity, never one claimed
  // earlier for partial text that has since been retracted.
  if (committed && !stream.currentAssistantId) stream.assistantIdentity = null;
  if (!committed && stream.transcriptMeta && typeof stream.transcriptMeta === 'object') {
    stream.transcriptMeta.persistedAssistant = null;
  }
  flushStreamBatch(stream);
}

// The provider named the phase of the message it is streaming. A message of
// another phase than the open segment's text is its own row: that segment
// settles first. A segment whose phase was not known yet (the provider named
// it only on the finished message) takes it.
export function noteAssistantPhase(stream, phase) {
  if (phase !== 'commentary' && phase !== 'final_answer') return;
  if (stream.phase === phase) return;
  if (stream.phase && stream.currentAssistantText.trim()) {
    flushStreamBatch(stream);
    commitAssistantSegment(stream);
  }
  stream.phase = phase;
  const tail = stream.getState().streamingTail;
  if (stream.currentAssistantId != null && tail?.id === stream.currentAssistantId) {
    stream.updateStreamingTail(tail.id, { phase });
  }
}

// Reasoning is not a commit boundary: a turn interrupted while it is still
// thinking produced no model-visible message, so Esc must hand the prompt
// back to the input box. Text, tool calls and turn end still commit it.
export function appendReasoningDelta(stream, chunk) {
  startThinkingSegment(stream);
  stream.thinkingText += chunk;
  stream.pendingThinkFlush = true;
  scheduleStreamFlush(stream);
}

// A provider send (one model request of the turn) begins: the thinking so far
// belongs to earlier sends and survives a retraction of this one.
export function markThinkingSendStart(stream) {
  stream.thinkingSendMark = stream.thinkingText.length;
}

export function resetStreamedText(stream, { chars, reasoning } = {}) {
  const count = Math.max(0, Number(chars) || 0);
  if (reasoning) {
    endThinkingForText(stream);
    // The discarded attempt's thinking must not prefix the next attempt's;
    // earlier sends' thinking stays.
    stream.thinkingText = stream.thinkingText.slice(0, stream.thinkingSendMark);
  }
  if (!count) return reasoning === true;
  flushStreamBatch(stream);
  stream.assistantText = stream.assistantText.slice(0, Math.max(0, stream.assistantText.length - count));
  stream.currentAssistantText = stream.currentAssistantText.slice(
    0,
    Math.max(0, stream.currentAssistantText.length - count)
  );
  resetLineScan(stream);
  if (stream.currentAssistantId) {
    if (stream.currentAssistantText) {
      stream.updateStreamingTail(
        stream.currentAssistantId,
        {
          text: stream.currentAssistantText,
          at: stream.getState().streamingTail?.at || Date.now(),
          ...stream.routeMeta,
        },
        {},
        { resetText: true }
      );
    } else {
      stream.clearStreamingTail(stream.currentAssistantId);
      stream.currentAssistantId = null;
    }
  }
  // The retraction applies to the desktop's partial line in the same frame.
  publishPartial(stream);
  return true;
}

// A tool batch ends any open thinking segment and moves the spinner to the
// tool phase (`spinnerMode`: 'task-wait' or 'tool-use').
export function closeThinkingForToolBatch(stream, spinnerMode) {
  const { getState, set } = stream;
  // The send that produced this batch is complete; its thinking is kept.
  markThinkingSendStart(stream);
  if (stream.thinkingText && getState().thinking) {
    const thinkingLastEndedAt = closeThinkingSegment(stream);
    set({
      thinking: null,
      spinner: getState().spinner
        ? {
            ...getState().spinner,
            thinking: false,
            thinkingAccumulatedMs: stream.accumulatedThinkingMs,
            thinkingLastEndedAt,
            mode: spinnerMode,
          }
        : getState().spinner,
    });
    stream.publishedThinkingActive = false;
  } else if (getState().spinner) {
    set({ spinner: { ...getState().spinner, mode: spinnerMode } });
  }
}

// A reconnect wait that names its next attempt (`retryAt` + `reason`) shows the
// remaining time and counts it down, instead of freezing on the first
// "in 15s" for the whole wait. Whole seconds, never below 1s while waiting.
function reconnectVerb(detail, now = Date.now()) {
  const retryAt = Number(detail?.retryAt) || 0;
  if (!(retryAt > 0) || typeof detail?.reason !== 'string' || !detail.reason) {
    return String(detail?.message || 'Reconnecting');
  }
  const remaining = retryAt - now;
  return retryStatusLine({
    reason: detail.reason,
    attempt: detail.attempt,
    maxAttempts: detail.max,
    delayMs: remaining > 0 ? Math.max(1_000, Math.round(remaining / 1_000) * 1_000) : 0,
  });
}

function stopReconnectCountdown(stream) {
  if (!stream.reconnectTimer) return;
  clearInterval(stream.reconnectTimer);
  stream.reconnectTimer = null;
}

// The spinner's wait fields for a reconnect stage (see applyStageChange).
function reconnectWait(detail, now = Date.now()) {
  const retryAt = Number(detail?.retryAt) || 0;
  return { retryAt, retryInMs: retryAt > 0 ? Math.max(0, retryAt - now) : 0 };
}

// Re-renders the reconnect verb once a second until the wait ends, the stage
// moves on, or the turn is gone. The desktop reads the same spinner state.
function startReconnectCountdown(stream, detail) {
  const retryAt = Number(detail?.retryAt) || 0;
  if (!(retryAt > Date.now()) || !detail?.reason) return;
  stream.reconnectTimer = setInterval(() => {
    const spinner = stream.getState().spinner;
    if (!stream.isCurrentTurn() || spinner?.mode !== 'reconnecting' || Date.now() >= retryAt) {
      stopReconnectCountdown(stream);
      return;
    }
    stream.set({ spinner: { ...spinner, verb: reconnectVerb(detail), ...reconnectWait(detail) } });
  }, 1_000);
  stream.reconnectTimer.unref?.();
}

export async function applyStageChange(stream, stage, detail = null) {
  const { getState, set } = stream;
  if (stage === 'account-changed') {
    // A selection change is UI state, not a spinner phase or transcript item.
    set({ providerAccountChange: detail });
    return;
  }
  stopReconnectCountdown(stream);
  if (!getState().spinner) return;
  const value = String(stage || '');
  if (value === 'compacting') {
    stream.compactingActive = true;
    const thinkingLastEndedAt = closeThinkingSegment(stream);
    stream.pendingThinkFlush = false;
    stream.publishedThinkingActive = false; // compacting cleared the thinking flag
    set({
      thinking: null,
      spinner: {
        ...getState().spinner,
        thinking: false,
        thinkingSegmentStartedAt: 0,
        thinkingAccumulatedMs: stream.accumulatedThinkingMs,
        thinkingLastEndedAt: thinkingLastEndedAt || getState().spinner.thinkingLastEndedAt || 0,
        mode: 'compacting',
      },
    });
    await yieldToRenderer();
    return;
  }
  if (value === 'reconnecting') {
    stream.compactingActive = false;
    // The wait rides on the spinner so a surface that repaints on its own
    // clock (the desktop status line) counts it down itself: `retryInMs` is
    // the remaining wait at publish (relative, so a remote client's clock skew
    // cannot distort it) and `retryAt` only identifies this retry.
    set({
      spinner: {
        ...getState().spinner,
        mode: 'reconnecting',
        verb: reconnectVerb(detail),
        ...reconnectWait(detail),
      },
    });
    startReconnectCountdown(stream, detail);
    await yieldToRenderer();
    return;
  }
  if (value === 'requesting' || value === 'streaming' || value === MODEL_THINKING_STAGE) {
    stream.compactingActive = false;
  }
  let mode = null;
  if (value === 'requesting') mode = 'requesting';
  else if (value === MODEL_THINKING_STAGE) mode = 'model-thinking';
  else if (value === 'streaming') mode = getState().spinner.thinking ? 'thinking' : 'responding';
  if (!mode || getState().spinner.mode === mode) return;
  set({ spinner: { ...getState().spinner, mode } });
}

// Strip text already sealed as its own item(s) this turn so finalization
// reconciles only the uncommitted remainder — never re-creating a committed
// segment as a duplicate item that also reorders after the steering row.
// Walk the segments IN ORDER, peeling each off the front of the remaining
// content and skipping whitespace between segments; compare a
// whitespace-trimmed segment too, since a segment sealed with its own
// leading newline would otherwise never match. A segment the provider
// omitted from result.content (e.g. a tool preamble) is left in place.
function uncommittedRemainder(finalText, committedSegments) {
  let remainder = finalText;
  for (const seg of committedSegments) {
    const skipped = remainder.replace(/^\s+/, '');
    const trimmedSeg = seg ? seg.replace(/^\s+/, '') : '';
    if (trimmedSeg && skipped.startsWith(trimmedSeg)) remainder = skipped.slice(trimmedSeg.length);
  }
  return remainder;
}

// The persisted transcript is written from the provider's final content while
// the live row is fed by streaming deltas. If a provider/parser misses an
// early delta, keeping the streamed buffer leaves the on-screen row missing
// leading characters, so the active segment always reconciles to the final
// provider text when it is available.
export function settleFinalText(stream, finalText) {
  const remainder = uncommittedRemainder(finalText, stream.committedSegments);
  if (remainder.trim()) {
    const id = stream.currentAssistantId || ensureAssistant(stream, remainder);
    stream.currentAssistantText = remainder;
    stream.settleStreamingTail(id, { text: remainder });
  } else if (stream.currentAssistantId && (stream.currentAssistantText.trim() || stream.assistantText.trim())) {
    stream.settleStreamingTail(stream.currentAssistantId, {
      text: stream.currentAssistantText || stream.assistantText,
    });
  }
  clearPartial(stream);
}

// On abort, preserve only the still-open segment: tool boundaries already
// sealed prior progress segments into their own rows, and replaying the
// turn-global text would create one giant duplicate after the cancelled card.
export function settleOpenSegmentOnCancel(stream) {
  if (stream.currentAssistantText.trim()) {
    const id = stream.currentAssistantId || ensureAssistant(stream, stream.currentAssistantText);
    stream.settleStreamingTail(id, { text: stream.currentAssistantText });
  }
  clearPartial(stream);
}

// A segment that never completed a line has no tail, only the partial row the
// desktop shows. A turn that ends without finalizing it (provider error,
// aborted tool loop) keeps that text as its row, like cancellation does. A
// transcript replacement cleared the partial, and then the text stays gone.
function settlePartialOnlySegment(stream) {
  const identity = stream.assistantIdentity;
  const open = stream.getState().streamingPartial;
  if (stream.currentAssistantId || stream.partialDropped || !identity || open?.id !== identity.id) return;
  if (!stream.isCurrentTurn()) return;
  const text = stream.currentAssistantText;
  if (!text.trim()) return;
  stream.settleStreamingTail(ensureAssistant(stream, text), { text });
}

export function settleStreamingTailAtClose(stream) {
  settlePartialOnlySegment(stream);
  clearPartial(stream);
  const id = stream.currentAssistantId;
  if (!id || stream.getState().streamingTail?.id !== id) return;
  if (stream.currentAssistantText.trim()) stream.settleStreamingTail(id, { text: stream.currentAssistantText });
  else stream.clearStreamingTail(id);
}

// Final-only / non-streaming turns never accumulate assistantText (only
// currentAssistantText is set by the finalize reconcile), so take the larger
// of the two text sources so a no-usage turn still estimates tokens.
export function finalOutputTokens(stream, spinnerOutputTokens) {
  const finalAssistantLen = Math.max(stream.assistantText.length, stream.currentAssistantText.length);
  const finalResponseLength = finalAssistantLen + stream.thinkingText.length;
  return Math.max(0, Number(spinnerOutputTokens || 0), Math.round(finalResponseLength / 4));
}
