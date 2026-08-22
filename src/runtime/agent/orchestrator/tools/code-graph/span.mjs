// Declaration span-end inference from indentation. Recovers the end line of a
// brace-delimited declaration whose endLine the graph does not record
// (assignment-style decls). Extracted verbatim from code-graph.mjs.

const SYMBOL_SPAN_SCAN_MAX_LINES = 400;

const CLOSER_FOR_OPENER = { '{': '}', '(': ')', '[': ']' };

export function _inferSpanEndByIndent(allLines, startLine) {
  const decl = allLines[startLine - 1];
  if (typeof decl !== 'string') return null;
  const declTrimmed = decl.trimEnd();
  const opener = /[{([]$/.test(declTrimmed) ? declTrimmed[declTrimmed.length - 1] : null;
  if (!opener) return null;
  const declIndent = decl.match(/^[ \t]*/)[0].length;
  const last = Math.min(allLines.length, startLine - 1 + SYMBOL_SPAN_SCAN_MAX_LINES);
  let expected = CLOSER_FOR_OPENER[opener];
  for (let i = startLine; i < last; i++) {
    const line = allLines[i];
    const m = /^[ \t]*([})\]])/.exec(line);
    if (!m) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent > declIndent) continue;
    // Only the closer that MATCHES the opener can end the span. A different
    // closer at the same indentation belongs to a construct this indentation
    // heuristic cannot see (`) => {` bodies, closers of an enclosing literal,
    // reformatted code) — ending there truncated the declaration, so keep
    // scanning for the real one instead.
    if (m[1] !== expected) continue;
    // The matching closer may itself re-open the real body on the same line
    // (`) => {`, `] = {`, `}) {`); follow that opener so wrapped signatures
    // and arrow bodies stay whole.
    const tail = line.trimEnd();
    const reopen = /[{([]$/.test(tail) ? tail[tail.length - 1] : null;
    if (reopen && indent === declIndent) {
      expected = CLOSER_FOR_OPENER[reopen];
      continue;
    }
    return i + 1;
  }
  return null;
}
