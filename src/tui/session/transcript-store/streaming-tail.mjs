/**
 * src/tui/session/transcript-store/streaming-tail.mjs - the streaming tail:
 * the assistant item that grows in place during a turn, with the text epoch
 * that lets a host prove a longer text is an append of the same stream.
 */
// Non-enumerable so the marker never enters persisted transcript items,
// live-share JSON, or renderer snapshots. The desktop host reads the shared
// Symbol.for key before cloning and uses it to prove that a growing text is
// an append, avoiding an O(total text) startsWith check on every frame.
const streamingTailTextEpochKey = Symbol.for('mixdog.streaming-tail-text-epoch');

export function createStreamingTailMutators({ draft, set }) {
  let streamingTailTextEpoch = 0;
  const updateStreamingTail = (id, patch = {}, extra = {}, { resetText = false } = {}) => {
    if (id == null) return false;
    const state = draft.state;
    const current =
      state.streamingTail?.id === id ? state.streamingTail : { kind: 'assistant', id, text: '', streaming: true };
    const next = { ...current, ...patch, kind: 'assistant', id, streaming: true };
    const currentTextEpoch = current[streamingTailTextEpochKey];
    const textEpoch =
      !resetText && Number.isSafeInteger(currentTextEpoch) ? currentTextEpoch : ++streamingTailTextEpoch;
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
    const tail = draft.state.streamingTail;
    if (!tail || (id != null && tail.id !== id)) {
      return set(extra);
    }
    return set({ streamingTail: null, ...extra });
  };

  return { updateStreamingTail, clearStreamingTail };
}
