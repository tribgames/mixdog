import { READ_LINE_NO_SEP } from '../../../../shared/read-row-numbers.mjs';
import { mergeReadRanges } from './read-ranges.mjs';
import { TOOL_OUTPUT_MAX_BYTES, positiveEnvInt } from './tool-output-limit.mjs';

// Smart-truncate cap: a no-window read returns the file until this cap, past
// which head+tail are shown and the model pages the rest with offset (footer
// says how). Byte budget is the shared TOOL_OUTPUT_MAX_BYTES; line/head/tail
// stay read-specific. Env-overridable for bench: MIXDOG_READ_MAX_LINES/_HEAD/_TAIL.
export const SMART_READ_MAX_BYTES = TOOL_OUTPUT_MAX_BYTES;
export const SMART_READ_MAX_LINES = positiveEnvInt('MIXDOG_READ_MAX_LINES', 2000);
export const SMART_READ_HEAD_LINES = positiveEnvInt('MIXDOG_READ_HEAD_LINES', 1200);
export const SMART_READ_TAIL_LINES = positiveEnvInt('MIXDOG_READ_TAIL_LINES', 400);
const READ_MAX_RENDERED_LINE_CHARS = 2_000;
// Internal read rows are `<n>→<content>`. The separator MUST be a
// NON-WHITESPACE glyph so the read parsers never confuse it with the
// content's own leading indentation; they also accept `[\t│→]` from older
// rendered text. The model-facing result drops the numbers entirely
// (runtime/shared/read-row-numbers.mjs).
export const LINE_NO_SEP = READ_LINE_NO_SEP;

export function buildSmartReadTruncationMarker(totalLines, fileBytes) {
  const kb = Math.max(1, Math.round((Number(fileBytes) || 0) / 1024));
  return `... [TRUNCATED - ${totalLines} lines / ${kb} KB; read located windows with {file_path, offset, limit}] ...`;
}

function rangeFromRenderedReadRows(rows, fallbackStartLine = 1) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const nums = [];
  for (const row of rows) {
    const m = /^(\d+)[\t│→]/.exec(String(row));
    if (m) nums.push(Number(m[1]));
  }
  if (nums.length > 0) {
    return { startLine: Math.min(...nums), endLine: Math.max(...nums) };
  }
  return {
    startLine: Math.max(1, Number(fallbackStartLine) || 1),
    endLine: Math.max(1, (Number(fallbackStartLine) || 1) + rows.length - 1),
  };
}

export function smartReadTruncate(renderedWithLineNos, totalLines, fileBytes) {
  const overByBytes = fileBytes > SMART_READ_MAX_BYTES;
  const overByLines = totalLines > SMART_READ_MAX_LINES;
  if (!overByBytes && !overByLines) {
    return { text: renderedWithLineNos, truncated: false, totalLines, ranges: null };
  }
  const rows = renderedWithLineNos.split('\n');
  const headCount = Math.min(SMART_READ_HEAD_LINES, rows.length);
  const tailStart = Math.max(headCount, rows.length - SMART_READ_TAIL_LINES);
  const elidedRows = tailStart - headCount;
  if (elidedRows <= 0) {
    return { text: renderedWithLineNos, truncated: false, totalLines, ranges: null };
  }
  const headRows = rows.slice(0, headCount);
  const tailRows = rows.slice(tailStart);
  const head = headRows.join('\n');
  const tail = tailRows.join('\n');
  const marker = buildSmartReadTruncationMarker(totalLines, fileBytes);
  return {
    text: `${head}\n${marker}\n${tail}`,
    truncated: true,
    totalLines,
    ranges: mergeReadRanges(
      [rangeFromRenderedReadRows(headRows, 1), rangeFromRenderedReadRows(tailRows, tailStart + 1)].filter(Boolean)
    ),
  };
}

export function parseOffsetArg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function parseLineLimitArg(value, defaultValue) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  if (n === 0) return Infinity;
  return Math.max(1, Math.trunc(n));
}

/** Whether the read display clips this source line. */
export function isReadLineClipped(line, { truncateLongLine = true } = {}) {
  return truncateLongLine && String(line ?? '').length > READ_MAX_RENDERED_LINE_CHARS;
}

export function truncateReadLineText(line, { truncateLongLine = true } = {}) {
  let text = String(line ?? '');
  const originalLength = text.length;
  if (isReadLineClipped(text, { truncateLongLine })) {
    const cps = [...text];
    const head = cps.slice(0, 1_500).join('');
    const tail = cps.slice(-300).join('');
    text = `${head} ... [line truncated: ${originalLength} chars total] ... ${tail}`;
  }
  return text;
}

export function renderReadLine(lineNo, line, { truncateLongLine = true } = {}) {
  const text = truncateReadLineText(line, { truncateLongLine });
  return `${lineNo}${LINE_NO_SEP}${text}`;
}
