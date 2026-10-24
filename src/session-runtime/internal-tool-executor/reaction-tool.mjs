// react: a bot's emoji reaction on the user's message (message-reactions.mjs).
// Only a bot's own chat with the user may react: its home chat, where the
// message is in the chat's own transcript, or its seat in a group room, where
// the message is the user's row in the room's log. Never a coding session, a
// delegated worker, or a run nobody attends.
import { isAgentOwner } from '../../runtime/agent/orchestrator/agent-owner.mjs';
import { noteReactionTarget, validateReactionArgs } from '../../runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs';
import { agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession, roomSessionId } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
import { reactInSession } from '../../runtime/agent/orchestrator/session/message-reactions.mjs';
import { agentHomeLiveSurface } from '../agent-home-delivery.mjs';
import { reactInRoom } from '../agent-room-delivery.mjs';
import { scheduleCallerScope } from '../services/schedule-access.mjs';

const DONE =
  'The user sees it under their message. Say nothing about it; reply only if the message also needs an answer.';

export function createReactionToolHandlers({ rt, live = agentHomeLiveSurface, roomReact = reactInRoom }) {
  return {
    react: async (args, { callerCtx }) => {
      const sessionId = callerCtx?.callerSessionId || rt.session?.id || '';
      const session = rt.session?.id === sessionId ? rt.session : null;
      const member = roomMemberOfSession(sessionId);
      const agentId = member?.agentId || agentIdOfHomeSession(sessionId);
      if (!session || !agentId || isAgentOwner(session)) {
        throw new Error("react: reactions belong to a bot's own chat with the user");
      }
      if (scheduleCallerScope(session).unattended === true) {
        throw new Error('react: nobody is in this run to see a reaction');
      }
      const { emoji, messagesBack } = validateReactionArgs(args);
      const change = { agentId, emoji, messagesBack };
      let result;
      if (member) result = await roomReact(roomSessionId(member.roomId), change);
      else {
        result = reactInSession(session, change);
        // The chat's own turn saves the transcript; its open views show it now.
        if (result.changed) live()?.react?.(sessionId, result.messageId, result.reactions);
      }
      if (!emoji) return result.changed ? 'Removed your reaction.' : 'You had no reaction on that message.';
      noteReactionTarget(sessionId, callerCtx?.toolCallId, { messageId: result.messageId, room: Boolean(member) });
      return `Reacted ${emoji}. ${DONE}`;
    },
  };
}
