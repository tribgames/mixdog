// Facade for the single fresh-context Compact contract.
//
// Default auto-compact trigger sits below the effective compact boundary by a
// compaction buffer (10% of boundary, capped at MAX_COMPACTION_BUFFER_RATIO).
// That headroom lets Compact run before the transcript reaches the hard limit.
// Operators may still tune the buffer through compaction.bufferTokens /
// bufferPercent / bufferRatio.
export {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
    SUMMARY_PREFIX,
    SUMMARY_OUTPUT_TOKENS,
    CONTEXT_SHARE_RATIO,
    DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
    COMPACT_TARGET_MIN_TOKENS,
    COMPACT_SAFETY_PERCENT,
    HANDOFF_TOKEN_CAP_FLOOR_TOKENS,
    COMPACT_SUMMARY_MIN_ROOM_TOKENS,
} from './compact/constants.mjs';

export { redactToolCallSecretsInMessages } from './compact/text-utils.mjs';

export {
    effectiveBudget,
    pruneToolOutputs,
    pruneToolOutputsUnanchored,
} from './compact/budget.mjs';

export {
    generateFreshHandoffSummary,
    freshContextCompactMessages,
} from './compact/runner.mjs';
