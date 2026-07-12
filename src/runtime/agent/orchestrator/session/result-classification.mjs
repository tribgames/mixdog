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
 *   "Error: [shell-run-failed] ..."  — shell command process failure
 *   "Error [code N]:" — structured builtin tool errors
 *   "[error ..."      — bracketed error format
 *   "[exit code: ..." — bash non-zero exit
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

export function classifyResultKind(result, explicitSuccess = false) {
    if (explicitSuccess === true) return 'normal';
    if (typeof result !== 'string') return 'normal';
    const trimmed = result.trimStart();
    if (/^error(?:\s+\[code\b|\s*:)/i.test(trimmed) || /^\[error/i.test(trimmed) || /^\[exit code:/i.test(trimmed)) return 'error';
    for (const prefix of ZERO_MATCH_PREFIXES) {
        if (trimmed.startsWith(prefix)) return 'zero-match';
    }
    return 'normal';
}
