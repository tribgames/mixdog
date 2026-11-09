/**
 * displayed-result.mjs — which text of the tool result the collapsed card
 * actually shows: the background-task body over its envelope, never an
 * error-only body, with the leading status marker stripped.
 */
import { summarizeToolResult } from '../tool-surface.mjs';
import { isBackgroundErrorOnlyBody } from '../err-text.mjs';
import { isUserControlCancellation } from '../tool-status.mjs';
import { isBackgroundTaskResponseArgs, isBackgroundTaskTool, resolveBackgroundTaskMeta } from './background-task.mjs';
import { stripLeadingStatusMarkerFromText } from './terminal-status.mjs';
import { readRowsForDisplay } from '../read-row-numbers.mjs';

export function resolveDisplayedResult(base, { normalizedName, parsedArgs }, translate) {
  const { name, args, rt, pending, isError } = base;
  const isBackgroundTool = isBackgroundTaskTool(normalizedName);
  const backgroundMeta = !pending && isBackgroundTool ? resolveBackgroundTaskMeta(parsedArgs, rt || '') : null;
  const backgroundError = backgroundMeta?.error || parsedArgs?.error || '';
  // Only a real background envelope's bare error line is redundant with its
  // failure label; any other tool's error body is the cause the card shows.
  const errorOnlyResult =
    Boolean(rt) &&
    ((Boolean(backgroundMeta) && isBackgroundErrorOnlyBody(rt, backgroundError)) || isUserControlCancellation(rt));
  const backgroundResultText = backgroundMeta?.hasResponse ? backgroundMeta.body : '';
  const displayedResultText = backgroundResultText || (errorOnlyResult ? '' : rt || '');
  const hasDisplayResult = Boolean(String(displayedResultText || '').trim());
  let displayedResultBodyText =
    normalizedName === 'git' ? displayedResultText : stripLeadingStatusMarkerFromText(displayedResultText);
  if (normalizedName === 'read') displayedResultBodyText = readRowsForDisplay(displayedResultBodyText);
  const hasDisplayBody = Boolean(String(displayedResultBodyText || '').trim());
  const lines = displayedResultBodyText ? displayedResultBodyText.split('\n') : [];
  const isBackgroundResult = !pending && isBackgroundTool && Boolean(backgroundMeta);
  const isBackgroundResponse =
    isBackgroundResult && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
  const summarize = (localize) =>
    !pending && (hasDisplayBody || normalizedName === 'git')
      ? summarizeToolResult(name, args, displayedResultBodyText, isError, localize)
      : null;
  return {
    backgroundMeta,
    displayedResultText,
    hasDisplayResult,
    displayedResultBodyText,
    hasDisplayBody,
    totalLines: lines.length,
    resultSummary: summarize(),
    ...(translate ? { resultSummaryDisplay: summarize(translate) } : {}),
    firstResultLine: hasDisplayResult ? String(lines[0] ?? '') : '',
    isBackgroundResult,
    isBackgroundResponse,
    isBackgroundMetadataResult: isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta),
  };
}
