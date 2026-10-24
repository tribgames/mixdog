import { SESSION_ID_PATTERN } from '../runtime/agent/orchestrator/runtime-core/session-id.mjs';
import { sessionListOutput, sessionReadOutput, SESSION_TOOL_OUTPUT_BYTES } from './session-tool-output.mjs';
import { createAgentTaskSessions } from '../session-runtime/agent-task-sessions.mjs';
import { assertWorktreeMutationAllowed } from '../session-runtime/services/worktree-access.mjs';
import { createBotStatus, scanCatalog, scopedBot, sessionBotOf } from '../session-runtime/bot-status.mjs';
import { handoffContent } from '../session-runtime/handoff-attachments.mjs';
import { checkEffort, readModelCatalog } from '../session-runtime/task-session-route.mjs';
import {
  BOT_HOP_LIMIT_ERROR,
  MAX_BOT_HOPS,
  assertBotChainTarget,
  botChainOf,
  rememberSubmissionBotChain,
} from '../runtime/shared/bot-hops.mjs';
import { agentIdOfHomeSession } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { rebindDelegation } from '../runtime/agent/orchestrator/session/human-gate/delegation.mjs';
import { isAgentOnlySession } from '../runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import { readSessionSidebarState } from '../runtime/shared/session-sidebar-host.mjs';
import { agentRoomHost } from '../runtime/shared/agent-room-host.mjs';
import {
  roomIdOfSession,
  roomMemberOfSession,
  roomSessionId,
} from '../runtime/agent/orchestrator/session/agent-room.mjs';

const TARGET_ACTIONS = new Set(['status', 'read', 'send', 'cancel', 'delete']);
const MUTATING_ACTIONS = new Set(['send', 'cancel', 'delete']);
// The workspace methods `worktree` reaches on another session (all on the
// session protocol's read/configure allowlists).
const WORKTREE_METHODS = new Set([
  'getBranchMenu',
  'requestWorktree',
  'selectBranch',
  'mergeWorkspace',
  'removeWorktree',
]);
// Why a send from a conversation that is no bot's reports nothing back.
const NOT_BOT_REASON = 'only a bot conversation gets session results reported back; check that session for the result';

/** The member a send to room log `sessionId` addresses, through the desktop
 *  room host: `{ host, agentId, sessionId, text }`; throws when no desktop is
 *  attached or no member resolves. */
