/**
 * inline-text.mjs — single-row text hygiene and the row budgets shared by
 * every collapsed tool-card surface.
 */
import stripAnsi from 'strip-ansi';

export const MIN_RESULT_LINE_CHARS = 24;
// Hard cap for the collapsed result detail row (the second line under the ⎿
// gutter). Independent of terminal width so a wide terminal never lets a long
// line (e.g. an agent response brief) stretch the whole row — anything past
// this is truncated with an ellipsis. Expanding still shows the full body.
export const RESULT_LINE_HARD_MAX = 80;
// Hard cap for the parenthesized header arg summary so a long path/query does
// not eat the whole header line; anything longer is truncated with an ellipsis.
export const SUMMARY_MAX_CHARS = 48;
export const HEADER_FAILURE_STATUS_MAX = 32;

// Collapsed tool headers/details are laid out as single rows. Never let raw
// C0/control bytes (CR, tabs, cursor escapes, etc.) reach those rows.
const INLINE_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export function safeInlineText(value) {
  return stripAnsi(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(INLINE_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clipPlain(text, maxChars) {
  const value = safeInlineText(text);
  const max = Math.max(1, Number(maxChars) || 1);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function normalizeCountMap(value = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (raw && typeof raw === 'object') {
      out[key] = { ...raw, count: normalizeCount(raw.count) };
    } else {
      out[key] = normalizeCount(raw);
    }
  }
  return out;
}

// `+N`/`-N` line-delta tokens inside a detail row ("+177 lines"). Surfaces
// color the token (TUI theme / desktop CSS); the SPLIT lives here so both
// recognize the same grammar.
const LINE_DELTA_RE = /(^|[\s([,{·])([+-]\s*\d+)(?=\s+Lines?\b)/gi;

export function splitLineDeltaTokens(text) {
  const value = String(text ?? '');
  const parts = [];
  let last = 0;
  let match;
  LINE_DELTA_RE.lastIndex = 0;
  while ((match = LINE_DELTA_RE.exec(value))) {
    const prefix = match[1] || '';
    const token = (match[2] || '').replace(/\s+/g, '');
    const tokenStart = match.index + prefix.length;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    if (prefix) parts.push({ text: prefix });
    if (token) parts.push({ text: token, delta: token.startsWith('+') ? '+' : '-' });
    last = tokenStart + (match[2] || '').length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}
