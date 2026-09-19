// Per-turn streaming state for the lead TUI turn: the assistant text
// segments, the thinking (reasoning) timer, and the frame-batched flush that
// publishes completed visible lines and thinking transitions to the store.
// `createTurnStream` returns one explicit state object (deps + mutable
// scalars); every function here takes it as its first argument.
import { TUI_FRAME_MS, yieldToRenderer } from './render-timing.mjs';

// Share Ink's exact 120fps cadence with the frame-batched store. A separate
// 16ms timer left every other terminal frame idle, so completed script lines
// accumulated and then climbed into view in coarse two-step chunks.
const STREAM_BATCH_INTERVAL_MS = TUI_FRAME_MS;

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
    thinkingText: '',
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
  };
}

export function ensureAssistant(stream, initialText = '') {
  if (!stream.currentAssistantId) {
    stream.currentAssistantId = stream.nextId();
    const meta = stream.transcriptMeta;
    const assistantAt =
      Number.isFinite(Number(meta.assistantAt)) && Number(meta.assistantAt) > 0 ? Number(meta.assistantAt) : Date.now();
    meta.assistantAt = assistantAt;
    // Do NOT reset currentAssistantText here: the first onTextDelta has
    // already accumulated the opening chunk before this batched flush runs.
    // Segment resets are owned by closeAssistantSegment(). Seed the new row
    // with the already-visible text so the ● gutter and the first body line
    // appear in the SAME set()/emit() — no empty "●-only" row.
    stream.updateStreamingTail(stream.currentAssistantId, {
      text: String(initialText || ''),
      at: assistantAt,
      ...stream.routeMeta,
    });
  }
  return stream.currentAssistantId;
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
  resetLineScan(stream);
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
  // Do NOT create the assistant row (and scroll the transcript) before there
  // is a completed line with VISIBLE content: the row appears together with
  // its first visible line. `.trim()` also guards a response that opens with
  // leading newlines, whose blank first line would reserve rows and scroll
  // onto an empty band until a non-blank line lands.
  if (stream.currentAssistantId || visibleText.trim()) {
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

export function flushStreamBatch(stream) {
  if (stream.batchTimer !== null) {
    clearTimeout(stream.batchTimer);
    stream.batchTimer = null;
  }
  if (!stream.isCurrentTurn()) {
    stream.pendingTextFlush = false;
    stream.pendingThinkFlush = false;
    stream.pendingThinkingLastEndedAt = 0;
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

function scheduleStreamFlush(stream) {
  if (stream.batchTimer !== null) return; // already scheduled; do not re-arm
  stream.batchTimer = setTimeout(() => flushStreamBatch(stream), STREAM_BATCH_INTERVAL_MS);
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
}

// Mid-turn assistant text that precedes a tool call from a provider that only
// returns the final response.content (no deltas); the streaming path owns
// the render when it already produced text for this segment.
export function appendAssistantText(stream, full) {
  endThinkingForText(stream);
  stream.assistantText += full;
  stream.currentAssistantText += full;
  stream.pendingTextFlush = true;
  flushStreamBatch(stream);
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

export function resetStreamedText(stream, { chars, reasoning } = {}) {
  const count = Math.max(0, Number(chars) || 0);
  if (reasoning) endThinkingForText(stream);
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
        { text: stream.currentAssistantText, at: stream.getState().streamingTail?.at || Date.now(), ...stream.routeMeta },
        {},
        { resetText: true }
      );
    } else {
      stream.clearStreamingTail(stream.currentAssistantId);
      stream.currentAssistantId = null;
    }
  }
  return true;
}

// A tool batch ends any open thinking segment and moves the spinner to the
// tool phase (`spinnerMode`: 'task-wait' or 'tool-use').
export function closeThinkingForToolBatch(stream, spinnerMode) {
  const { getState, set } = stream;
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

export async function applyStageChange(stream, stage, detail = null) {
  const { getState, set } = stream;
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
    set({ spinner: { ...getState().spinner, mode: 'reconnecting', verb: String(detail?.message || 'Reconnecting') } });
    await yieldToRenderer();
    return;
  }
  if (value === 'requesting' || value === 'streaming') stream.compactingActive = false;
  let mode = null;
  if (value === 'requesting') mode = 'requesting';
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
    stream.settleStreamingTail(stream.currentAssistantId, { text: stream.currentAssistantText || stream.assistantText });
  }
}

// On abort, preserve only the still-open segment: tool boundaries already
// sealed prior progress segments into their own rows, and replaying the
// turn-global text would create one giant duplicate after the cancelled card.
export function settleOpenSegmentOnCancel(stream) {
  if (!stream.currentAssistantText.trim()) return;
  const id = stream.currentAssistantId || ensureAssistant(stream, stream.currentAssistantText);
  stream.settleStreamingTail(id, { text: stream.currentAssistantText });
}

export function settleStreamingTailAtClose(stream) {
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
