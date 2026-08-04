import { visibleWidth } from './ansi.mjs';

/**
 * Build a conservative in-place final-format patch for a streamed terminal
 * block. Logical rows must map 1:1 to physical rows; wrapped or structurally
 * changed output returns null so the caller can use the full-redraw fallback.
 */
export function buildStreamFinalPatch(rawText, renderedText, { columns = 80 } = {}) {
  const raw = String(rawText ?? '');
  const rendered = String(renderedText ?? '');
  if (raw.includes('\r') || rendered.includes('\r')) return null;
  const rawLines = raw.split('\n');
  const renderedLines = rendered.split('\n');
  if (rawLines.length !== renderedLines.length) return null;

  const width = Math.max(1, Math.floor(Number(columns) || 80));
  for (let index = 0; index < rawLines.length; index += 1) {
    if (visibleWidth(rawLines[index]) >= width || visibleWidth(renderedLines[index]) >= width) {
      return null;
    }
  }

  const changedRows = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    if (rawLines[index] !== renderedLines[index]) changedRows.push(index);
  }
  if (changedRows.length === 0) {
    return { output: '', changedRows: 0, totalRows: rawLines.length };
  }

  let output = '\r';
  for (let index = rawLines.length - 1; index >= 0; index -= 1) {
    if (rawLines[index] !== renderedLines[index]) {
      output += `\x1b[2K${renderedLines[index]}`;
    }
    if (index > 0) output += '\r\x1b[1A';
  }
  if (rawLines.length > 1) {
    output += `\r\x1b[${rawLines.length - 1}B`;
    const lastWidth = visibleWidth(renderedLines.at(-1) || '');
    if (lastWidth > 0) output += `\x1b[${lastWidth}C`;
  }

  return { output, changedRows: changedRows.length, totalRows: rawLines.length };
}
