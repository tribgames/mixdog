// The Node product's transcript-row helpers, ported verbatim from src/runtime (tool-work-units, tool-surface, tool-result-summary,
// tool-result-status, tool-status, tool-execution-contract and their dependencies). The row projection in ../rows.ts is their only
// caller; this file is the one typed entry (index.d.mts).
export { classifyToolCategory } from './tool-work-units.mjs';
export { STEP, aggregateDoneCategoriesSteps, aggregateToolCategoryEntries, isTaskWaitToolCall } from './tool-surface.mjs';
export {
  aggregateBucketForCategory,
  aggregateLoadingTargetsSteps,
  aggregateToolMembersSteps,
  aggregateRawResultSteps,
  aggregateResultPatchSteps,
  mergeAggregateCategoryEntries,
  stringUiDiffPatch,
  toolCallOutcome,
  toolResultDisplay,
  withCancelledResultMarker,
} from './tool-result-status.mjs';
export { isTranscriptHiddenControlToolName, isTranscriptHiddenToolItem } from './tool-execution-contract.mjs';
export { toolResultTerminalStatus } from './tool-status.mjs';
export { summarizeToolResult } from './tool-result-summary.mjs';
