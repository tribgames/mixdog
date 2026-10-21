// A routine fire delivered into its bot's home thread as a turn
// (session-runtime/routine-home-turn.mjs): the model-visible header line that
// opens the turn's prompt, and the `routineTrigger` marker its user row
// carries (live, persisted in meta.transcript, restored) so a chat paints it
// as a routine marker instead of a user bubble.

import { localTimestampParts } from './time-format.mjs';

const HEADER_PREFIX = '[Routine trigger]';
const KINDS = new Set(['schedule', 'webhook']);

/** The first line of a routine turn's prompt: which routine fired, when (local
 *  time and zone: the turn gets no other date), and how to treat the turn.
 *  It is the routine's only conduct text. Only the turn's content carries it,
 *  never the system prompt, so the thread's prompt cache is untouched. */
export function routineTriggerHeader({ kind, name, project = '', now = new Date() }) {
  const what = kind === 'webhook' ? 'webhook' : 'schedule';
  const at = localTimestampParts(now);
  return [
    `${HEADER_PREFIX} Your ${what} "${String(name)}" fired.`,
    ...(at ? [`Local time: ${at.date} ${at.time.slice(0, 5)} ${at.timeZone} (${at.offset}).`] : []),
    'Carry out its instructions below now, yourself or by delegating.',
    'Nobody is watching this turn and nothing asks for approval: act within your permissions.',
    'Payments and permanent deletes are refused here: report that and suggest doing it from the chat.',
    'If a sign-in, code or CAPTCHA blocks you, stop and say which site needs the user.',
    'Reply in this chat in plain words, without tool names; if you handed work off, say it started — its result arrives here later.',
    ...(project ? [`Project folder: ${project}`] : []),
  ].join(' ');
}

/** `text` without the header line a routine turn opens with. */
export function stripRoutineTriggerHeader(text) {
  const value = String(text ?? '');
  if (!value.startsWith(HEADER_PREFIX)) return value;
  const end = value.indexOf('\n');
  return end < 0 ? '' : value.slice(end + 1).replace(/^\n+/, '');
}

/** A well-formed `{ kind, name, event? }` marker, or null. */
export function normalizeRoutineTrigger(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 200) : '';
  if (!name || !KINDS.has(value.kind)) return null;
  const event = typeof value.event === 'string' ? value.event.trim().slice(0, 200) : '';
  return { kind: value.kind, name, ...(event ? { event } : {}) };
}

/** The `routineTrigger` field of a transcript row (absent when none). */
export function routineTriggerField(value) {
  const trigger = normalizeRoutineTrigger(value?.routineTrigger);
  return trigger ? { routineTrigger: trigger } : {};
}
