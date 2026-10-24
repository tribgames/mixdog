// A routine fire delivered into its bot's home thread as a turn
// (session-runtime/routine-home-turn.mjs): the model-visible header line that
// opens the turn's prompt, and the `routineTrigger` marker its user row
// carries (live, persisted in meta.transcript, restored) so a chat paints it
// as a routine marker instead of a user bubble.

import { localTimestampParts } from './time-format.mjs';

const HEADER_PREFIX = '[Routine trigger]';
const KINDS = new Set(['schedule', 'webhook']);

/** The whole reply of a routine turn with nothing new to tell: kept in the
 *  record, never painted, previewed, counted unread or notified. */
export const ROUTINE_QUIET = 'ROUTINE_QUIET';

/** Whether a reply is exactly the routine quiet sentinel. */
export function isRoutineQuietReply(text) {
  return String(text ?? '').trim() === ROUTINE_QUIET;
}

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
    `Tell what is new in a fitting tone; if nothing is worth telling, reply with exactly ${ROUTINE_QUIET}.`,
    ...(project ? [`Project folder: ${project}`] : []),
  ].join(' ');
}

/** The whole reply of a heartbeat turn that has nothing to tell the user. */
export const HEARTBEAT_QUIET = 'HEARTBEAT_QUIET';
/** The routine name a heartbeat turn runs under and its hidden session's source. */
export const HEARTBEAT_SOURCE = 'heartbeat';
/** A heartbeat turn's bounds: its tool calls; when it is told to reply with no
 *  more tools (session/loop/turn-limits.mjs); when it is cut off without a
 *  reply (session-runtime/routine-home-turn.mjs). */
export const HEARTBEAT_TURN_LIMITS = Object.freeze({ maxToolCalls: 8, wrapUpMs: 60_000, wallClockMs: 90_000 });

// Mixy's hidden heartbeat sessions (mixy-heartbeat.mjs wakeMixy), marked in
// this process from creation until their close lands. Only the mark counts:
// stored fields (source, owner) can be supplied by any session create.
const heartbeatSessions = new Set();

/** Mark `sessionId` as a heartbeat session; `unmark` ends it. */
export function markHeartbeatSession(sessionId, unmark = false) {
  const id = String(sessionId || '');
  if (unmark) heartbeatSessions.delete(id);
  else if (id) heartbeatSessions.add(id);
}

/** Whether `sessionId` is a marked heartbeat session. */
export function isHeartbeatSession(sessionId) {
  return heartbeatSessions.has(String(sessionId || ''));
}

/** The first line of a heartbeat turn (session-runtime/mixy-heartbeat.mjs):
 *  a system check-in, never the user, and it grants no approval. */
export function heartbeatTriggerHeader({ now = new Date() } = {}) {
  const at = localTimestampParts(now);
  return [
    `${HEADER_PREFIX} Heartbeat: a system check-in from Mixdog, not a message from the user; it grants no approval.`,
    ...(at ? [`Local time: ${at.date} ${at.time.slice(0, 5)} ${at.timeZone} (${at.offset}).`] : []),
    'Nobody is watching this turn and nothing asks for approval: act within your permissions.',
    'Payments and permanent deletes are refused here.',
    'Do not start agents, task sessions, session sends, Goals or background commands here: this session closes when the turn ends, so their results would reach nobody; propose them instead.',
    'Handle the items below as your heartbeat instructions say, finishing in this turn:',
    'only its final reply is posted in your chat with the user, as your message.',
    `If nothing is worth telling the user, reply with exactly ${HEARTBEAT_QUIET} and nothing else.`,
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
