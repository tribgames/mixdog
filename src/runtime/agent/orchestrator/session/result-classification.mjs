/**
 * result-classification.mjs — THE single conversion point from tool-return
 * string convention to structural kind in this codebase.
 *
 * Any new code that needs to classify a tool result string MUST use
 * classifyResultKind(). Inline prefix checks (`startsWith('Error:')`, etc.)
 * anywhere in src/ outside this file are a centralisation violation.
 *
 * Matches documented tool-return error conventions:
 *   "Error: ..."      — Node/MCP tool errors (grep, find_symbol, read, code_graph, etc.)
 *   "Error: [shell-tool-failed] ..." — shell tool/control-plane failure
 *   "Error: [shell-run-failed] ..."  — interrupted shell execution
 *   "Error [code N]:" — structured builtin tool errors
 *   "[error ..."      — bracketed error format
 *   "[exit code: ..." — normal completed shell command result
 *
 * Leading whitespace is stripped before testing (trimStart). Mid-body
 * occurrences of these patterns are NOT treated as errors — only the very
 * start of the string matters.
 *
 * Case sensitivity:
 *   - Error prefixes are case-INSENSITIVE (regex `/i` flag) — different
 *     callers and OS layers vary the casing (`Error:`, `error:`, `ERROR:`).
 *   - Zero-match prefixes are case-SENSITIVE (exact `startsWith`) — the
 *     documented formatters always emit lowercase parens; case variants
 *     would be a formatter bug, not a classification miss.
 *
 * Zero-match prefixes are exact strings from documented tool result
 * formatters (builtin.mjs / code-graph.mjs). No heuristics — only these literals:
 *   "(no matches)"          — grep                          (builtin.mjs:4137)
 *   "(no files found)"      — glob                          (builtin.mjs)
 *   "(no symbol matches"    — find_symbol declaration        (code-graph.mjs:1135)
 *   "(no symbols)"          — find_symbol symbols/overview   (code-graph.mjs:724, 1594)
 *   "(no references)"       — find_symbol references         (code-graph.mjs:982, 1029)
 *   "(no callers)"          — find_symbol callers            (code-graph.mjs:1210, 1219, 1243, 1261)
 *   "(no call sites)"       — find_symbol callers w/ non-call refs (code-graph.mjs:1281)
 *   "(no imports)"          — find_symbol imports            (code-graph.mjs:1565)
 *   "(no dependents)"       — find_symbol dependents         (code-graph.mjs:1577)
 *   "(no entries match filter)" — list default mode w/ filter (builtin.mjs:4446)
 *   "(no lines in range"    — read offset out-of-range       (builtin.mjs:739, 3571)
 *
 * @param {unknown} result
 * @param {boolean} [explicitSuccess=false] true only when the tool handler
 * explicitly returned `isError: false`
 * @returns {'normal' | 'error' | 'zero-match'}
 */
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

const READ_ONLY_NAVIGATION_TOOLS = new Set([
    'find', 'glob', 'grep', 'list', 'read', 'code_graph',
]);

const NAVIGATION_MISS_RE = /\b(?:enoent|enotdir)\b|path does not exist|directory does not exist|no such (?:file|path)|not found at this path|file not found in graph/i;

export function isReadOnlyNavigationMiss(toolName, result) {
    if (!READ_ONLY_NAVIGATION_TOOLS.has(String(toolName || '').toLowerCase())) return false;
    if (typeof result !== 'string') return false;
    if (/\b(?:eacces|eperm)\b|access is denied|permission denied|operation not permitted/i.test(result)) return false;
    return NAVIGATION_MISS_RE.test(result);
}

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
 * Informational shell exit-1: `Error: [shell-run-failed] [exit code: 1]`
 * with a non-empty stdout body and NO stderr evidence (neither an inline
 * `[stderr]` block nor a `[stderr: path]` spill). grep-family "no match"
 * semantics inside compound probes (loops, `;`-chains, substitutions) land
 * exactly here: the run produced useful output, wrote nothing to stderr,
 * and exited 1 only because the final stage matched nothing. The static
 * single-pipeline gate (bash-tool _isBenignSearchExitOne) deliberately
 * refuses these ambiguous shapes, so the result stays toolKind 'error' —
 * consumers that must not overreact to an informational failure (the turn
 * stop hook) test this signature instead of reclassifying the result.
 * Signals, timeouts, and other exit codes carry different status markers
 * and never match; a destructive-warning prefix also disqualifies.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function isInformationalShellExitOne(result) {
    if (typeof result !== 'string') return false;
    const trimmed = result.trimStart();
    const header = /^error:\s*\[shell-run-failed\]\s*\[exit code: 1\]\s*\n/i.exec(trimmed);
    if (!header) return false;
    const payload = trimmed.slice(header[0].length).trim();
    if (!payload || payload === '(no output)') return false;
    if (payload.startsWith('[stderr') || payload.includes('\n[stderr')) return false;
    return true;
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
        if (/\[exit code:/i.test(header)
            && !/\[timeout:|\[signal:|timed out|aborted|interrupted/i.test(header)) return false;
        return true;
    }
    return /^\[(?:timeout:|signal:)/i.test(body);
}

// Evidence that a command's OUTPUT reports a real failure. Used to separate a
// legitimate non-zero exit (a probe or report that prints its result and ends
// with 1) from a genuine failure that happens to write only to stdout — test
// runners, compilers and package managers all announce themselves in the text.
// Deliberately literal: only well-known failure banners count, so an unknown
// tool's report is never mislabelled a failure.
const SHELL_OUTPUT_FAILURE_EVIDENCE = [
    /^not ok \d/m,
    /^# fail [1-9]/m,
    /\bAssertionError\b/,
    /\bTraceback \(most recent call last\)/,
    /^npm ERR!/m,
    /\berror TS\d+\b/,
    // Indented banners count too: runners print "  FAIL <case>" under a header.
    /^\s*FAIL(?:ED|URE)?\b/mi,
    /\bFAILED[:!]/,
    /^\s*✗/m,
    /\b\d+ (?:tests? )?failed\b/i,
    /^fatal:/m,
    /^error:/mi,
    /\bSyntaxError\b|\bReferenceError\b|\bTypeError\b/,
    /\bCannot find module\b/,
];
export function shellOutputReportsFailure(text) {
    const body = String(text ?? '');
    if (!body.trim()) return false;
    return SHELL_OUTPUT_FAILURE_EVIDENCE.some((pattern) => pattern.test(body));
}

/**
 * A process that started and completed produced a command result. Any non-zero
 * exit code is legitimate tool output; timeout/signal remains an interrupted
 * execution and tool/control-plane failures are filtered by the caller.
 */
export function isLegitimateShellExit({ exitCode, signal, timedOut } = {}) {
    if (signal || timedOut === true) return false;
    return Number.isInteger(exitCode) && exitCode !== 0;
}
