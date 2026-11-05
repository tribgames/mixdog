import { hasBenignExitOutcome } from '../tool-status.mjs';

// Only command result headers, not arbitrary lines in a patch, carry exits.
export function gitResultExitCode(text) {
  const match = /(?:^(?:## [^\n]+\n)?|\n## [^\n]+\n)exit ([1-9]\d*)\r?(?:\n|$)/.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

export function gitResultError(text) {
  return /(?:^|\n)error: command failed: [^\n]+|^error: [^\n]+/.exec(String(text ?? ''))?.[0].trim() || '';
}

// A tool error fails the call; a git process that ran and exited non-zero is
// a command exit, like the shell's, unless the tool marked the exit a signal.
export function gitTerminalStatus(text) {
  if (gitResultError(text)) return 'failed';
  if (gitResultExitCode(text) !== null && !hasBenignExitOutcome(text)) return 'exit';
  return '';
}
