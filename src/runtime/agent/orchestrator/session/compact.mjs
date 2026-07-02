// Facade for the compaction module. The god file was split into cohesive
// modules under session/compact/ (behavior-preserving); this file re-exports
// the identical public surface so every existing importer
// (loop.mjs, manager.mjs + subdirs, agent-runtime/session-builder.mjs,
// memory/index.mjs, scripts/compact-*.mjs) keeps working unchanged.
//
// Default auto-compact trigger sits below the effective compact boundary by a
// compaction buffer (10% of boundary, capped at MAX_COMPACTION_BUFFER_RATIO).
// That headroom lets semantic compact run before the transcript is already at
// the hard limit (zero buffer caused overflow_failed with no room to
// summarize). Operators may still set compaction.bufferTokens / bufferPercent /
// bufferRatio to tune headroom. Telemetry-persisted bufferTokens/bufferRatio of
// zero is not operator config; loop/manager strip it and reapply this default
// (see compactBufferConfigForBoundary).
export {
    DEFAULT_COMPACTION_BUFFER_TOKENS,
    DEFAULT_COMPACTION_BUFFER_RATIO,
    MAX_COMPACTION_BUFFER_RATIO,
    DEFAULT_COMPACTION_KEEP_TOKENS,
    normalizeCompactionBufferRatio,
    compactionBufferTokensForBoundary,
    SUMMARY_PREFIX,
    SUMMARY_OUTPUT_TOKENS,
    COMPACT_SUMMARY_MIN_ROOM_TOKENS,
    COMPACT_TYPE_SEMANTIC,
    COMPACT_TYPE_RECALL_FASTTRACK,
    DEFAULT_COMPACT_TYPE,
    COMPACT_TYPES,
    normalizeCompactType,
    compactTypeIsSemantic,
    compactTypeIsRecallFastTrack,
} from './compact/constants.mjs';

export { redactToolCallSecretsInMessages } from './compact/text-utils.mjs';

export {
    effectiveBudget,
    countRawPendingRows,
    drainSessionCycle1,
    pruneToolOutputs,
    pruneToolOutputsUnanchored,
} from './compact/budget.mjs';

export {
    buildRecallFastTrackQuery,
    splitRecallRootBlocks,
    fitRecallRootsMessage,
} from './compact/summary.mjs';

export {
    semanticCompactMessages,
    recallFastTrackCompactMessages,
} from './compact/engine.mjs';
