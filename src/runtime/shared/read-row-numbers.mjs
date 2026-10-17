// Read-row line numbers, shared by the read tool (producer) and every
// transcript surface (display). Dependency-free: the desktop renderer bundles
// this module.
//
// Every row is numbered internally as `<n>→<content>`, and every read parser
// works on that text. The model-facing result drops the numbers: each run of
// consecutive rows becomes one `[lines a-b]` marker line followed by the bare
// rows. Line numbers the model states come from grep, code_graph or git diff
// output instead of counted rows. Displays rebuild the numbered rows from the
// markers.
export const READ_LINE_NO_SEP = '→';
const ROW_RE = /^(\d+)→/;
const RUN_MARKER_RE = /^\[lines (\d+)-(\d+)\]$/;

/** Model-facing rows: bare content under one `[lines a-b]` marker per run. */
export function readRowsForModel(text) {
  if (typeof text !== 'string' || !text.includes(READ_LINE_NO_SEP)) return text;
  const lines = text.split('\n');
  const out = [];
  let changed = false;
  for (let i = 0; i < lines.length; ) {
    const first = ROW_RE.exec(lines[i]);
    if (!first) {
      out.push(lines[i++]);
      continue;
    }
    const start = Number(first[1]);
    const bodies = [];
    for (
      let m = first;
      m && Number(m[1]) === start + bodies.length;
      m = i < lines.length ? ROW_RE.exec(lines[i]) : null
    ) {
      bodies.push(lines[i].slice(m[0].length));
      i++;
    }
    const marker = `[lines ${start}-${start + bodies.length - 1}]`;
    out.push(marker, ...bodies);
    // A footer naming exactly the same run adds nothing beyond the marker.
    if (lines[i] === marker) i++;
    changed = true;
  }
  return changed ? out.join('\n') : text;
}

/** Display rows: numbered `<n>→<content>` rows rebuilt from the run markers. */
export function readRowsForDisplay(text) {
  if (typeof text !== 'string' || !text.includes('[lines ')) return text;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RUN_MARKER_RE.exec(lines[i]);
    const start = m ? Number(m[1]) : 0;
    const count = m ? Number(m[2]) - start + 1 : 0;
    if (!m || count < 1 || i + count >= lines.length) {
      out.push(lines[i]);
      continue;
    }
    for (let k = 0; k < count; k++) out.push(`${start + k}${READ_LINE_NO_SEP}${lines[i + 1 + k]}`);
    i += count;
  }
  return out.join('\n');
}

/** Decode one contiguous model-facing read window, never display metadata.
 * Unknown or disjoint views are not safe substitutes for file text. Per-line
 * clipping is not visible in the text: the read executor reports it
 * structurally, never inferred from row content.
 * The display format does not preserve original byte size or final newline.
 */
export function readSourceWindow(text) {
  if (typeof text !== 'string') return null;
  if (/^<system-reminder>File exists but has empty contents: [^\n]*<\/system-reminder>$/.test(text))
    return { content: '', totalLines: 0, startLine: 1, endLine: 0, truncated: false };
  const emptyRange = /^\(no lines in range; file has (\d+) lines\)$/.exec(text);
  if (emptyRange)
    return { content: '', totalLines: Number(emptyRange[1]), startLine: null, endLine: null, truncated: false };
  if (!RUN_MARKER_RE.test(text.split('\n', 1)[0])) return null;
  const rows = [];
  let totalLines;
  let footer = null;
  for (const line of readRowsForDisplay(text).split('\n')) {
    const row = /^(\d+)→([\s\S]*)$/.exec(line);
    if (row) {
      if (footer) return null;
      const number = Number(row[1]);
      if (rows.length && number !== rows.at(-1).number + 1) return null;
      rows.push({ number, content: row[2] });
      continue;
    }
    const metadata = /^\[lines (\d+)-(\d+) of (\d+)(?:; pass offset:\d+ to continue)?\]$/.exec(line);
    if (!metadata || footer) return null;
    footer = metadata;
    totalLines = Number(metadata[3]);
  }
  if (!rows.length) return null;
  const startLine = rows[0].number;
  const endLine = rows.at(-1).number;
  if (footer && (Number(footer[1]) !== startLine || Number(footer[2]) !== endLine || totalLines < endLine)) return null;
  return {
    content: rows.map((row) => row.content).join('\n'),
    ...(totalLines === undefined ? {} : { totalLines }),
    startLine,
    endLine,
    truncated: totalLines === undefined || endLine < totalLines,
  };
}
