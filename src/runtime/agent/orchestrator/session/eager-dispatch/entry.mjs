// One eager entry: wait for its barriers, execute the tool, and surface the
// settlement to the UI the instant it lands (call-order history is written
// later by the serial result loop).
import { _isReadTool } from '../loop/tool-classify.mjs';
import { captureReadCacheState } from '../read-dedup.mjs';
import { normalizeToolEnvelope } from '../tool-envelope.mjs';

// EARLY UI-ONLY NOTIFY (completion-order, NOT history).
// The serial result-collection loop `await`s each
// eager promise strictly in CALL order, so a fast call[1]
// that settles before a slow call[0] cannot surface its
// tool card completion until call[0] resolves. Fire
// onToolResult here — the instant THIS eager tool settles —
// so parallel cards complete independently in the order they
// actually finish.
//
// This message is NOT pushed into `messages`: provider
// history ordering stays exactly call-order. The serial loop
// still builds the REAL tool_result and pushes it via
// pushToolResultMessage (which fires onToolResult AGAIN for
// the same toolCallId in call order — the TUI dedupes by id,
// so the duplicate notify is harmless). __earlyNotify marks
// this as the pre-history, UI-only signal.
//
// Only genuinely-executed eager promises reach here:
// startEagerTool never creates an entry for dedup /
// repeat-failure-guard / pre-dispatch-deny / invalid-args
// calls, so those `continue`-before-execution stub paths can
// never early-notify (contract #5).
function notifyEarlyResult(call, entry, settled, opts) {
  try {
    // UI-only: surface the model-VISIBLE result (envelope
    // stub for envelope returns), never the envelope object
    // or its injected newMessages body — no [object Object],
    // no full skill body in the tool card.
    let content;
    if (settled?.ok) {
      const visible = normalizeToolEnvelope(settled.value).result;
      content = visible == null ? '' : String(visible);
    } else {
      const failure = settled && settled.error instanceof Error ? settled.error.message : String(settled?.error);
      content = `Error: ${failure}`;
    }
    opts.onToolResult?.({
      role: 'tool',
      toolCallId: call.id,
      content,
      isError: !settled?.ok,
      __earlyNotify: true,
      toolTiming: {
        dispatchStartedAt: entry.dispatchStartedAt,
        executionStartedAt: entry.executionStartedAt ?? entry.endedAt,
        executionCompletedAt: entry.endedAt,
      },
    });
  } catch {
    /* best-effort — UI notify must never break the eager path */
  }
}

export function createEagerEntry({ mutationEpoch }) {
  const dispatchedAt = Date.now();
  return {
    startedAt: dispatchedAt,
    dispatchStartedAt: dispatchedAt,
    executionStartedAt: null,
    endedAt: null,
    mutationEpoch,
    readCacheState: null,
    localSearchTelemetry: {},
    resultTelemetry: {},
  };
}

/** The entry's settlement promise: { ok, value } / { ok, skipped, value } / { ok: false, error }. */
export function runEagerEntry({ call, entry, preceding, waitForPreceding, execute, opts, sessionId, cwd }) {
  return (async () => {
    try {
      const skipped = await waitForPreceding(call, preceding);
      if (skipped) return skipped;
      await opts.beforeToolExecution?.();
      if (sessionId && _isReadTool(call.name)) {
        entry.readCacheState = captureReadCacheState({ args: call.arguments, cwd });
      }
      entry.executionStartedAt = Date.now();
      return { ok: true, value: await execute(call, entry) };
    } catch (error) {
      return { ok: false, error };
    }
  })().then((settled) => {
    entry.endedAt = Date.now();
    notifyEarlyResult(call, entry, settled, opts);
    // The intra-turn dedup sig is intentionally NOT cleared here — see
    // admission.mjs. It must outlive promise settlement so a later same-turn
    // streaming duplicate stays blocked until the turn boundary recreates
    // the Map.
    return settled;
  });
}
