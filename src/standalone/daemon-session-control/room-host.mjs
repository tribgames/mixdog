import { rememberSubmissionBotChain } from '../../runtime/shared/bot-hops.mjs';
import { agentRoomHost } from '../../runtime/shared/agent-room-host.mjs';

/** The member a send to room log `sessionId` addresses, through the desktop
 *  room host: `{ host, agentId, sessionId, text }`; throws when no desktop is
 *  attached or no member resolves. */
export async function roomAddressee(sessionId, args) {
  let host;
  try {
    host = agentRoomHost();
  } catch (error) {
    throw new Error(`session: cannot send to ${sessionId}: ${error.message}`);
  }
  const member = await host.member(sessionId, { to: args.to, prompt: args.prompt }).catch((error) => {
    throw new Error(`session: ${error?.message || error}`);
  });
  return { host, ...member };
}

/** The submit of a send to `room` (roomAddressee) at room log `sessionId`:
 *  the member's turn carries the send's hop (`transcriptMeta.hop`), so a
 *  chain through the room counts on toward MAX_BOT_HOPS; its bot chain is
 *  recorded under every submission id that turn may take. */
export function roomSubmitter(room, sessionId, prompt, from) {
  return async ({ id, onSettled, follow, transcriptMeta } = {}) => {
    rememberSubmissionBotChain(id, transcriptMeta?.botChain);
    const followed = follow
      ? (submissionId) => {
          rememberSubmissionBotChain(submissionId, transcriptMeta?.botChain);
          return follow(submissionId);
        }
      : null;
    return {
      accepted:
        (await room.host.ask(sessionId, {
          agentId: room.agentId,
          prompt,
          from,
          ...(id ? { id } : {}),
          ...(transcriptMeta?.hop > 0 ? { hop: transcriptMeta.hop } : {}),
          ...(onSettled ? { onSettled } : {}),
          ...(followed ? { follow: followed } : {}),
        })) === true,
    };
  };
}

/** Stops the exchange of room log `sessionId` through the desktop room host. */
export function stopRoomExchange(sessionId) {
  let host;
  try {
    host = agentRoomHost();
  } catch (error) {
    throw new Error(`session: cannot cancel ${sessionId}: ${error.message}`);
  }
  return { sessionId, aborted: host.stop(sessionId) === true };
}
