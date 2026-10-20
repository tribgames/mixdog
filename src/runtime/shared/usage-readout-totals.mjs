// Session-cumulative figures behind the composer's usage readout, kept on the
// session record (`session.usageReadout`) so they survive restart, reload and
// compaction. One fold per model call of the session itself; calls of other
// sessions (delegated sub-agents have their own records) never enter.
//
// - cache hit = cacheRead / (input + cacheRead + cacheWrite) over every call
//   whose prompt was measured. A call that could not measure its prompt
//   (promptKnown === false) has unknown zeros, so it adds nothing.
// - speed = output tokens over generation ms (first visible token → end of the
//   response) of the calls long enough to time. A reply too short says nothing
//   about the model's speed, so each call is held to the floors below BEFORE it
//   is summed.
// - total tokens = input + cacheRead + cacheWrite + output, from the same sums.
export const MIN_SPEED_OUTPUT_TOKENS = 20;
export const MIN_SPEED_MS = 500;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The zeroed totals record. */
export function emptyUsageReadout() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, speedOutputTokens: 0, speedMs: 0 };
}

/**
 * Fold one `onUsageDelta` event (and the call's generation ms, 0 when it was
 * not timed) into the totals; returns a new record, never mutates `totals`.
 * Providers differ on whether input counts cache; the prompt total does not,
 * so fresh input is the prompt less its cache read/write.
 */
export function foldUsageReadout(totals, delta = {}, generationMs = 0) {
  const base = totals || emptyUsageReadout();
  const next = { ...base };
  if (delta.promptKnown !== false) {
    const cacheRead = num(delta.deltaCachedRead);
    const cacheWrite = num(delta.deltaCacheWrite);
    const prompt = num(delta.deltaPrompt) || num(delta.deltaInput) + cacheRead + cacheWrite;
    next.input = num(base.input) + Math.max(0, prompt - cacheRead - cacheWrite);
    next.cacheRead = num(base.cacheRead) + cacheRead;
    next.cacheWrite = num(base.cacheWrite) + cacheWrite;
  }
  const output = num(delta.deltaOutput);
  // Every call's output enters the session's total tokens, timed or not. A
  // record saved before the field existed has no output sum to extend, and a
  // partial one would pass for the whole: it stays without until the session
  // starts over.
  if (Number.isFinite(base.output)) next.output = base.output + output;
  const ms = num(generationMs);
  if (ms >= MIN_SPEED_MS && output >= MIN_SPEED_OUTPUT_TOKENS) {
    next.speedOutputTokens = num(base.speedOutputTokens) + output;
    next.speedMs = num(base.speedMs) + ms;
  }
  return next;
}
