// compaction.summaryMode — which model writes a compaction summary
// (loop/fresh-context.mjs compactionSummaryPlan):
//   smart       warm prompt cache: fork the conversation's own cached request;
//               cold: the Maintainer, else the subscription provider's lighter
//               model, else the conversation's own model (isolated)
//   maintainer  the Maintainer (isolated), else the conversation's own model
//   self        the conversation's own model: fork when warm, isolated when cold
export const COMPACTION_SUMMARY_MODES = Object.freeze(['smart', 'maintainer', 'self']);

/** The saved mode; the previous release's boolean `useMaintainer:false`
 *  reads as 'self', true or absent as the 'smart' default. */
export function normalizeCompactionSummaryMode(compaction) {
  const mode = compaction?.summaryMode;
  if (COMPACTION_SUMMARY_MODES.includes(mode)) return mode;
  return compaction?.useMaintainer === false ? 'self' : 'smart';
}
