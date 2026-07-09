/**
 * components/tool-execution/text-format.mjs — pure text/formatting helpers for
 * the tool card (no React). Inline-row sanitization, width fitting/truncation,
 * count normalization, diff-token splitting, and terminal-status parsing.
 * Extracted verbatim from ToolExecution.jsx — behavior unchanged.
 */
import { displayWidth } from '../../display-width.mjs';
import { theme } from '../../theme.mjs';
import { formatElapsed } from '../../time-format.mjs';
import stripAnsi from 'strip-ansi';

export const MIN_RESULT_LINE_CHARS = 24;
// Hard cap for the collapsed result detail row (the second line under the ⎿
// gutter). Independent of terminal width so a wide terminal never lets a long
// line (e.g. an agent response brief) stretch the whole row — anything past
// this is truncated with an ellipsis. ctrl+o expand still shows the full body.
export const RESULT_LINE_HARD_MAX = 80;
// Hard cap for the parenthesized header arg summary so a long path/query does
// not eat the whole header line; anything longer is truncated with an ellipsis.
export const SUMMARY_MAX_CHARS = 48;
export const HEADER_FAILURE_STATUS_MAX = 32;

// Read `theme.subtle` at use-time (not captured here) so a live `/theme`
// switch re-tones the tool hints. `theme` is mutated in-place on switch.
// Collapsed tool headers/details are laid out as single terminal rows. Never let
// raw C0/control bytes (CR, tabs, cursor escapes, etc.) reach those rows: a
// terminal can apply them after Ink has already clipped/measured the row, which
// makes a scrolled tool card appear to write through the prompt/statusline.
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

export function normalizeCount(value) {
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

export function deltaColor(token) {
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

export function plural(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
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

export function shellResultStatus(value) {
  const match = String(value || '').match(/(?:^|\b)status:\s*(running|pending|queued|completed|failed|cancelled|canceled)\b/im);
  return match ? String(match[1] || '').toLowerCase() : '';
}

export function normalizeTerminalStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
  if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
  if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
  if (/^(cancelled|canceled|cancel)$/.test(raw)) return 'cancelled';
  return '';
}

export function displayTerminalStatus(value) {
  // 'exit' is a shell-only pseudo-status (command RAN but exited non-zero); it
  // is intentionally NOT a normalized terminal status so it never colors red.
  if (String(value || '').trim().toLowerCase() === 'exit') return 'Exit';
  const status = normalizeTerminalStatus(value);
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Finished';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  return '';
}

export function resultTerminalStatus(value) {
  const text = String(value || '');
  const tagged = text.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  if (tagged) return normalizeTerminalStatus(tagged);
  const bracketed = text.match(/^\[status:\s*([^\]]*)\]/mi)?.[1]?.trim();
  if (bracketed) return normalizeTerminalStatus(bracketed);
  // Loose inline `status: x` / `state: x` matches are a last-resort fallback —
  // prefer the engine-controlled `<status>` tag or `[status: …]` marker above.
  // A loose match can false-positive on prose that happens to start with
  // "status:" (rare, but shellResultStatus below already owns real shell
  // output parsing; this fallback stays narrow and unchanged in behavior).
  const inline = text.match(/^(?:status|state):\s*([^\s·,;]+)/mi)?.[1]?.trim();
  return normalizeTerminalStatus(inline);
}

const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

export function stripLeadingStatusMarkerLines(lines) {
  const out = Array.isArray(lines) ? lines.slice() : [];
  if (out.length > 0 && LEADING_STATUS_MARKER_LINE_RE.test(String(out[0] ?? '').trim())) out.shift();
  return out;
}

export function stripLeadingStatusMarkerFromText(text) {
  return stripLeadingStatusMarkerLines(String(text || '').split('\n')).join('\n');
}

export function shellResultElapsed(value) {
  const match = String(value || '').match(/^\[elapsed:\s*(\d+)\s*ms\]/mi);
  if (!match) return '';
  const elapsedMs = Number(match[1]);
  return Number.isFinite(elapsedMs) && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
}
