import { SESSION_ID_PATTERN } from '../runtime/agent/orchestrator/runtime-core/session-id.mjs';
import { sessionListOutput, sessionReadOutput, SESSION_TOOL_OUTPUT_BYTES } from './session-tool-output.mjs';
import { createAgentTaskSessions } from '../session-runtime/agent-task-sessions.mjs';
import { createBotStatus, scanCatalog, scopedBot, sessionBotOf } from '../session-runtime/bot-status.mjs';
import { handoffContent } from '../session-runtime/handoff-attachments.mjs';
import { BOT_HOP_LIMIT_ERROR, MAX_BOT_HOPS } from '../runtime/shared/bot-hops.mjs';
import { rebindDelegation } from '../runtime/agent/orchestrator/session/human-gate/delegation.mjs';
import { isAgentOnlySession } from '../runtime/agent/orchestrator/session/store-summary-visibility.mjs';
import { readSessionSidebarState } from '../runtime/shared/session-sidebar-host.mjs';

const TARGET_ACTIONS = new Set(['status', 'read', 'send', 'cancel', 'delete']);
const MUTATING_ACTIONS = new Set(['send', 'cancel', 'delete']);
// Why a send from a conversation that is no bot's reports nothing back.
const NOT_BOT_REASON = 'only a bot conversation gets session results reported back; check that session for the result';

/** Model-facing session operations over the same service used by desktop and TUI. */
export function createSessionControl({
  getSessionService,
  agentTasks = createAgentTaskSessions({ getSessionService }),
  botStatus = createBotStatus({ getSessionService }),
}) {
  return async function executeSessionControl(args = {}, context = {}) {
    const action = args.action;
    if (action !== 'list' && action !== 'create' && action !== 'bots' && !TARGET_ACTIONS.has(action)) {
      throw new Error(`session: unsupported remote action "${action}"`);
    }
    const caller = context.callerSessionId;
    if (typeof caller !== 'string' || !SESSION_ID_PATTERN.test(caller)) {
      throw new Error('session: caller session is required');
    }
    // `callerAgentId`: set only for an attended agent conversation (workspace-tools.mjs).
    if (action === 'create') return agentTasks.create(args, context);
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
      // list everything, a bot (or its unattended run) only its own sessions,
      // anything else the plain rows without previews. Sub-agent sessions (a
      // parent finds its own through the agent tool) and archived ones (the
      // desktop's flag) only on request; the scan pages past the rows left
      // out, so a page is never short while more rows match.
      const own = scopedBot(context.callerScope);
      const archived = (await readSessionSidebarState())?.archived ?? {};
      const keep = (row) =>
        (!own || sessionBotOf(row) === own) &&
        (args.include_agents === true || !isAgentOnlySession(row)) &&
        (args.include_archived === true || !Object.hasOwn(archived, row.id));
      const scan = await scanCatalog(service, keep, { cursor: args.cursor || null, want: limit, maxRows: Infinity });
      const sessions = scan.rows.map((row) => (Object.hasOwn(archived, row.id) ? { ...row, archived: true } : row));
      return sessionListOutput({ sessions, nextCursor: scan.nextCursor }, limit, { rich: own !== null });
    }
    if (action === 'send') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new Error('session: prompt is required for action=send');
      }
      // An agent conversation's send reports its turn back to the agent's
      // home: a task session it created by its stored origin, any other
      // session by an origin for this send only.
      // Forwarded files ride along as stored attachment parts (workspace-tools.mjs).
      const prompt = handoffContent(args.prompt, context.attachmentParts);
      let origin = await agentTasks.reportOrigin(sessionId, context.callerAgentId, caller);
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
        // The task session a bot created acts as the sending conversation does
        // from now on (attended chat or run); another's session keeps its own.
        if (origin.target !== 'session') await rebindDelegation(sessionId, caller);
        const sent = await agentTasks.send(sessionId, prompt, origin);
        return { sessionId, ...sent, ...(hop > 0 ? { hop } : {}) };
      }
      const hop = turnHop > 0 ? chained(turnHop + 1) : 0;
      // New work from this sender: a delegated target acts as the sender does.
      await rebindDelegation(sessionId, caller);
      const result = await service.submitSession({
        sessionId,
        prompt,
        options: { mode: 'prompt', transcriptMeta: { sender: 'lead', ...(hop > 0 ? { hop } : {}) } },
      });
      const accepted = result.accepted === true;
      return {
        sessionId,
        accepted,
        reportsBack: false,
        ...(accepted ? { reportsBackReason: NOT_BOT_REASON } : {}),
        ...(hop > 0 ? { hop } : {}),
      };
    }
    if (action === 'cancel') {
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
      busy: snapshot.busy === true,
      quotaResume: snapshot.quotaResume ?? null,
    };
  };
}
