/**
 * displayed-result.mjs — which text of the tool result the collapsed card
 * actually shows: the background-task body over its envelope, never an
 * error-only body, with the leading status marker stripped.
 */
import { summarizeToolResult } from '../tool-surface.mjs';
import { isBackgroundErrorOnlyBody } from '../err-text.mjs';
import { isBackgroundTaskResponseArgs, isBackgroundTaskTool, resolveBackgroundTaskMeta } from './background-task.mjs';
import { stripLeadingStatusMarkerFromText } from './terminal-status.mjs';

export function resolveDisplayedResult(base, { normalizedName, parsedArgs }) {
  const { name, args, rt, pending, isError } = base;
  const isBackgroundTool = isBackgroundTaskTool(normalizedName);
  const backgroundMeta = !pending && isBackgroundTool ? resolveBackgroundTaskMeta(parsedArgs, rt || '') : null;
  const backgroundError = backgroundMeta?.error || parsedArgs?.error || '';
  const errorOnlyResult = Boolean(rt) && isBackgroundErrorOnlyBody(rt, backgroundError);
  const backgroundResultText = backgroundMeta?.hasResponse ? backgroundMeta.body : '';
  const displayedResultText = backgroundResultText || (errorOnlyResult ? '' : rt || '');
  const hasDisplayResult = Boolean(String(displayedResultText || '').trim());
  const displayedResultBodyText =
    normalizedName === 'git' ? displayedResultText : stripLeadingStatusMarkerFromText(displayedResultText);
  const hasDisplayBody = Boolean(String(displayedResultBodyText || '').trim());
  const lines = displayedResultBodyText ? displayedResultBodyText.split('\n') : [];
  const isBackgroundResult = !pending && isBackgroundTool && Boolean(backgroundMeta);
  const isBackgroundResponse =
    isBackgroundResult && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
  return {
    backgroundMeta,
    displayedResultText,
    hasDisplayResult,
    displayedResultBodyText,
    hasDisplayBody,
    totalLines: lines.length,
    resultSummary:
      !pending && (hasDisplayBody || normalizedName === 'git')
        ? summarizeToolResult(name, args, displayedResultBodyText, isError)
        : null,
    firstResultLine: hasDisplayResult ? String(lines[0] ?? '') : '',
    isBackgroundResult,
    isBackgroundResponse,
    isBackgroundMetadataResult: isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta),
  };
}
