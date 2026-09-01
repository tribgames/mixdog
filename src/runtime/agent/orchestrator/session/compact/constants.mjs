// Shared Compact constants. compact.mjs re-exports this small public surface.
import {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
} from '../context-utils.mjs';

export {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
};

export const SUMMARY_PREFIX_ANCHOR = 'A previous model worked on this task and produced the compacted handoff summary below.';
export const SUMMARY_PREFIX = `${SUMMARY_PREFIX_ANCHOR} Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. The summary covers the full session; only the latest real user instruction is attached after it.`;
export const SUMMARY_OUTPUT_TOKENS = 4_096;
// Unified context-share rule: every derived "how much of the model context
// may this budget take" ratio uses ONE number — 50%. Consumers:
//   - compact target budget (loop/compact-policy.mjs COMPACT_TARGET_RATIO)
//   - fresh-context handoff injection cap
// Keep them in lockstep; do not fork per-consumer ratios without a decision.
export const CONTEXT_SHARE_RATIO = 0.50;
export const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 90;
export const COMPACT_TARGET_MIN_TOKENS = 4_000;
export const COMPACT_SAFETY_PERCENT = 1.00;
// Floor for the handoff cap so small-context models still get a usable slice.
export const HANDOFF_TOKEN_CAP_FLOOR_TOKENS = 2_048;
// Minimum room the generated summary needs after the mandatory (system +
// preserved tail) cost is accounted for. When the configured target budget is
// smaller than the mandatory cost (e.g. the preserved recent turn carries a
// large tool result), the compaction MUST still proceed: the old head is the
// part being summarized away, so dropping it already shrinks the transcript.
// Refusing with "exceeds budget" here is what surfaced as auto-clear / overflow
// compact failures. Floor the working budget to mandatory + this room instead.
export const COMPACT_SUMMARY_MIN_ROOM_TOKENS = 4_000;

export function compactDebugEnabled() {
    return String(process.env.MIXDOG_COMPACT_DEBUG || '').trim() === '1';
}

export function compactDebugLog(scope, details = {}) {
    if (!compactDebugEnabled()) return;
    try {
        process.stderr.write(`[compact] ${scope} ${JSON.stringify(details)}\n`);
    } catch { /* best-effort diagnostics only */ }
}
