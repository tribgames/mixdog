/**
 * components/tool-execution/text-format.mjs — width/theme-bound text helpers
 * for the tool card. The pure, surface-agnostic pieces (inline sanitization,
 * status parsing/casing, count normalization) moved VERBATIM to
 * runtime/shared/tool-card-model.mjs so the desktop renderer derives IDENTICAL
 * tool-card text; this module re-exports them for existing TUI imports and
 * keeps only what needs the live terminal theme or display-width math.
 */
import { displayWidth } from '../../display-width.mjs';
import { theme } from '../../theme.mjs';
import {
  safeInlineText,
  MIN_RESULT_LINE_CHARS,
  RESULT_LINE_HARD_MAX,
} from '../../../runtime/shared/tool-card-model.mjs';

export {
  MIN_RESULT_LINE_CHARS,
  RESULT_LINE_HARD_MAX,
  SUMMARY_MAX_CHARS,
  HEADER_FAILURE_STATUS_MAX,
  safeInlineText,
  normalizeCountMap,
  plural,
  shellResultStatus,
  normalizeTerminalStatus,
  displayTerminalStatus,
  resultTerminalStatus,
  stripLeadingStatusMarkerLines,
  stripLeadingStatusMarkerFromText,
  shellResultElapsed,
} from '../../../runtime/shared/tool-card-model.mjs';

function deltaColor(token) {
  return String(token || '').startsWith('+') ? theme.success : theme.error;
}

export function deltaTextParts(text) {
  const value = String(text ?? '');
  const parts = [];
  const re = /(^|[\s([,{·])([+-]\s*\d+)(?=\s+Lines?\b)/gi;
  let last = 0;
  let match;
  while ((match = re.exec(value))) {
    const prefix = match[1] || '';
    const token = (match[2] || '').replace(/\s+/g, '');
    const tokenStart = match.index + prefix.length;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    if (prefix) parts.push({ text: prefix });
    if (token) parts.push({ text: token, color: deltaColor(token) });
    last = tokenStart + (match[2] || '').length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

export function fitResultLine(line, columns) {
  const max = Math.min(RESULT_LINE_HARD_MAX, Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7));
  const text = safeInlineText(line);
  return displayWidth(text) > max ? truncateToWidth(text, max) : text;
}

/** Trim text from the end (by display width) so it fits maxWidth, appending '…'. */
export function truncateToWidth(text, maxWidth) {
  const str = safeInlineText(text);
  if (maxWidth < 1) return '';
  if (displayWidth(str) <= maxWidth) return str;
  const chars = Array.from(str);
  let out = '';
  for (const ch of chars) {
    if (displayWidth(out + ch + '…') > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}
