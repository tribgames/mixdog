import {
  sessionListOutput,
  sessionReadOutput,
  SESSION_TITLE_LIMIT,
  SESSION_TOOL_OUTPUT_BYTES,
} from './session-tool-output.mjs';
import { createAgentTaskSessions, taskSessionPendingWork } from '../session-runtime/agent-task-sessions.mjs';
import { createBotStatus, scanCatalog, scopedBot } from '../session-runtime/bot-status.mjs';
import { handoffContent } from '../session-runtime/handoff-attachments.mjs';
import { BOT_TARGET_ACTIONS, isBotShaped, unknownBotError } from '../session-runtime/bot-target.mjs';
import { checkEffort, readModelCatalog } from '../session-runtime/task-session-route.mjs';
import { assertBotChainTarget, botChainOf } from '../runtime/shared/bot-hops.mjs';
import { agentIdOfHomeSession } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { rebindDelegation } from '../runtime/agent/orchestrator/session/human-gate/delegation.mjs';
import { readSessionSidebarState } from '../runtime/shared/session-sidebar-host.mjs';
import { roomIdOfSession } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { escapeHarnessTags } from '../runtime/shared/shell-output-summary.mjs';
import { truncateToolText } from '../runtime/shared/tool-primitives.mjs';
import { requestCaller, targetRequest } from './daemon-session-control/request.mjs';
import { createWorktreeControl } from './daemon-session-control/worktree-control.mjs';
import { createRouteControl } from './daemon-session-control/route-control.mjs';
import {
  TOP_CURSOR,
  assertListFlags,
  listOutputOptions,
  listRowFilter,
  listedSessions,
  liveCandidates,
  liveRowOverlay,
  pinnedLiveRows,
} from './daemon-session-control/list-page.mjs';
import { roomAddressee, roomSubmitter, stopRoomExchange } from './daemon-session-control/room-host.mjs';
import {
  assertSendRequest,
  chainedHop,
  chainedOrigin,
  effortApplier,
  unreportedSendResult,
} from './daemon-session-control/send-turn.mjs';

/** Sessions with live work now, from the sources the Agents pool reads:
 *  `own` (id → its latest sign of work, epoch ms) — a turn in flight in this
 *  process, or a pool row still running or queued (worker index
 *  status/stage); `agents` — the Leads such an Agent session works for. */
async function storedLiveWork() {
  const [
    { inFlightSessionActivity },
    { listStoredAgentWorkersAsync },
    { hasPendingAgentWork, sessionsWithPendingWork },
  ] = await Promise.all([
    import('../runtime/agent/orchestrator/session/manager/runtime-state.mjs'),
    import('../runtime/agent/orchestrator/session/store-agent-worker-rows.mjs'),
    import('../runtime/shared/pending-agent-work.mjs'),
  ]);
  const { working, agentWorking } = inFlightSessionActivity();
  const pool = await listStoredAgentWorkersAsync({ runningSessionIds: working });
  const now = Date.now();
  const own = new Map([...working].map((id) => [id, now]));
  for (const row of pool) {
    const id = String(row?.sessionId || '');
    if (id && !own.has(id) && hasPendingAgentWork(row)) own.set(id, Date.parse(row.updatedAt) || 0);
  }
  return { own, agents: new Set([...agentWorking, ...sessionsWithPendingWork(pool)]) };
}

/** The catalog row of `sessionId` read by id, or null when the catalog would not list it. */
async function storedCatalogRow(sessionId) {
  const { readStoredSessionCatalogRow } = await import(
    '../runtime/agent/orchestrator/session/store-summary-reader.mjs'
  );
  return readStoredSessionCatalogRow(sessionId);
}

/** The stored title of `sessionId` (its session record), or null. */
async function storedTitle(sessionId) {
  const { readStoredSessionTranscript } = await import(
    '../runtime/agent/orchestrator/session/store-summary-reader.mjs'
  );
  return (await readStoredSessionTranscript(sessionId, { metadataOnly: true }))?.title || null;
}

