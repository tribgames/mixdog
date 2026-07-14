/**
 * src/tui/engine/labels.mjs - spinner verbs, elapsed formatting, and compact
 * event label/detail helpers. Extracted from engine.mjs.
 */
import { SPINNER_VERBS } from '../spinner-verbs.mjs';

export function pickVerb(turn) {
  return SPINNER_VERBS[(turn * 7 + 3) % SPINNER_VERBS.length];
}

const TURN_DONE_VERBS = [
  'Thought',
  'Reasoned',
  'Mapped',
  'Checked',
  'Solved',
  'Composed',
  'Synthesized',
  'Wrapped',
];

export function pickDoneVerb(turn) {
  return TURN_DONE_VERBS[(turn * 5 + 2) % TURN_DONE_VERBS.length];
}

export function formatElapsedSeconds(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value <= 0) return '0s';
  return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

export function compactEventLabel(event = {}) {
  const status = String(event.status || '').toLowerCase();
  const reactive = String(event.trigger || '').toLowerCase() === 'reactive';
  if (status === 'failed') return reactive ? 'Compact failed (overflow retry)' : 'Compact failed';
  if (status === 'skipped') return 'Compact skipped';
  if (status === 'no_change') return 'Compact checked';
  return reactive ? 'Compact complete (overflow recovery)' : 'Compact complete';
}

export function compactEventDetail(event = {}) {
  // Keep the elapsed time as the lead detail, but no longer discard the rest of
  // the compact metadata. Surface type/trigger and the boundary/pressure so the
  // statusdone marker reflects what actually fired.
  const parts = [];
  const elapsed = formatElapsedSeconds(Number(event.durationMs ?? event.elapsedMs ?? 0));
  if (elapsed) parts.push(elapsed);
  const type = String(event.compactType || event.type || '').trim();
  if (type && type !== 'semantic') parts.push(type);
  const trigger = String(event.trigger || '').toLowerCase();
  if (trigger === 'reactive') parts.push('reactive');
  else if (trigger === 'manual') parts.push('manual');
  const before = Number(event.pressureTokens ?? event.beforeTokens ?? 0);
  const after = Number(event.afterTokens ?? 0);
  const fmtTok = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
    return `${Math.round(v)}`;
  };
  if (before > 0 && after > 0 && after !== before) parts.push(`${fmtTok(before)}→${fmtTok(after)}`);
  return parts.join(' · ');
}

export function projectNameFromPath(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text || '(current)';
}
