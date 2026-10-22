// Tools that steer the session itself: the working directory, goals, and
// agent dispatch.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { listProjects } from '../../runtime/shared/projects.mjs';
import { applySessionSidebarChange } from '../../runtime/shared/session-sidebar-host.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { AGENT_MODE, resolveSessionMode } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { agentIdOfHomeSession } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { turnHopOf } from '../../runtime/shared/bot-hops.mjs';
import { scheduleCallerScope } from '../services/schedule-access.mjs';
import { worktreeCallerScope } from '../services/worktree-access.mjs';
import { resolveHandoffAttachments, sessionRoots } from '../handoff-attachments.mjs';

const USER_TITLE_ERROR = 'session: the user already titled this session; the title was not changed';

/** The agent an attended agent conversation (an agent's home thread, or its
 *  member session in a group room, where the user is present too) acts as;
 *  '' for every other caller: delegated workers, coding sessions (task
 *  sessions included) and unattended schedule/webhook runs. */
function attendedAgentOf(session) {
  const { mode, agentId } = resolveSessionMode({ session });
  const { kind } = scheduleCallerScope(session);
  return mode === AGENT_MODE && (kind === 'human' || kind === 'agent' || kind === 'room-member') ? agentId : '';
}

/** The caller's `attachments` as stored prompt parts, resolved against its own
 *  conversation and folders (handoff-attachments.mjs). */
function callerAttachmentParts(rt, args, callerCwd, surface) {
  return resolveHandoffAttachments(args?.attachments, {
    messages: rt.session?.messages,
    roots: sessionRoots(rt.session, callerCwd),
    cwd: callerCwd,
    surface,
  }).parts;
}