/** Model-facing session operations over the same service used by desktop and TUI. */
export function createSessionControl({
  getSessionService,
  agentTasks = createAgentTaskSessions({ getSessionService }),
  listBots = undefined,
  botStatus = createBotStatus({ getSessionService, listBots }),
  // Agent work a session handed off and still waits on (agent-task-sessions.mjs).
  pendingWork = taskSessionPendingWork,
  liveWork = storedLiveWork,
  readRow = storedCatalogRow,
  readTitle = storedTitle,
}) {
  const worktreeControl = createWorktreeControl(getSessionService);
  const routeControl = createRouteControl(getSessionService);

  async function control(args = {}, context = {}) {
    const action = args.action;
    const caller = requestCaller(action, context);
    // `callerAgentId`: set only for an attended agent conversation (workspace-tools.mjs).
    if (action === 'create') return agentTasks.create(args, context);
    if (action === 'worktree') return worktreeControl(args, caller, context.callerScope);
    // The setup tool's per-session route actions (authorized by the setup executor).
    if (action === 'route') return routeControl(args, caller);
    // `callerScope`: the caller's schedule-access scope (workspace-tools.mjs).
    if (action === 'bots') return botStatus(args, context);
    const { sessionId, limit, offset, textOffset } = targetRequest(args, action, caller);
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    if (action === 'list') {
      assertListFlags(args);
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
      const keep = listRowFilter(args, archived);
      // Live work is overlaid on every row: a catalog row keeps the status and
      // recency of its last settled turn, so a long-running agent read `idle`
      // and sorted by its first prompt. The first page lists the live rows
      // first (newest sign of work first); a later page keeps catalog order,
      // where such a row may show again (never skipped).
      const live = await liveWork();
      const withLive = liveRowOverlay(live);
      // Each live session's row is read by id (wherever it sits in the
      // catalog), filtered like the listing, and the newest `limit` lead.
      const candidates = liveCandidates(live);
      let pinned = [];
      if (!args.cursor && candidates.length) {
        pinned = pinnedLiveRows(await Promise.all(candidates.map((id) => readRow(id))), keep, withLive, limit);
      }
      const pinnedIds = new Set(pinned.map((row) => row.id));
      const want = limit - pinned.length;
      // Bounded: past 10000 rows scanned with fewer than `limit` matching, the
      // page ends (possibly empty) with a nextCursor to continue from.
      const scan =
        want > 0
          ? await scanCatalog(service, (row) => !pinnedIds.has(row.id) && keep(row), {
              cursor: args.cursor || null,
              want,
              maxRows: 10_000,
            })
          : { rows: [], nextCursor: TOP_CURSOR };
      const sessions = listedSessions(pinned, scan.rows, withLive, archived);
      return sessionListOutput({ sessions, nextCursor: scan.nextCursor }, limit, listOutputOptions(own, pinnedIds));
    }
    if (action === 'send') {
      assertSendRequest(args, sessionId);
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
      const submit = room ? roomSubmitter(room, sessionId, prompt, from) : null;
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
        applyEffort = effortApplier(service, sessionId, level);
      }
      // A send made in a bot-descended turn (`callerHop` > 0), or by a bot to
      // another session, extends the chain by one; a bot's own task session
      // only continues it. Refused past the limit, whatever the target.
      const turnHop = Number(context.callerHop) || 0;
      if (origin) {
        const hop = chainedHop(origin.target === 'session' ? turnHop + 1 : turnHop);
        origin = chainedOrigin(origin, hop, botChain);
        // The task session a bot created acts as the sending conversation does
        // from now on (attended chat or run); another's session keeps its own.
        if (origin.target !== 'session') await rebindDelegation(sessionId, caller);
        await applyEffort();
        const sent = await agentTasks.send(turnSessionId, prompt, origin, submit);
        return { sessionId, ...addressed, ...sent, ...(hop > 0 ? { hop } : {}) };
      }
      const hop = turnHop > 0 ? chainedHop(turnHop + 1) : 0;
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
      return unreportedSendResult(sessionId, addressed, accepted, hop);
    }
    if (action === 'cancel') {
      // A room's exchange is run by the desktop room host, so its stop (the UI
      // stop button) ends it; the log is not a session the service can abort.
      if (roomIdOfSession(sessionId)) return stopRoomExchange(sessionId);
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
    // The snapshot carries no title: it lives on the session record. Quoted
    // like a listed title.
    const title = await readTitle(sessionId);
    return {
      sessionId,
      title: title ? escapeHarnessTags(truncateToolText(title, SESSION_TITLE_LIMIT)) : null,
      cwd: snapshot.cwd ?? null,
      provider: snapshot.provider ?? null,
      model: snapshot.model ?? null,
      effort: snapshot.effort ?? null,
      autoEffort: snapshot.autoEffort ?? null,
      fast: snapshot.fast ?? null,
      busy: snapshot.busy === true,
      // A Lead idle between turns while its agents run is still working:
      // their results wake it, so `busy` alone would read as stalled.
      agentsWorking: (await pendingWork(sessionId)) === true,
      quotaResume: snapshot.quotaResume ?? null,
    };
  }

  return async function executeSessionControl(args = {}, context = {}) {
    try {
      return await control(args, context);
    } catch (error) {
      // A bot id is resolved to its home chat before this (workspace-tools.mjs),
      // so a bot-shaped id the session service found no session for is no bot
      // either: say which ids are.
      const id = typeof args.session_id === 'string' ? args.session_id.trim() : '';
      const missing = [`${id} is not available`, `${id} is unavailable`].some((text) => error?.message?.includes(text));
      if (!BOT_TARGET_ACTIONS.has(args.action) || !isBotShaped(id) || !missing) throw error;
      throw await unknownBotError(id, listBots, error);
    }
  };
}
