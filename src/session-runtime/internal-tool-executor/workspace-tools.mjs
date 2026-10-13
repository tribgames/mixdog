// Tools that steer the session itself: the working directory, goals, and
// agent dispatch.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { listProjects } from '../../runtime/shared/projects.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

export function createWorkspaceToolHandlers({
  rt,
  goalRuntime,
  agentTool,
  notifyFnForSession,
  applyResolvedCwd,
  getWorkspaceApi = () => null,
}) {
  // The Lead's own worktree, on the user's request: the same authority the
  // branch chip menu drives, tolerating the calling turn but nothing else
  // running (workers, background shells).
  const worktreeAction = async (action, args, callerCtx) => {
    const workspace = getWorkspaceApi();
    if (!workspace) throw new Error(`cwd: ${action} is unavailable in this runtime`);
    const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
    if (!rt.session?.id || callerSessionId !== rt.session.id) {
      throw new Error(`cwd: ${action} belongs to the Lead session`);
    }
    const result =
      action === 'merge-worktree'
        ? await workspace.mergeWorkspace({ confirmed: true }, { ownTurn: true })
        : action === 'remove-worktree'
          ? await workspace.removeWorktree({ force: args?.force === true }, { ownTurn: true })
          : action === 'list-worktrees'
            ? await workspace.listWorktrees()
            : await workspace.pruneWorktrees();
    return JSON.stringify({ action, cwd: rt.currentCwd, result }, null, 2);
  };

  const WORKTREE_ACTIONS = new Set(['merge-worktree', 'remove-worktree', 'list-worktrees', 'prune-worktrees']);

  const cwd = async (args, { callerCtx, callerCwd }) => {
    const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
    if (WORKTREE_ACTIONS.has(action)) return worktreeAction(action, args, callerCtx);
    let currentCwd = callerCwd;
    if (action === 'list') {
      return JSON.stringify(
        {
          cwd: currentCwd,
          projects: listProjects().map((project) => ({ name: project.name, path: project.path })),
        },
        null,
        2
      );
    }
    if (action === 'set') {
      const rawPath = clean(args?.path);
      if (!rawPath) throw new Error('cwd: path is required for action=set');
      const nextCwd = resolve(callerCwd || process.cwd(), rawPath);
      const stat = statSync(nextCwd);
      if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${nextCwd}`);
      currentCwd =
        typeof callerCtx?.setCallerCwd === 'function'
          ? clean(await callerCtx.setCallerCwd(nextCwd)) || nextCwd
          : applyResolvedCwd(nextCwd, { persistProjectSelection: true });
    } else if (action !== 'get') {
      throw new Error(`cwd: unknown action "${action}"`);
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
    cwd,
    goal: async (args, { name, callerCtx }) =>
      await goalRuntime.executeTool(name, args || {}, {
        callerSessionId: callerCtx?.callerSessionId || rt.session?.id || rt.reservedSessionId || null,
      }),
    agent: async (args, { callerCtx, callerCwd }) => {
      const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
      return await agentTool.execute(args, {
        callerCwd,
        invocationSource: 'model-tool',
        callerSessionId,
        clientHostPid: callerCtx?.clientHostPid || rt.session?.clientHostPid || process.pid,
        signal: callerCtx?.signal,
        notifyFn: notifyFnForSession(callerSessionId),
      });
    },
  };
}
