// Session-cumulative figures behind the composer's usage readout, kept on the
// session record (`session.usageReadout`) so they survive restart, reload and
// compaction. One fold per model call of the session itself; calls of other
// sessions (delegated sub-agents have their own records) never enter.
//
// - cache hit = cacheRead / (input + cacheRead + cacheWrite) over every call
//   whose prompt was measured. A call that could not measure its prompt
//   (promptKnown === false) has unknown zeros, so it adds nothing.
// - speed = output tokens over request ms (provider request start → end of the
//   response, the wait for the first token included: the same wall time as the
//   usage ledger's `duration_ms`) of every call with positive output and
//   positive duration: the same eligibility as the usage ledger and the usage
//   dialog, so the readout and the dialog agree. Records saved before this
//   definition carry `speedOutputTokens` / `speedMs` (first visible token →
//   end); they are kept as they are and read only while no request-timed call
//   has landed.
// - total tokens = input + cacheRead + cacheWrite + output, from the same sums.

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The zeroed totals record. */
export function emptyUsageReadout() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requestOutputTokens: 0, requestMs: 0 };
}

/**
 * Fold one `onUsageDelta` event (and the call's request ms, 0 when it was
 * not timed) into the totals; returns a new record, never mutates `totals`.
 * Providers differ on whether input counts cache; the prompt total does not,
 * so fresh input is the prompt less its cache read/write.
 */
export function foldUsageReadout(totals, delta = {}, requestMs = 0) {
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
  const ms = num(requestMs);
  if (ms > 0 && output > 0) {
    next.requestOutputTokens = num(base.requestOutputTokens) + output;
    next.requestMs = num(base.requestMs) + ms;
  }
  return next;
}
