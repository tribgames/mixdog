/**
 * card-header.mjs — the header label and the parenthesized arg summary of
 * a single tool card.
 */
import { formatToolActionHeader, toolLoadingTargets } from '../tool-surface.mjs';
import { agentActionSummary, agentActionTitle, agentResponseTitle, isAgentTool } from './agent-surface.mjs';
import { backgroundTaskActionTitle, backgroundTaskResultTitle } from './background-task.mjs';
import { toolSearchLoadedSummary } from './generic-detail.mjs';
import { safeInlineText } from './inline-text.mjs';
import { shellHeader } from './shell-surface.mjs';

function headerLabel(base, surface, display, status, detail) {
  const { name, args, headerPending, groupCount } = base;
  const { normalizedName, parsedArgs, isShellSurface } = surface;
  if (detail.isAgentResponse) return agentResponseTitle(parsedArgs, groupCount);
  if (display.isBackgroundResponse) {
    return backgroundTaskResultTitle(normalizedName, display.backgroundMeta || parsedArgs);
  }
  if (display.isBackgroundMetadataResult) return backgroundTaskActionTitle(normalizedName, display.backgroundMeta);
  if (isShellSurface) return shellHeader(status.shellStatus, groupCount, parsedArgs?.verifyShell === true);
  return (
    (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '') ||
    formatToolActionHeader(name, args, { pending: headerPending, count: groupCount })
  );
}

export function deriveCardHeader(base, surface, display, status, detail) {
  const { pending, hasResult } = base;
  const { normalizedName, parsedArgs, summary } = surface;
  const labelText = safeInlineText(headerLabel(base, surface, display, status, detail));
  const toolSearchSummary =
    !pending && normalizedName === 'load_tool' && hasResult ? toolSearchLoadedSummary(display.displayedResultText) : '';
  let rawSummary = '';
  if (!detail.isAgentResponse && !display.isBackgroundResponse) {
    rawSummary = toolSearchSummary || (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary);
  }
  const rawSummaryText = safeInlineText(rawSummary);
  // Drop the parenthesized arg summary when it is a bare "<n> <unit>" count
  // that the header verb already spells out.
  const summaryIsHeaderCount =
    rawSummaryText && /^\d+\s+\S+$/.test(rawSummaryText) && labelText.endsWith(rawSummaryText);
  const loadingTargets = toolLoadingTargets(normalizedName, parsedArgs);
  const summaryIsLoadingTargets = loadingTargets.length > 0 && rawSummaryText === loadingTargets.join(', ');
  return {
    labelText,
    summaryText: summaryIsHeaderCount || summaryIsLoadingTargets ? '' : rawSummaryText,
  };
}
