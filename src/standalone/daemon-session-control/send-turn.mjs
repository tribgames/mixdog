import { BOT_HOP_LIMIT_ERROR, MAX_BOT_HOPS } from '../../runtime/shared/bot-hops.mjs';
import { roomMemberOfSession, roomSessionId } from '../../runtime/agent/orchestrator/session/agent-room.mjs';

// Why a send from a conversation that is no bot's reports nothing back.
const NOT_BOT_REASON = 'only a bot conversation gets session results reported back; check that session for the result';

/** Throws unless a send to `sessionId` carries a prompt and addresses no
 *  room member's session directly. */
export function assertSendRequest(args, sessionId) {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    throw new Error('session: prompt is required for action=send');
  }
  // A room member's session is the room's to drive: a message goes to the
  // room, naming the member.
  if (roomMemberOfSession(sessionId)) {
    throw new Error(
      `session: ${sessionId} is a group-room member's session; send to its room (session_id ${roomSessionId(roomMemberOfSession(sessionId).roomId)}) with to: <member>`
    );
  }
}

/** Applies effort `level` (checked) to `sessionId`, just before the prompt is queued. */
export function effortApplier(service, sessionId, level) {
  // sessionOnly: the session's route changes, never the user's saved model settings.
  return async () => {
    const applied = await service.configureSession(
      { sessionId, action: 'setEffort', args: [level, { sessionOnly: true }] },
      { revision: 1 }
    );
    if (applied?.value === false) {
      throw new Error(`session: ${sessionId} is busy with another command; effort not changed`);
    }
  };
}

/** `hop`, refused past MAX_BOT_HOPS. */
export function chainedHop(hop) {
  if (hop > MAX_BOT_HOPS) throw new Error(BOT_HOP_LIMIT_ERROR);
  return hop;
}

/** The report origin with the send's hop and bot chain carried on. */
export function chainedOrigin(origin, hop, botChain) {
  let chained = origin;
  if (hop > 0) chained = { ...chained, hop };
  if (botChain.length) chained = { ...chained, botChain };
  return chained;
}

/** The result of a send that reports nothing back (no report origin). */
export function unreportedSendResult(sessionId, addressed, accepted, hop) {
  return {
    sessionId,
    ...addressed,
    accepted,
    reportsBack: false,
    ...(accepted ? { reportsBackReason: NOT_BOT_REASON } : {}),
    ...(hop > 0 ? { hop } : {}),
  };
}
