/**
 * gemini-reasoning-relay.mjs — the thought-summary relay of one Gemini send.
 *
 * Thought text streams to the caller's `onReasoningDelta`. A stream that is
 * re-issued (retry, empty-answer re-ask, non-streaming recovery) would show
 * its thinking twice, so before each new attempt the thinking already shown
 * is retracted through `onTextReset` — reasoning only, no answer text, which
 * the loop's own replay retraction also accepts without an owner ack.
 */
export function createGeminiReasoningRelay(opts) {
  let relayed = false;
  return {
    // Relayed through opts so the callback keeps its original receiver.
    onReasoningDelta:
      typeof opts?.onReasoningDelta === 'function'
        ? (text) => {
            relayed = true;
            opts.onReasoningDelta(text);
          }
        : null,
    retract() {
      if (!relayed) return;
      relayed = false;
      if (typeof opts?.onTextReset !== 'function') return;
      try {
        Promise.resolve(opts.onTextReset({ chars: 0, reasoning: true, reason: 'gemini-stream-retry' })).catch(() => {});
      } catch {}
    },
  };
}
