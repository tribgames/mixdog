import { formatToolSurface } from './tool-surface.mjs';
import { pluralize, toolCallDisplayIdentity } from './tool-primitives.mjs';
import { deriveAggregateCardModel } from './tool-card-model/aggregate-card.mjs';
import { isShellTool } from './tool-card-model/shell-surface.mjs';
import { SKILL_SURFACE_NAMES } from './tool-card-model/agent-surface.mjs';
import { commonCardFields, readCardInput } from './tool-card-model/card-input.mjs';
import { resolveDisplayedResult } from './tool-card-model/displayed-result.mjs';
import { deriveCardStatus } from './tool-card-model/card-status.mjs';
import { deriveCardDetail } from './tool-card-model/card-detail.mjs';
import { deriveCardHeader } from './tool-card-model/card-header.mjs';

export {
  HEADER_FAILURE_STATUS_MAX,
  MIN_RESULT_LINE_CHARS,
  normalizeCountMap,
  RESULT_LINE_HARD_MAX,
  safeInlineText,
  splitLineDeltaTokens,
  SUMMARY_MAX_CHARS,
} from './tool-card-model/inline-text.mjs';
export {
  clampFailureCount,
  deriveToolOutcomeTone,
  displayTerminalStatus,
  mergeTerminalDetail,
  normalizeTerminalStatus,
  prefixElapsed,
  resultTerminalStatus,
  shellResultElapsed,
  shellResultStatus,
  stripLeadingStatusMarkerFromText,
  stripLeadingStatusMarkerLines,
} from './tool-card-model/terminal-status.mjs';
export { isShellTool, shellDisplayStatus, shellHeader } from './tool-card-model/shell-surface.mjs';
export {
  agentActionSummary,
  agentActionTitle,
  agentResponseTitle,
  agentTerminalDetail,
  hasAgentResponseResult,
  isAgentResponseResult,
  isAgentTool,
  SKILL_SURFACE_NAMES,
} from './tool-card-model/agent-surface.mjs';
export {
  backgroundTaskActionTitle,
  backgroundTaskDetail,
  backgroundTaskElapsed,
  backgroundTaskFailureDetail,
  backgroundTaskResultTitle,
  isBackgroundTaskResponseArgs,
  isBackgroundTaskTool,
  resolveBackgroundTaskMeta,
} from './tool-card-model/background-task.mjs';
export {
  bridgeDescribeResult,
  genericCompletedDetail,
  shouldPrefixSyncElapsed,
  toolSearchLoadedSummary,
} from './tool-card-model/generic-detail.mjs';
export { pluralize as plural };

/**
 * Derive the collapsed tool-card text model shared by every surface.
 *
 * Mirrors ToolExecution's derivation exactly; the TUI consumes this and adds
 * width fitting/colors, the desktop consumes this and adds CSS/ellipsis.
 *
 * @param {object} input Tool item fields (name/args/result/rawResult/isError/
 *   errorCount/callErrorCount/exitErrorCount/count/completedCount/startedAt/
 *   completedAt/aggregate/categories/doneCategories/headerFinalized/nowMs).
 * @param {object} options { truncate(text,width), maxResultChars }.
 */
export function deriveToolCardModel(input = {}, options = {}) {
  const identity = toolCallDisplayIdentity(input.name, input.args);
  const base = readCardInput({ ...input, name: identity.name, args: identity.args }, options);
  if (base.aggregate) return deriveAggregateCardModel(base);

  const { label, summary, normalizedName, args: parsedArgs } = formatToolSurface(base.name, base.args);
  const surface = {
    label,
    summary,
    normalizedName,
    parsedArgs,
    isShellSurface: isShellTool(normalizedName, label),
    isSkillSurface: SKILL_SURFACE_NAMES.has(String(normalizedName || '').toLowerCase()),
  };
  const display = resolveDisplayedResult(base, surface, options.translate);
  const status = deriveCardStatus(base, surface, display);
  const detail = deriveCardDetail(base, surface, display, status);
  const header = deriveCardHeader(base, surface, display, status, detail);

  return {
    aggregate: false,
    ...commonCardFields(base, status.terminalStatus),
    ...(identity.via ? { via: identity.via } : {}),
    labelText: header.labelText,
    summaryText: header.summaryText,
    headerFailureText: status.headerFailureText,
    detailLine: detail.detailLine,
    detailIsPlaceholder: detail.detailIsPlaceholder,
    hasDisplayResult: display.hasDisplayResult,
    hasDisplayBody: display.hasDisplayBody,
    displayedResultBodyText: display.displayedResultBodyText,
    firstResultLine: display.firstResultLine,
    totalLines: display.totalLines,
    resultSummary: display.resultSummary,
    ...(options.translate ? { resultSummaryDisplay: display.resultSummaryDisplay } : {}),
    shellCollapsedSummary: detail.shellCollapsedSummary,
    agentSurfaceBrief: detail.agentSurfaceBrief,
    toolArgPath: String(detail.toolArgPath || ''),
    normalizedName,
    label,
    parsedArgs,
    isShellSurface: surface.isShellSurface,
    isSkillSurface: surface.isSkillSurface,
    isAgentSurfaceCard: detail.isAgentSurfaceCard,
    isAgentResponse: detail.isAgentResponse,
    isBackgroundResponse: display.isBackgroundResponse,
    isBackgroundMetadataResult: display.isBackgroundMetadataResult,
    backgroundMeta: display.backgroundMeta,
  };
}
