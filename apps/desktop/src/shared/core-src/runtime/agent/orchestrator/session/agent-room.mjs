import { agentHomeSessionId } from './agent-home.mjs';

const ROOM_PREFIX = 'sess_room_';
const MEMBER_PREFIX = 'sess_rmem_';
const HOME_PREFIX_LENGTH = 'sess_home_'.length;
const ROOM_ID = /^[a-z0-9]{6,32}$/;

export const ROOM_MIN_MEMBERS = 2;
export const ROOM_MAX_MEMBERS = 6;
export const ROOM_LIMITS = Object.freeze({
  maxRounds: Object.freeze({ min: 1, max: 10, default: 3 }),
  maxMessages: Object.freeze({ min: 1, max: 30, default: 8 }),
});
function isRoomId(value) {
  return typeof value === 'string' && ROOM_ID.test(value);
}

/** The log session of room `roomId`, or '' for an invalid id. */
export function roomSessionId(roomId) {
  return isRoomId(roomId) ? `${ROOM_PREFIX}${roomId}` : '';
}

/** The room a log session belongs to, or '' for any other session. */
export function roomIdOfSession(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId : '';
  if (!value.startsWith(ROOM_PREFIX)) return '';
  const id = value.slice(ROOM_PREFIX.length);
  return isRoomId(id) ? id : '';
}

/** The session `agentId` speaks from in room `roomId`; '' when either is invalid. */
export function roomMemberSessionId(roomId, agentId) {
  const home = agentHomeSessionId(agentId);
  if (!isRoomId(roomId) || !home) return '';
  return `${MEMBER_PREFIX}${roomId}_${home.slice(HOME_PREFIX_LENGTH)}`;
}

/** `{ roomId, agentId }` of a member session; null for any other session. */
export function roomMemberOfSession(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId : '';
  if (!value.startsWith(MEMBER_PREFIX)) return null;
  const rest = value.slice(MEMBER_PREFIX.length);
  const cut = rest.indexOf('_');
  if (cut < 0) return null;
  const roomId = rest.slice(0, cut);
  const agentId = rest.slice(cut + 1).replaceAll('_', '.');
  return roomMemberSessionId(roomId, agentId) === value ? { roomId, agentId } : null;
}

/** A room's log or one of its member sessions: permanent, never scratch. */
export function isRoomThreadSessionId(sessionId) {
  return Boolean(roomIdOfSession(sessionId) || roomMemberOfSession(sessionId));
}

/** The member `text` starts with, by id or by name, when the character after
 *  it passes `boundary` (or the text ends): the longest label wins, so "Bench"
 *  never shadows "Bench lead"; two members sharing that label match neither. */
function memberAt(text, members, boundary) {
  const lower = text.toLowerCase();
  let best = null;
  let tie = false;
  for (const member of members) {
    for (const label of [member?.id, member?.name]) {
      const value = String(label || '').toLowerCase();
      if (!value || !lower.startsWith(value)) continue;
      if (text.length > value.length && !boundary.test(text[value.length])) continue;
      if (!best || value.length > best.length) {
        best = { id: member.id, length: value.length };
        tie = false;
      } else if (value.length === best.length && member.id !== best.id) tie = true;
    }
  }
  return tie ? null : best;
}

/** A user message to the room: `/ask <agent>[, <agent>…] <message>` addresses
 *  those members, in that order, by id or by name. `{ to, text }`, `to` the
 *  ordered member ids ([] for the whole room); `error` is 'member' (no such
 *  member) or 'message' (nothing to ask). */
export function parseRoomAsk(text, members = []) {
  const raw = String(text ?? '').trim();
  if (!/^\/ask(?:\s|$)/i.test(raw)) return { to: [], text: raw };
  let rest = raw.slice(4).trimStart();
  const to = [];
  for (;;) {
    const found = memberAt(rest, members, /[\s,]/);
    if (!found) return { to: [], text: '', error: 'member' };
    if (!to.includes(found.id)) to.push(found.id);
    rest = rest.slice(found.length);
    const comma = /^\s*,\s*/.exec(rest);
    if (!comma) break;
    rest = rest.slice(comma[0].length);
  }
  const message = rest.trim();
  return message ? { to, text: message } : { to, text: '', error: 'message' };
}
