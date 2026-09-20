/**
 * card-detail.mjs — the collapsed `└ detail` row of a single tool card and
 * the agent brief it is gated by.
 */
import { AGENT_SURFACE_BRIEF_MAX, summarizeAgentSurfaceBrief } from '../tool-surface.mjs';
import { hasAgentResponseResult, isAgentTool } from './agent-surface.mjs';
import { backgroundTaskDetail } from './background-task.mjs';
import { genericCompletedDetail, shouldPrefixSyncElapsed } from './generic-detail.mjs';
import { mergeTerminalDetail, prefixElapsed } from './terminal-status.mjs';

function toolArgPathOf(parsedArgs) {
  return parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
}

/** The completed detail of every non-shell tool, first match wins. */
function nonShellDetail(base, surface, display, status, imageDetail) {
  const { pending, isError, elapsed } = base;
  const { normalizedName, label, parsedArgs, isShellSurface } = surface;
  const { resultSummary, hasResult, firstResultLine } = display;
  const { agentDetail, agentCompletionDetail, backgroundElapsed, backgroundMetadataHeaderFailure } = status;
  const genericDetail =
    !pending && !isShellSurface && !agentDetail && !imageDetail && !resultSummary
      ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
      : '';
  const backgroundMetadataDetail =
    display.isBackgroundMetadataResult && !backgroundMetadataHeaderFailure
      ? backgroundTaskDetail(display.backgroundMeta, backgroundElapsed, parsedArgs)
      : '';
  const backgroundResponseDetail =
    display.isBackgroundResponse && resultSummary ? prefixElapsed(resultSummary, backgroundElapsed) : resultSummary;
  const syncElapsedDetail =
    !display.isBackgroundResponse && shouldPrefixSyncElapsed(normalizedName, label)
      ? prefixElapsed(backgroundResponseDetail, elapsed)
      : backgroundResponseDetail;
  return (
    backgroundMetadataDetail ||
    (/^(Cancelled|Failed|Finished)$/i.test(resultSummary || '') && agentCompletionDetail
      ? agentCompletionDetail
      : syncElapsedDetail) ||
    agentDetail ||
    imageDetail ||
    genericDetail
  );
}

/** Agent cards only keep their detail row for failures; the brief replaces it. */
function agentDetailLine(base, { collapsedDetail, pendingDetailPlaceholder, agentSurfaceBrief, agentHeaderFailure }) {
  const { pending, isError, truncate, maxResultChars } = base;
  const agentDetailFallback = collapsedDetail || (pending ? pendingDetailPlaceholder || 'Running' : 'Finished');
  const line =
    agentSurfaceBrief || truncate(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
  const agentFailureText = /\b(Cancelled|Canceled|Failed)\b/i.test(agentSurfaceBrief || collapsedDetail || '');
  const keepAgentDetail = (isError || agentFailureText) && !(agentHeaderFailure && !agentSurfaceBrief);
  return keepAgentDetail ? line : '';
}

export function deriveCardDetail(base, surface, display, status) {
  const { name, pending, isError, elapsed, rt, truncate, maxResultChars } = base;
  const { normalizedName, parsedArgs, isShellSurface, isSkillSurface } = surface;
  const { resultSummary, hasDisplayResult, firstResultLine, displayedResultText } = display;
  const toolArgPath = toolArgPathOf(parsedArgs);
  const imageDetail = normalizedName === 'view_image' && toolArgPath && !isError ? String(toolArgPath) : '';
  const runningLabel = elapsed ? `Running · ${elapsed}` : 'Running';
  const pendingDetailPlaceholder = pending && !isSkillSurface ? runningLabel : '';
  const shellCollapsedSummary =
    isShellSurface && !pending && hasDisplayResult
      ? resultSummary || truncate(firstResultLine, Math.min(120, maxResultChars))
      : resultSummary;
  let collapsedDetail = mergeTerminalDetail(
    status.terminalStatus,
    nonShellDetail(base, surface, display, status, imageDetail)
  );
  if (pending) collapsedDetail = pendingDetailPlaceholder;
  else if (isShellSurface) {
    collapsedDetail = prefixElapsed(
      mergeTerminalDetail(status.shellStatus, shellCollapsedSummary),
      status.shellElapsed
    );
  }

  const isAgentResult = !display.isBackgroundResult && !pending && isAgentTool(normalizedName) && hasDisplayResult;
  const isAgentResponse = isAgentResult && hasAgentResponseResult(rt);
  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || '', { isError, isResponse: isAgentResponse })
    : '';
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncate(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : '';

  // Collapsed visible detail line (skill/agent gating identical to the TUI).
  let detailLine = collapsedDetail;
  if (isSkillSurface) {
    detailLine = isError && collapsedDetail ? collapsedDetail : '';
  } else if (display.isBackgroundMetadataResult && status.backgroundMetadataHeaderFailure) {
    detailLine = '';
  } else if (isAgentSurfaceCard) {
    detailLine = agentDetailLine(base, {
      collapsedDetail,
      pendingDetailPlaceholder,
      agentSurfaceBrief,
      agentHeaderFailure: status.agentHeaderFailure,
    });
  }

  return {
    toolArgPath,
    detailLine,
    detailIsPlaceholder: Boolean(pendingDetailPlaceholder) && detailLine === pendingDetailPlaceholder,
    shellCollapsedSummary,
    agentSurfaceBrief,
    isAgentSurfaceCard,
    isAgentResponse,
  };
}
