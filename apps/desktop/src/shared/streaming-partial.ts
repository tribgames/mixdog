// The desktop paints a streamed reply before its line completes. The engine
// publishes the live row line-gated (`streamingTail`, what the terminal shows)
// and, beside it, the unfinished line (`streamingPartial`). This module is the
// one place that joins them; every desktop reader of the live row (renderer
// lanes, the remote streaming mailbox) goes through it.
import type { DesktopStreamingPartial, DesktopTranscriptItem } from './contract-session';

type LiveRowState = {
  readonly items?: readonly unknown[];
  readonly streamingTail?: unknown;
  readonly streamingPartial?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function partialOf(state: LiveRowState): DesktopStreamingPartial | null {
  const partial = record(state.streamingPartial);
  if (!partial || partial.id == null || typeof partial.text !== 'string' || !partial.text) return null;
  if (!Number.isSafeInteger(partial.from) || (partial.from as number) < 0) return null;
  return partial as DesktopStreamingPartial;
}

function settled(items: readonly unknown[] | undefined, id: unknown): boolean {
  if (!Array.isArray(items)) return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (record(items[index])?.id === id) return true;
  }
  return false;
}

// Unchanged fields keep their identity through every desktop hop, so one
// partial object maps to one joined row while its tail and items are the same.
const joined = new WeakMap<object, { tail: unknown; items: unknown; row: DesktopTranscriptItem | null }>();

/** The live row the desktop paints: the line-gated tail with the unfinished
 *  line appended when the partial continues exactly that tail, or the row the
 *  partial opens before its first completed line. Anything else (another row,
 *  a stale offset, a row that already settled) is the tail unchanged. */
export function streamingTailWithPartial(state: LiveRowState): DesktopTranscriptItem | null {
  const tail = record(state.streamingTail) as DesktopTranscriptItem | null;
  const partial = partialOf(state);
  if (!partial) return tail;
  const cached = joined.get(partial);
  if (cached && cached.tail === tail && cached.items === state.items) return cached.row ?? tail;
  let row: DesktopTranscriptItem | null = null;
  if (tail) {
    const text = typeof tail.text === 'string' ? tail.text : null;
    if (tail.id === partial.id && tail.kind === 'assistant' && text !== null && text.length === partial.from) {
      row = { ...tail, text: text + partial.text };
    }
  } else {
    const identity = record(partial.tail);
    if (partial.from === 0 && identity?.id === partial.id && partial.text.trim() && !settled(state.items, partial.id)) {
      row = { ...identity, kind: 'assistant', id: partial.id, streaming: true, text: partial.text };
    }
  }
  joined.set(partial, { tail, items: state.items, row });
  return row ?? tail;
}

/** The text `after` appends to `before` when both are the same unfinished
 *  line (same row, offset and row identity), else null — the wire then sends
 *  the whole partial. Wire contract shared with streamingPartialSuffix in
 *  src/standalone/session-state-patch.mjs (the daemon hop; that module needs
 *  node:crypto and cannot load in the renderer): the two must agree on every
 *  input, which the parity test in main/remote-streaming-mailbox.test.mjs
 *  pins. Change both together. */
export function streamingPartialSuffix(before: unknown, after: unknown): string | null {
  const left = record(before);
  const right = record(after);
  if (!left || !right) return null;
  const { text: leftText, ...leftRest } = left;
  const { text: rightText, ...rightRest } = right;
  if (typeof leftText !== 'string' || typeof rightText !== 'string') return null;
  if (rightText.length <= leftText.length || !rightText.startsWith(leftText)) return null;
  if (JSON.stringify(leftRest) !== JSON.stringify(rightRest)) return null;
  return rightText.slice(leftText.length);
}

/** `state` with its live row joined to the partial line; `state` itself when
 *  the partial changes nothing. */
export function withStreamingPartial<T extends LiveRowState>(state: T): T {
  const tail = streamingTailWithPartial(state);
  return tail === (record(state.streamingTail) ?? null) ? state : { ...state, streamingTail: tail };
}
