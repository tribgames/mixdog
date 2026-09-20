// Only command result headers, not arbitrary lines in a patch, carry exits.
export function gitResultExitCode(text) {
  const match = /(?:^(?:## [^\n]+\n)?|\n## [^\n]+\n)exit ([1-9]\d*)\r?(?:\n|$)/.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

export function gitResultError(text) {
  return /(?:^|\n)error: command failed: [^\n]+|^error: [^\n]+/.exec(String(text ?? ''))?.[0].trim() || '';
}
