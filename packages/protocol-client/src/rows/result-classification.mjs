// Literal openings of the tool formatters' empty results (grep, glob, find_symbol, code_graph, list, read).
const ZERO_MATCH_PREFIXES = [
  '(no matches)',
  '(no files found)',
  '(no symbol matches',
  '(no symbols)',
  '(no references)',
  '(no callers)',
  '(no call sites)',
  '(no imports)',
  '(no dependents)',
  '(no entries match filter)',
  '(no lines in range',
];

const READ_ONLY_NAVIGATION_TOOLS = new Set(['find', 'glob', 'grep', 'list', 'read', 'code_graph']);

const NAVIGATION_MISS_RE =
  /\b(?:enoent|enotdir)\b|path does not exist|directory does not exist|no such (?:file|path)|not found at this path|file not found\b|symbol "[^"\n]*" not found in /i;

export function isReadOnlyNavigationMiss(toolName, result) {
  if (!READ_ONLY_NAVIGATION_TOOLS.has(String(toolName || '').toLowerCase())) return false;
  if (typeof result !== 'string') return false;
  if (/\b(?:eacces|eperm)\b|access is denied|permission denied|operation not permitted/i.test(result)) return false;
  return NAVIGATION_MISS_RE.test(result);
}

/**
 * Classifies a tool result string by its opening (after `trimStart`): `Error: …`, `Error [code N]:` and `[error …` are
 * errors, case-insensitively; the zero-match prefixes are exact. `explicitSuccess` is true only when the handler returned
 * `isError: false`.
 * @param {unknown} result
 * @param {boolean} [explicitSuccess=false]
 * @returns {'normal' | 'error' | 'zero-match'}
 */
export function classifyResultKind(result, explicitSuccess = false, toolName = '') {
  if (explicitSuccess === true) return 'normal';
  if (typeof result !== 'string') return 'normal';
  if (isReadOnlyNavigationMiss(toolName, result)) return 'zero-match';
  const trimmed = result.trimStart();
  if (/^error(?:\s+\[code\b|\s*:)/i.test(trimmed) || /^\[error/i.test(trimmed)) return 'error';
  for (const prefix of ZERO_MATCH_PREFIXES) {
    if (trimmed.startsWith(prefix)) return 'zero-match';
  }
  return 'normal';
}

/**
 * Shell TOOL/control-plane failure test. A completed process exit is not a
 * tool failure regardless of its exit code or output. Only tool markers and
 * interrupted execution (timeout/signal/abort) count.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function isShellFailureResult(result) {
  if (typeof result !== 'string') return false;
  const body = result.replace(/^(?:\s*⚠️[^\n]*\n)+/, '').trimStart();
  if (/^error:\s*\[shell-tool-failed\]/i.test(body)) return true;
  if (/^error:\s*\[shell-run-failed\]/i.test(body)) {
    const header = body.split('\n', 1)[0] || '';
    if (/\[exit code:/i.test(header) && !/\[timeout:|\[signal:|timed out|aborted|interrupted/i.test(header))
      return false;
    return true;
  }
  return /^\[(?:timeout:|signal:)/i.test(body);
}
