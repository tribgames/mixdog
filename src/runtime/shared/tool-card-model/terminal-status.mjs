/**
 * terminal-status.mjs — terminal status words, their outcome tone, status
 * marker stripping and the ` · <time>` detail conventions.
 */
import { normalizeToolTerminalStatus, toolResultTerminalStatus } from '../tool-status.mjs';
import { formatElapsed } from '../time-format.mjs';

export function shellResultStatus(value) {
  const match = String(value || '').match(
    /(?:^|\b)status:\s*(running|pending|queued|completed|failed|cancelled|canceled)\b/im
  );
  return match ? String(match[1] || '').toLowerCase() : '';
}

export function normalizeTerminalStatus(value) {
  return normalizeToolTerminalStatus(value);
}

// Semantic outcome shared by TUI and desktop. A returned command/task failure
// means the tool transport worked, so it is warning-yellow; red is reserved
// for a failed invocation. A failed mutation that still committed a diff is
// likewise partial success, not a total failure.
export function deriveToolOutcomeTone({
  pending = false,
  groupCount = 1,
  callFailedCount = 0,
  exitFailedCount = 0,
  terminalStatus = '',
  partialMutation = false,
} = {}) {
  if (pending) return 'running';
  const status = normalizeTerminalStatus(terminalStatus);
  if (status === 'cancelled' || status === 'denied') return 'warning';
  const count = Math.max(1, Number(groupCount) || 1);
  const callFailures = Math.max(0, Number(callFailedCount) || 0);
  if (callFailures > 0) {
    if (partialMutation || (count > 1 && callFailures < count)) return 'warning';
    return 'error';
  }
  if (status === 'failed' || Number(exitFailedCount) > 0) return 'warning';
  return 'success';
}

const TERMINAL_STATUS_LABELS = new Map([
  ['running', 'Running'],
  ['completed', 'Finished'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
  ['denied', 'Denied'],
]);

export function displayTerminalStatus(value) {
  // 'exit' is a shell-only pseudo-status (command RAN but exited non-zero); it
  // is intentionally NOT a normalized terminal status so it never colors red.
  if (
    String(value || '')
      .trim()
      .toLowerCase() === 'exit'
  )
    return 'Exited';
  return TERMINAL_STATUS_LABELS.get(normalizeTerminalStatus(value)) || '';
}

export function resultTerminalStatus(value) {
  return toolResultTerminalStatus(value);
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
  const match = String(value || '').match(/^\[elapsed:\s*(\d+)\s*ms\]/im);
  if (!match) return '';
  const elapsedMs = Number(match[1]);
  return Number.isFinite(elapsedMs) && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
}

export function clampFailureCount(errorCount, groupCount, isError) {
  const explicit = Number(errorCount);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(groupCount, Math.floor(explicit)));
  return isError ? groupCount : 0;
}

export function prefixElapsed(detail, elapsed = '') {
  const text = String(detail || '').trim();
  const time = String(elapsed || '').trim();
  if (!time) return text;
  // Unified convention: the elapsed time ALWAYS goes at the END, ` · ` separated.
  // Guard against a double-append when the text already ends with the same time.
  if (text.endsWith(`· ${time}`)) return text;
  return text ? `${text} · ${time}` : time;
}

export function mergeTerminalDetail(status, detail = '') {
  const label = displayTerminalStatus(status);
  const text = String(detail || '').trim();
  if (!label) return text;
  if (label === 'Finished' && text) return text;
  if (!text) return label;
  if (text.toLowerCase().startsWith(label.toLowerCase())) return text;
  return `${label} · ${text}`;
}