export function createWorkspaceToolHandlers({
  rt,
  goalRuntime,
  agentTool,
  notifyFnForSession,
  getWorkspaceApi = () => null,
  getSessionManager = () => null,
  getLifecycleApi = () => null,
  executeSessionControl = null,
}) {
  const assertLead = (action, callerCtx) => {
    const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
    if (!rt.session?.id || callerSessionId !== rt.session.id) {
      throw new Error(`session: ${action} belongs to the Lead session`);
    }
    return rt.session.id;
  };

  const SIDEBAR_ACTIONS = new Set(['favorite', 'archive']);

  // Sidebar flags only (the desktop's favorite/archive metadata).
  const sidebarAction = async (action, args, callerCtx) => {
    const sessionId = assertLead(action, callerCtx);
    if (typeof args?.value !== 'boolean') throw new Error(`session: value (boolean) is required for action=${action}`);
    const change = action === 'favorite' ? { favorite: args.value } : { archived: args.value };
    try {
      await applySessionSidebarChange(sessionId, change);
    } catch (error) {
      throw new Error(`session: ${action} failed (${error?.message || error})`);
    }
    return JSON.stringify({ action, sessionId, ...change }, null, 2);
  };

  const session = async (args, { callerCtx, callerCwd }) => {
    const action = clean(args?.action || (args?.path ? 'set-project' : 'status')).toLowerCase();
    const target = clean(args?.session_id);
    if (
      ['list', 'bots', 'read', 'send', 'cancel', 'delete', 'create'].includes(action) ||
      (action === 'status' && target)
    ) {
      const callerSessionId = assertLead(action, callerCtx);
      const callerAgentId = attendedAgentOf(rt.session);
      if (action === 'create' && !callerAgentId) {
        throw new Error(
          'session: create belongs to a bot conversation; delegated workers, agent task sessions and schedule/webhook runs cannot create agent task sessions'
        );
      }
      // A task session reaches its agent only through its reported result.
      const origin = rt.session?.taskOrigin;
      if (
        action === 'send' &&
        origin &&
        (target === origin.sessionId || agentIdOfHomeSession(target) === origin.agentId)
      ) {
        throw new Error('session: a task session reports to its agent only through its result');
      }
      if (typeof executeSessionControl !== 'function') {
        throw new Error('session: cross-session control is unavailable in this runtime');
      }
      const { attachments, ...rest } = args || {};
      if (attachments !== undefined && action !== 'send' && action !== 'create') {
        throw new Error(`session: attachments apply to send and create, not action=${action}`);
      }
      const attachmentParts = callerAttachmentParts(rt, args, callerCwd, 'session');
      return JSON.stringify(
        await executeSessionControl(
          { ...rest, action },
          {
            callerSessionId,
            callerAgentId,
            callerCwd,
            ...(action === 'send' || action === 'create' ? { callerHop: turnHopOf(rt.session) } : {}),
            // Whether a create may provision a worktree (worktree-access.mjs).
            ...(action === 'create' ? { callerScope: worktreeCallerScope(rt.session) } : {}),
            // Which bots and sessions it may see (bot-status.mjs).
            ...(action === 'bots' || action === 'list' ? { callerScope: scheduleCallerScope(rt.session) } : {}),
            ...(attachmentParts.length ? { attachmentParts } : {}),
          }
        )
      );
    }
    if (target && target !== assertLead(action, callerCtx)) {
      throw new Error(`session: action=${action} only applies to the current session`);
    }
    if (SIDEBAR_ACTIONS.has(action)) return sidebarAction(action, args, callerCtx);
    let currentCwd = callerCwd;
    if (action === 'status' || action === 'list-projects' || action === 'set-project') assertLead(action, callerCtx);
    if (action === 'rename') {
      const sessionId = assertLead(action, callerCtx);
      if (rt.config?.aiSessionTitles === false) throw new Error('session: AI session titles are disabled in settings');
      const title = clean(args?.title);
      if (!title) throw new Error('session: title is required for action=rename');
      const result = await getSessionManager()?.updateSessionAiTitle(sessionId, title);
      if (!result?.ok) {
        throw new Error(
          result?.reason === 'user-title'
            ? USER_TITLE_ERROR
            : `session: rename failed (${result?.reason || 'unavailable'})`
        );
      }
      // Mirror the store's truth onto the live session, never the AI title
      // itself: a manual rename that landed while the save was awaited wins.
      const stored = getSessionManager()?.getSession?.(sessionId);
      if (stored && rt.session?.id === sessionId && stored !== rt.session) {
        rt.session.title = stored.title;
        rt.session.titleLocked = stored.titleLocked;
        rt.session.titleSource = stored.titleSource;
        rt.session.titleUpdatedAt = stored.titleUpdatedAt;
      }
      if (stored && stored.titleSource === 'user') throw new Error(USER_TITLE_ERROR);
      return JSON.stringify({ action, sessionId, title: result.title }, null, 2);
    }
    if (action === 'compact') {
      const sessionId = assertLead(action, callerCtx);
      rt.pendingCompactSessionIds ??= new Set();
      rt.pendingCompactSessionIds.add(sessionId);
      return JSON.stringify(
        { action, sessionId, scheduled: true, note: 'Compaction runs right after the current turn finishes.' },
        null,
        2
      );
    }
    if (action === 'fork') {
      const sessionId = assertLead(action, callerCtx);
      const lifecycle = getLifecycleApi();
      if (typeof lifecycle?.inheritToNewSession !== 'function') {
        throw new Error('session: fork is unavailable in this runtime');
      }
      const result = await lifecycle.inheritToNewSession(sessionId, {
        compact: args?.compact === true,
        titleSuffix: ' (Fork)',
      });
      return JSON.stringify(
        { action, sourceSessionId: sessionId, sessionId: result.sessionId, compacted: result.compacted === true },
        null,
        2
      );
    }
    if (action === 'status') {
      const current = rt.session;
      return JSON.stringify(
        {
          sessionId: callerCtx?.callerSessionId || current?.id || null,
          title: current?.title || null,
          titleSource: current?.titleSource || null,
          cwd: currentCwd,
          project: current?.workspace?.projectPath || current?.desktopSession?.projectPath || currentCwd,
          provider: current?.provider || null,
          model: current?.model || null,
        },
        null,
        2
      );
    }
    if (action === 'list-projects') {
      return JSON.stringify(
        {
          cwd: currentCwd,
          projects: listProjects().map((project) => ({ name: project.name, path: project.path })),
        },
        null,
        2
      );
    }
    if (action === 'set-project') {
      const rawPath = clean(args?.path);
      if (!rawPath) throw new Error('session: path is required for action=set-project');
      const nextCwd = resolve(callerCwd || process.cwd(), rawPath);
      const stat = statSync(nextCwd);
      if (!stat.isDirectory()) throw new Error(`session: not a directory: ${nextCwd}`);
      // The Lead's own call: the runtime's Project switch authority admits it
      // during the calling turn and refuses inside a managed worktree.
      if (typeof callerCtx?.setCallerCwd === 'function') {
        currentCwd = clean(await callerCtx.setCallerCwd(nextCwd)) || nextCwd;
      } else {
        const workspace = getWorkspaceApi();
        if (!workspace) throw new Error('session: set-project is unavailable in this runtime');
        currentCwd = await workspace.switchProject(nextCwd, { ownTurn: true });
      }
    } else {
      throw new Error(`session: unknown action "${action}"`);
    }
    return JSON.stringify(
      {
        cwd: currentCwd,
        sessionId: callerCtx?.callerSessionId || rt.session?.id || null,
      },
      null,
      2
    );
  };

  return {
    session,
    goal: async (args, { name, callerCtx }) =>
      await goalRuntime.executeTool(name, args || {}, {
        callerSessionId: callerCtx?.callerSessionId || rt.session?.id || rt.reservedSessionId || null,
      }),
    agent: async (args, { callerCtx, callerCwd }) => {
      const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
      // `attachmentParts` is never the model's to set: only the resolved
      // `attachments` reach the agent's turn.
      const { attachments, attachmentParts: _ignored, ...rest } = args || {};
      const attachmentParts = callerAttachmentParts(rt, { attachments }, callerCwd, 'agent');
      return await agentTool.execute(attachmentParts.length ? { ...rest, attachmentParts } : rest, {
        callerCwd,
        invocationSource: 'model-tool',
        callerSessionId,
        clientHostPid: callerCtx?.clientHostPid || rt.session?.clientHostPid || process.pid,
        signal: callerCtx?.signal,
        notifyFn: notifyFnForSession(callerSessionId),
        // The jobs this call starts are recorded under it (agent-task-starts.mjs).
        ...(callerCtx?.toolCallId ? { toolCallId: callerCtx.toolCallId } : {}),
      });
    },
  };
}
