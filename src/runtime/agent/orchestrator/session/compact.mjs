// Facade for the single fresh-context Compact contract.
//
// Main and agent auto-compaction default to 100% of the effective window.
// Rule-based rebuilding is the default; AI summarizes only the conversation
// part when its independent threshold is exceeded.
export {
  DEFAULT_COMPACTION_BUFFER_TOKENS,
  DEFAULT_COMPACTION_BUFFER_RATIO,
  MAX_COMPACTION_BUFFER_RATIO,
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
  conversationCompactionInput,
  generateFreshHandoffSummary,
  freshContextCompactMessages,
} from './compact/runner.mjs';
