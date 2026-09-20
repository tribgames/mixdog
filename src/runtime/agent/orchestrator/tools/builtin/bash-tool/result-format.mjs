import { constants as osConstants } from 'node:os';
import { makeToolEnvelope } from '../../../session/tool-envelope.mjs';
import { getDestructiveCommandWarning } from '../../destructive-warning.mjs';
import { buildBashPolicyScanTargets } from '../../bash-policy-scan.mjs';

// A command that detaches work is never detected from its text — the text is
// not read at all. After the shell exits, the runner observes whether the
// command's process group / process tree still holds live processes and hands
// them over as a tracked task, so nothing runs without a task_id.
export const SURVIVING_DESCENDANTS_WARNING =
  '⚠️ the command finished but left descendants running: they are tracked as the task below, and `task cancel` terminates them.';
// Same observation, but the survivors can no longer be addressed by pid:
// Windows keeps a dangling parent id when an intermediate process exits, so a
// process re-parented that way is visible but not signalable from here.
export const SURVIVING_DESCENDANTS_UNREACHABLE_WARNING =
  '⚠️ the command finished but left a descendant running that this process can no longer signal (its parent exited and Windows keeps no live link to it). It stays tracked as the task below and its completion is reported, but `task cancel` may not be able to terminate it.';

/** Result lines for a command that leaves through the BACKGROUND path. The
 *  untracked-operator warning renders here too: every path a command can leave
 *  through carries it, not just the normal-completion block. */
export function _backgroundResultLines({ warning = null, taskBlock = null, message = '', partialOutput = '' } = {}) {
  return [warning || null, taskBlock, '', message, partialOutput ? `\n${partialOutput}` : ''].filter(
    (line) => line !== null && line !== ''
  );
}

export function getDedupedDestructiveWarnings(command) {
  const seenMsg = new Set();
  const warnings = [];
  for (const t of buildBashPolicyScanTargets(command)) {
    const w = getDestructiveCommandWarning(t);
    if (w && !seenMsg.has(w)) {
      seenMsg.add(w);
      warnings.push(w);
    }
  }
  return warnings;
}

export function _prependDestructiveWarning(command, text) {
  const warnings = getDedupedDestructiveWarnings(command);
  if (!warnings.length) return text;
  return `${warnings.map((w) => `⚠️ ${w}`).join('\n')}\n${text}`;
}

export function _placeDestructiveWarningsAfterStatus(command, text) {
  const warnings = getDedupedDestructiveWarnings(command);
  if (!warnings.length) return text;
  const warningBlock = warnings.map((w) => `⚠️ ${w}`).join('\n');
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return `${text}\n${warningBlock}`;
  return `${text.slice(0, firstBreak)}\n${warningBlock}${text.slice(firstBreak)}`;
}

export function formatShellToolFailure(message) {
  const text =
    String(message ?? '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'shell tool failed';
  return `Error: [shell-tool-failed] ${text}`;
}

// Every observed process completion keeps its `[exit code: N]` marker and is
// not a TOOL failure. The explicit-success envelope preserves that structural
// distinction even when command output itself starts with "Error:".
export function _finalizeShellResult(completedExit, text) {
  return completedExit ? makeToolEnvelope(text, [], { explicitSuccess: true }) : text;
}

export function _shellFailureStatus(result, timeout) {
  // Prefer the signal reported by the process. `killed` is only a fallback
  // for platforms (notably taskkill on Windows) that close without one.
  const signal = result.signal || (result.killed ? 'SIGKILL' : null);
  const exitCode = signal ? null : result.exitCode;
  const shellToolFailed = result.failurePhase === 'tool' || !!result.outputCaptureError;
  const killCause = result.killCause || null;
  const causeDetail = killCause ? ` cause: ${killCause}` : '';
  const signalDetail = signal ? ` signal: ${signal}` : '';
  const timeoutHint = result.timedOut ? ` — command killed after ${timeout} ms; partial effects may remain` : '';
  let statusDetail = '[missing exit status]';
  if (shellToolFailed) {
    const failure = result.outputCaptureError ? 'output capture failed' : result.failureReason || 'tool failed';
    statusDetail = `[${failure}${causeDetail}${signalDetail}]`;
  } else if (result.timedOut) {
    statusDetail = `[timeout: ${timeout}ms${signalDetail || ' signal: unknown'}${causeDetail}]${timeoutHint}`;
  } else if (signal) {
    statusDetail = `[signal: ${signal}${causeDetail}]`;
  } else if (Number.isInteger(exitCode)) {
    const diagnostic = exitCode !== 0 ? _exitClassDiagnostic(exitCode) : '';
    statusDetail = `[exit code: ${exitCode}]${diagnostic}`;
  }
  return { signal, exitCode, shellToolFailed, statusDetail };
}

// Deterministic POSIX exit-class facts only. Missing dependencies retain the
// command's original error without PATH probes or runtime suggestions.
const _SIGNAL_NAME_BY_NUMBER = new Map(
  Object.entries(osConstants.signals || {})
    .map(([name, num]) => [num, name])
    .reverse()
);
export function _exitClassDiagnostic(exitCode) {
  if (exitCode === 126) return ' — 126: command found but not executable (permission or format)';
  if (exitCode > 128 && exitCode < 165) {
    const name = _SIGNAL_NAME_BY_NUMBER.get(exitCode - 128);
    if (name) return ` — 128+${exitCode - 128}: terminated by ${name}`;
  }
  return '';
}

export function _composeShellFailure(statusMarker, errorPrefix, warningBlock, payload) {
  return `${errorPrefix}${statusMarker}${warningBlock ? `\n${warningBlock}` : ''}\n\n${payload}`;
}