async function roomAddressee(sessionId, args) {
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

/** Model-facing session operations over the same service used by desktop and TUI. */
export function createSessionControl({
  getSessionService,
  agentTasks = createAgentTaskSessions({ getSessionService }),
  botStatus = createBotStatus({ getSessionService }),
}) {
  /**
   * Another session's workspace for the git tool's worktree operations
   * (session-runtime/workspace/worktree-tool.mjs): one workspace method with
   * one input, through the same configure / read lanes the desktop uses. No
   * `ownTurn` ever crosses: the target must be idle. A change (anything but
   * the menu read) needs the caller's trusted scope (`callerScope`, from
   * worktree-access.mjs worktreeCallerScope) to be an attended conversation.
   */
  async function worktreeControl(args, caller, callerScope) {
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('session: session_id is required for action=worktree');
    if (sessionId === caller) throw new Error('session: worktree control must target another session');
    if (!WORKTREE_METHODS.has(args.method)) throw new Error(`session: unsupported worktree method "${args.method}"`);
    if (args.method !== 'getBranchMenu') assertWorktreeMutationAllowed(callerScope, `session: worktree ${args.method}`);
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    if (args.method === 'getBranchMenu') {
      return (await service.readSession({ sessionId, action: 'getBranchMenu', args: [] })).value;
    }
    const result = await service.configureSession(
      { sessionId, action: args.method, args: [args.input ?? {}] },
      { revision: 1 }
    );
    return result.value;
  }

  return async function executeSessionControl(args = {}, context = {}) {
    const action = args.action;
    if (
      action !== 'list' &&
      action !== 'create' &&
      action !== 'bots' &&
      action !== 'worktree' &&
      !TARGET_ACTIONS.has(action)
    ) {
      throw new Error(`session: unsupported remote action "${action}"`);
    }
    const caller = context.callerSessionId;
    if (typeof caller !== 'string' || !SESSION_ID_PATTERN.test(caller)) {
      throw new Error('session: caller session is required');
    }
    // `callerAgentId`: set only for an attended agent conversation (workspace-tools.mjs).
    if (action === 'create') return agentTasks.create(args, context);
    if (action === 'worktree') return worktreeControl(args, caller, context.callerScope);
    // `callerScope`: the caller's schedule-access scope (workspace-tools.mjs).
    if (action === 'bots') return botStatus(args, context);
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (TARGET_ACTIONS.has(action) && !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`session: session_id is required for action=${action}`);
    }
    if (MUTATING_ACTIONS.has(action) && sessionId === caller) {
      throw new Error(`session: ${action} must target another session`);
    }
    const limit = args.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('session: limit must be an integer from 1 to 100');
    }
    const offset = args.offset ?? 0;
    const textOffset = args.text_offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit)) {
      throw new Error('session: offset must be a nonnegative safe integer');
    }
    if (!Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error('session: invalid text_offset');
    if (args.text_offset !== undefined && (args.offset === undefined || limit !== 1 || !args.item_id)) {
      throw new Error('session: text_offset requires offset, limit:1 and item_id from read');
    }
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    if (action === 'list') {
      for (const flag of ['include_agents', 'include_archived']) {
        if (args[flag] !== undefined && typeof args[flag] !== 'boolean') {
          throw new Error(`session: ${flag} must be a boolean`);
        }
      }
      // Scoped like bots (`callerScope`, bot-status.mjs): the human's sessions
      // list everything with previews, a bot (or its unattended run) lists the
      // same rows (so it can find a session to send to) but only its own carry
      // the bot, activity, preview and working state, anything else the plain
      // rows without previews. Sub-agent sessions (a
      // parent finds its own through the agent tool) and archived ones (the
      // desktop's flag) only on request; the scan pages past the rows left
      // out, so a page is never short while more rows match.
      const own = scopedBot(context.callerScope);
      const archived = (await readSessionSidebarState())?.archived ?? {};
      const keep = (row) =>
        (args.include_agents === true || !isAgentOnlySession(row)) &&
        (args.include_archived === true || !Object.hasOwn(archived, row.id));
      // Bounded: past 10000 rows scanned with fewer than `limit` matching, the
      // page ends (possibly empty) with a nextCursor to continue from.
      const scan = await scanCatalog(service, keep, { cursor: args.cursor || null, want: limit, maxRows: 10_000 });
      const sessions = scan.rows.map((row) => (Object.hasOwn(archived, row.id) ? { ...row, archived: true } : row));
      return sessionListOutput({ sessions, nextCursor: scan.nextCursor }, limit, {
        rich: own ? (row) => sessionBotOf(row) === own : own !== null,
      });
    }
    if (action === 'send') {
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
      // A send to a room's log is a message to one member there (`to`, or a
      // leading @name), run by the desktop room host; the member's turn in
      // its member session is the turn that answers and reports.
      const room = roomIdOfSession(sessionId) ? await roomAddressee(sessionId, args) : null;
      if (room?.sessionId === caller) throw new Error('session: send must target another session');
      // Work goes on to a bot (a room seat's, or a bot's home) only outside
      // the caller's bot chain (`callerBotChain`, bot-chain.mjs), never back
      // to the caller's own bot; the turn it starts carries that chain on.
      const botChain = botChainOf(context.callerBotChain);
      assertBotChainTarget(
        room ? room.agentId : agentIdOfHomeSession(sessionId),
        { chain: botChain, self: context.callerBotId || context.callerAgentId || '' },
        'session'
      );
      // An agent conversation's send reports its turn back to the agent's
      // home: a task session it created by its stored origin, any other
      // session by an origin for this send only.
      // Forwarded files ride along as stored attachment parts (workspace-tools.mjs).
      const prompt = handoffContent(room ? room.text : args.prompt, context.attachmentParts);
      const turnSessionId = room ? room.sessionId : sessionId;
      const from = { sessionId: caller, ...(context.callerAgentId ? { agentId: context.callerAgentId } : {}) };
      // The member's turn carries the send's hop (`transcriptMeta.hop`), so a
      // chain through the room counts on toward MAX_BOT_HOPS; its bot chain is
      // recorded under every submission id that turn may take.
      const submit = room
        ? async ({ id, onSettled, follow, transcriptMeta } = {}) => {
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
          }
        : null;
      const addressed = room ? { to: room.agentId } : {};
      let origin = await agentTasks.reportOrigin(turnSessionId, context.callerAgentId, caller);
      // `effort` is the menu's effort pick on the target: checked now against the
      // levels of its model, applied just before the prompt is queued.
      let applyEffort = async () => {};
      if (args.effort !== undefined) {
        if (room) throw new Error('session: effort applies to a session, not a group room');
        // Any bot, attended or not (`callerBotId`), changes only the task
        // sessions it created; reports go only to a bot conversation.
        const botId = context.callerBotId || context.callerAgentId || '';
        if (botId && (await agentTasks.reportOrigin(sessionId, botId, caller))?.target === 'session') {
          throw new Error('session: a bot may set the effort only of the task sessions it created');
        }
        const target = (await service.readSession({ sessionId, transcriptItemLimit: 1 })).full;
        if (!target) throw new Error(`session: ${sessionId} is unavailable`);
        const level = checkEffort(args.effort, target, await readModelCatalog(service, caller));
        // sessionOnly: the session's route changes, never the user's saved model settings.
        applyEffort = async () => {
          const applied = await service.configureSession(
            { sessionId, action: 'setEffort', args: [level, { sessionOnly: true }] },
            { revision: 1 }
          );
          if (applied?.value === false) {
            throw new Error(`session: ${sessionId} is busy with another command; effort not changed`);
          }
        };
      }
      // A send made in a bot-descended turn (`callerHop` > 0), or by a bot to
      // another session, extends the chain by one; a bot's own task session
      // only continues it. Refused past the limit, whatever the target.
      const turnHop = Number(context.callerHop) || 0;
      const chained = (hop) => {
        if (hop > MAX_BOT_HOPS) throw new Error(BOT_HOP_LIMIT_ERROR);
        return hop;
      };
      if (origin) {
        const hop = chained(origin.target === 'session' ? turnHop + 1 : turnHop);
        if (hop > 0) origin = { ...origin, hop };
        if (botChain.length) origin = { ...origin, botChain };
        // The task session a bot created acts as the sending conversation does
        // from now on (attended chat or run); another's session keeps its own.
        if (origin.target !== 'session') await rebindDelegation(sessionId, caller);
        await applyEffort();
        const sent = await agentTasks.send(turnSessionId, prompt, origin, submit);
        return { sessionId, ...addressed, ...sent, ...(hop > 0 ? { hop } : {}) };
      }
      const hop = turnHop > 0 ? chained(turnHop + 1) : 0;
      await applyEffort();
      const chainMeta = { ...(hop > 0 ? { hop } : {}), ...(botChain.length ? { botChain } : {}) };
      let accepted;
      if (submit) accepted = (await submit(hop > 0 ? { transcriptMeta: { hop } } : {})).accepted;
      else {
        // New work from this sender: a delegated target acts as the sender does.
        await rebindDelegation(sessionId, caller);
        const result = await service.submitSession({
          sessionId,
          prompt,
          options: { mode: 'prompt', transcriptMeta: { sender: 'lead', ...chainMeta } },
        });
        accepted = result.accepted === true;
      }
      return {
        sessionId,
        ...addressed,
        accepted,
        reportsBack: false,
        ...(accepted ? { reportsBackReason: NOT_BOT_REASON } : {}),
        ...(hop > 0 ? { hop } : {}),
      };
    }
    if (action === 'cancel') {
      // A room's exchange is run by the desktop room host, so its stop (the UI
      // stop button) ends it; the log is not a session the service can abort.
      if (roomIdOfSession(sessionId)) {
        let host;
        try {
          host = agentRoomHost();
        } catch (error) {
          throw new Error(`session: cannot cancel ${sessionId}: ${error.message}`);
        }
        return { sessionId, aborted: host.stop(sessionId) === true };
      }
      const result = await service.abortSession({ sessionId });
      return { sessionId, aborted: result.aborted === true };
    }
    if (action === 'delete') {
      const result = await service.configureSession(
        { sessionId, action: 'deleteSession', args: [sessionId] },
        { revision: 1 }
      );
      return { sessionId, deleted: result.value === true };
    }
    if (action === 'read') {
      const result = await service.readSession({ sessionId, transcriptRange: { offset, limit } });
      return sessionReadOutput(sessionId, result.range, { textOffset, itemId: args.item_id });
    }
    const result = await service.readSession({
      sessionId,
      transcriptItemLimit: action === 'status' ? 1 : limit,
      transcriptByteBudget: SESSION_TOOL_OUTPUT_BYTES,
    });
    const snapshot = result.full;
    if (!snapshot) throw new Error(`session: ${sessionId} is unavailable`);
    return {
      sessionId,
      title: snapshot.title ?? null,
      cwd: snapshot.cwd ?? null,
      provider: snapshot.provider ?? null,
      model: snapshot.model ?? null,
      effort: snapshot.effort ?? null,
      autoEffort: snapshot.autoEffort ?? null,
      fast: snapshot.fast ?? null,
      busy: snapshot.busy === true,
      quotaResume: snapshot.quotaResume ?? null,
    };
  };
}
