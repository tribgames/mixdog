/**
 * repl/stream-sink.mjs — the live assistant stream for one REPL turn: batched
 * stdout writes, the accumulated streamed text, the "where is the cursor"
 * flags the tool cards and the final re-render depend on, and the erase used
 * to replace the raw stream with rendered markdown.
 */
import { colorEnabled } from '../ui/ansi.mjs';

const STREAM_WRITE_BATCH_MS = 8;

/**
 * Erase the raw streamed assistant block so we can re-print it as markdown.
 * Computes how many terminal rows the streamed text + tool-card lines consumed.
 * Conservative: if the math is off we still leave a readable transcript.
 */
export function eraseStreamedBlock(out, streamedText) {
  const cols = out.columns && out.columns > 0 ? out.columns : 80;
  let rows = 0;
  for (const seg of String(streamedText).split('\n')) {
    rows += Math.max(1, Math.ceil((seg.length || 1) / cols));
  }
  // Move to column 0, then for each consumed row move up and clear it.
  out.write('\r');
  for (let i = 0; i < rows; i++) {
    out.write('\x1b[2K'); // clear current line
    if (i < rows - 1) out.write('\x1b[1A'); // cursor up
  }
  out.write('\r');
}

export function createStreamSink({ out, batchMs = STREAM_WRITE_BATCH_MS }) {
  const state = {
    streamedText: '',
    streamedChunks: [],
    streamedTextDirty: false,
    printedAny: false,
    printedToolCard: false,
    // After the blank line emitted at turn start, the cursor sits at a fresh
    // line start. Track this so tool cards don't insert extra blank-line
    // "pops": a leading newline is only needed to break away from
    // un-terminated streamed text, never between consecutive cards.
    atLineStart: true,
    pendingChunks: [],
    flushTimer: null,
    writeError: null,
  };

  function currentText() {
    if (!state.streamedTextDirty) return state.streamedText;
    state.streamedText = state.streamedChunks.join('');
    state.streamedChunks = state.streamedText ? [state.streamedText] : [];
    state.streamedTextDirty = false;
    return state.streamedText;
  }

  function flush() {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.writeError) {
      const error = state.writeError;
      state.writeError = null;
      throw error;
    }
    if (state.pendingChunks.length === 0) return;
    const text = state.pendingChunks.join('');
    state.pendingChunks = [];
    out.write(text);
  }

  function queueChunk(chunk) {
    if (state.writeError) throw state.writeError;
    state.pendingChunks.push(chunk);
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      try {
        flush();
      } catch (error) {
        state.writeError = error;
      }
    }, batchMs);
    state.flushTimer.unref?.();
  }

  function pushDelta(chunk) {
    state.printedAny = true;
    state.streamedChunks.push(chunk);
    state.streamedTextDirty = true;
    queueChunk(chunk);
    state.atLineStart = chunk.endsWith('\n');
  }

  async function writeToolCard(render) {
    flush();
    state.printedToolCard = true;
    const lead = state.atLineStart ? '' : '\n';
    out.write(`${lead + (await render())}\n`);
    state.atLineStart = true;
  }

  /** Drop the last `chars` streamed characters from the screen; false when refused. */
  function resetTail({ chars } = {}) {
    const count = Math.max(0, Number(chars) || 0);
    if (!count || !colorEnabled() || state.printedToolCard) return false;
    flush();
    const streamedText = currentText();
    const remaining = streamedText.slice(0, Math.max(0, streamedText.length - count));
    eraseStreamedBlock(out, streamedText);
    state.streamedText = remaining;
    state.streamedChunks = remaining ? [remaining] : [];
    state.streamedTextDirty = false;
    if (remaining) out.write(remaining);
    state.printedAny = !!remaining;
    state.atLineStart = !remaining || remaining.endsWith('\n');
    return true;
  }

  return {
    flush,
    pushDelta,
    writeToolCard,
    resetTail,
    currentText,
    printedAny: () => state.printedAny,
    printedToolCard: () => state.printedToolCard,
  };
}
