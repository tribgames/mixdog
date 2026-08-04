// Declaration span-end inference from indentation. Recovers the end line of a
// brace-delimited declaration whose endLine the graph does not record
// (assignment-style decls). Extracted verbatim from code-graph.mjs.

const SYMBOL_SPAN_SCAN_MAX_LINES = 400;

export function _inferSpanEndByIndent(allLines, startLine) {
  const decl = allLines[startLine - 1];
  if (typeof decl !== 'string' || !/[{([]\s*$/.test(decl.trimEnd())) return null;
  const declIndent = decl.match(/^[ \t]*/)[0].length;
  const last = Math.min(allLines.length, startLine - 1 + SYMBOL_SPAN_SCAN_MAX_LINES);
  for (let i = startLine; i < last; i++) {
    const line = allLines[i];
    if (!/^[ \t]*[})\]]/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent <= declIndent) return i + 1;
  }
  return null;
}
