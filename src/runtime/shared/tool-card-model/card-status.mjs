/**
 * card-status.mjs — the terminal status of a single tool card and the
 * status-derived fragments (shell status, header failure, agent completion)
 * the detail and header rows are built from.
 */
import { backgroundTaskFailureStatusLabel } from '../err-text.mjs';
import { agentTerminalDetail, isAgentTool } from './agent-surface.mjs';
import { backgroundTaskElapsed, backgroundTaskFailureDetail, isBackgroundTaskTool } from './background-task.mjs';
import { shellDisplayStatus } from './shell-surface.mjs';
import { normalizeTerminalStatus, resultControlStatus, resultEnvelopeStatus, shellResultElapsed } from './terminal-status.mjs';
import { mediaTerminalStatus } from './media-result.mjs';
import { gitTerminalStatus } from './git-result.mjs';
import { isUserControlCancellation } from '../tool-status.mjs';

// Tools whose result opens with a task/bridge envelope that reports the call's status.
const ENVELOPE_STATUS_TOOLS = new Set(['agent', 'bridge', 'task', 'web_search', 'search_query', 'image_query', 'web_search_call']);

function shellFragments(base, display, isShellSurface) {
  if (!isShellSurface) return { shellStatus: '', shellElapsed: '' };
  const { pending, failedCount, exitFailedCount, isError, elapsed } = base;
  return {
    shellStatus: shellDisplayStatus({
      pending,
      failedCount,
      exitFailedCount,
      isError,
      result: display.displayedResultText,
    }),
    shellElapsed: shellResultElapsed(display.displayedResultText) || elapsed,
  };
}

function backgroundElapsedFor(base, display, normalizedName, parsedArgs) {
  if (display.backgroundMeta) return backgroundTaskElapsed(display.backgroundMeta, base.elapsed);
  if (isBackgroundTaskTool(normalizedName)) return backgroundTaskElapsed(parsedArgs, base.elapsed);
  return '';
}

/** Failures that replace the detail row with a header status word. */
function headerFailures(base, display, normalizedName, parsedArgs) {
  const { pending, isError } = base;
  const backgroundMetadataFailureLabel = display.isBackgroundMetadataResult
    ? backgroundTaskFailureDetail(display.backgroundMeta, parsedArgs)
    : '';
  const backgroundMetadataHeaderFailure =
    backgroundMetadataFailureLabel && !display.hasDisplayResult ? backgroundMetadataFailureLabel : '';
  const agentHeaderFailure =
    !pending && isAgentTool(normalizedName) && isError && parsedArgs?.error && !display.hasDisplayResult
      ? backgroundTaskFailureStatusLabel(parsedArgs?.status, parsedArgs?.error, { surface: 'agent' })
      : '';
  return { backgroundMetadataHeaderFailure, agentHeaderFailure };
}

export function deriveCardStatus(base, { normalizedName, parsedArgs, isShellSurface }, display) {
  const { pending, isError, elapsed, failedCount } = base;
  const { shellStatus, shellElapsed } = shellFragments(base, display, isShellSurface);
  const { backgroundMetadataHeaderFailure, agentHeaderFailure } = headerFailures(
    base,
    display,
    normalizedName,
    parsedArgs
  );
  const agentCompletionDetail =
    !pending && isAgentTool(normalizedName) && !agentHeaderFailure
      ? agentTerminalDetail(parsedArgs?.status, isError, elapsed, parsedArgs?.error)
      : '';
  const gitStatus = normalizedName === 'git' ? gitTerminalStatus(display.displayedResultText) : '';
  const callFailed = !pending && (isError || failedCount > 0);
  // A reported "completed" never outranks a failed call; every other
  // reported outcome (cancelled, denied, failed) still describes the call.
  const reported = (value) => {
    const status = normalizeTerminalStatus(value);
    return callFailed && status === 'completed' ? '' : status;
  };
  const failedOrCompleted = callFailed ? 'failed' : 'completed';
  const envelopeStatus = ENVELOPE_STATUS_TOOLS.has(normalizedName)
    ? resultEnvelopeStatus(display.displayedResultText)
    : '';
  const terminalStatus = pending
    ? 'running'
    : shellStatus ||
      gitStatus ||
      (normalizedName === 'media' ? mediaTerminalStatus(parsedArgs, display.displayedResultText) : '') ||
      reported(display.backgroundMeta?.status) ||
      reported(parsedArgs?.status) ||
      reported(envelopeStatus) ||
      resultControlStatus(display.displayedResultText) ||
      // A one-line error body is hidden from display, so read the raw result.
      (isUserControlCancellation(base.rt) ? 'cancelled' : '') ||
      failedOrCompleted;
  return {
    shellStatus,
    shellElapsed,
    backgroundElapsed: backgroundElapsedFor(base, display, normalizedName, parsedArgs),
    backgroundMetadataHeaderFailure,
    agentHeaderFailure,
    headerFailureText: backgroundMetadataHeaderFailure || agentHeaderFailure || '',
    agentCompletionDetail,
    agentDetail: !pending && isAgentTool(normalizedName) && !display.hasDisplayResult ? agentCompletionDetail : '',
    terminalStatus,
    callFailed,
  };
}
