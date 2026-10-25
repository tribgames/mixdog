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

// The command's destructive warnings as ⚠️ lines, or '' when it has none.
function destructiveWarningBlock(command) {
  return getDedupedDestructiveWarnings(command)
    .map((w) => `⚠️ ${w}`)
    .join('\n');
}

export function _prependDestructiveWarning(command, text) {
  const warningBlock = destructiveWarningBlock(command);
  if (!warningBlock) return text;
  return `${warningBlock}\n${text}`;
}

export function _placeDestructiveWarningsAfterStatus(command, text) {
  const warningBlock = destructiveWarningBlock(command);
  if (!warningBlock) return text;
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
  const timeoutHint = result.timedOut ? ' — command killed; partial effects may remain' : '';
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

const _PS_UNIX_EQUIVALENTS = {
  head: 'Select-Object -First N',
  tail: 'Select-Object -Last N',
  wc: 'Measure-Object -Line',
  grep: 'the grep tool',
  sed: 'the edit tool',
  awk: 'ForEach-Object / the edit tool',
  pgrep: 'Get-Process -Name <name>',
};

// One-line PowerShell equivalent for a failed command whose stderr is the
// shell's own "bash-ism" error. Only ever appended to an already failed run.
// Detection is locale-independent: the command text plus the error record's
// structural markers, never the localized message prose. PowerShell keeps these
// in English under any UI language: the `ParserError:` header or the
// `RedirectionNotSupported`/`MissingFileSpecification` ids for parse failures,
// and for a missing command either `ObjectNotFound: (name:String)` (detailed
// view) or a `name:` header followed by the quoted `'name'` (concise view).
function _missingCommandNames(err) {
  const names = /\bCommandNotFoundException\b/.test(err)
    ? [...err.matchAll(/\bObjectNotFound: \(([\w.-]+):String\)/g)].map((m) => m[1])
    : [];
  for (const m of err.matchAll(/^([\w.-]+): ?\r?\n?((?:.*\r?\n){0,4})/gm)) {
    if (m[2].includes(`'${m[1]}'`)) names.push(m[1]);
  }
  return names;
}

export function _powershellBashismHint(command, stderr) {
  if (process.platform !== 'win32') return '';
  const err = String(stderr || '');
  const cmd = String(command || '');
  const parserRejected = /^ParserError:|\b(?:RedirectionNotSupported|MissingFileSpecification)\b/m.test(err);
  if (/<\s*\/dev\/null/.test(cmd) && parserRejected) {
    return 'hint: PowerShell has no `<` redirection; drop </dev/null.';
  }
  if (/<<-?\s*['"]?\w+/.test(cmd) && parserRejected) {
    return "hint: PowerShell has no heredoc; use @'\\n…\\n'@ | python - (or node -).";
  }
  if (/2>\s*\/dev\/null/.test(cmd) && /dev\\null/i.test(err)) return 'hint: use 2>$null in PowerShell.';
  for (const name of _missingCommandNames(err)) {
    const key = name.toLowerCase();
    if (Object.hasOwn(_PS_UNIX_EQUIVALENTS, key) && new RegExp(`(^|[\\s|;&(])${key}(\\s|$)`).test(cmd)) {
      return `hint: no \`${key}\` in PowerShell; use ${_PS_UNIX_EQUIVALENTS[key]}.`;
    }
  }
  return '';
}

export function _composeShellFailure(statusMarker, errorPrefix, warningBlock, payload) {
  return `${errorPrefix}${statusMarker}${warningBlock ? `\n${warningBlock}` : ''}\n\n${payload}`;
}
