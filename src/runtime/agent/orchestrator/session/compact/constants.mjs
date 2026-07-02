// Shared compaction constants and compact-type helpers. Extracted verbatim
// from compact.mjs (behavior-preserving). compact.mjs re-exports the public
// members from here so the external surface is unchanged.
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

export const SUMMARY_PREFIX = 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it; treat the summary as authoritative context for continuing the task. You also retain the preserved recent turns that follow.';
export const SUMMARY_OUTPUT_TOKENS = 4_096;
// Minimum room the generated summary needs after the mandatory (system +
// preserved tail) cost is accounted for. When the configured target budget is
// smaller than the mandatory cost (e.g. the preserved recent turn carries a
// large tool result), the compaction MUST still proceed: the old head is the
// part being summarized away, so dropping it already shrinks the transcript.
// Refusing with "exceeds budget" here is what surfaced as auto-clear / overflow
// compact failures. Floor the working budget to mandatory + this room instead.
export const COMPACT_SUMMARY_MIN_ROOM_TOKENS = 4_000;

export const COMPACT_TYPE_SEMANTIC = 'semantic';
export const COMPACT_TYPE_RECALL_FASTTRACK = 'recall-fasttrack';
export const DEFAULT_COMPACT_TYPE = COMPACT_TYPE_SEMANTIC;
export const COMPACT_TYPES = Object.freeze([
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
]);

export function normalizeCompactType(value, fallback = DEFAULT_COMPACT_TYPE) {
    const raw = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
    if (!raw) return fallback;
    if (raw === '1' || raw === 'type1' || raw === 'type-1' || raw === 'bench1' || raw === 'bench-1' || raw === 'semantic' || raw === 'summary') {
        return COMPACT_TYPE_SEMANTIC;
    }
    // Recall fast-track aliases. `replace(/_/g,'-')` above already folds
    // snake_case (fast_track -> fast-track), but list both dash/no-dash forms
    // explicitly so callers passing either spelling resolve deterministically.
    if (raw === '2' || raw === 'type2' || raw === 'type-2' || raw === 'recall' || raw === 'recall-fast' || raw === 'recall-fasttrack' || raw === 'recall-fast-track' || raw === 'fasttrack' || raw === 'fast-track') {
        return COMPACT_TYPE_RECALL_FASTTRACK;
    }
    // Unknown / unrecognized value: fall back to the caller-provided default
    // (semantic by default). Callers that need to detect an unknown value
    // should compare the input against COMPACT_TYPES before normalizing.
    return fallback;
}

export function compactTypeIsSemantic(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_SEMANTIC;
}

export function compactTypeIsRecallFastTrack(value) {
    return normalizeCompactType(value) === COMPACT_TYPE_RECALL_FASTTRACK;
}

export function compactDebugEnabled() {
    return String(process.env.MIXDOG_COMPACT_DEBUG || '').trim() === '1';
}

export function compactDebugLog(scope, details = {}) {
    if (!compactDebugEnabled()) return;
    try {
        process.stderr.write(`[compact] ${scope} ${JSON.stringify(details)}\n`);
    } catch { /* best-effort diagnostics only */ }
}
