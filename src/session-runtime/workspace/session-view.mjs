/**
 * The hosted Lead's workspace as the transitions read it: the session this
 * runtime hosts, its stored (or project-folder) workspace record, the live
 * view the session snapshot publishes and the branch menu.
 */
import { isDeepStrictEqual } from 'node:util';
import {
  branchMenuEntries,
  isWorktreeBound,
  normalizeSessionWorkspace,
  worktreeError,
} from '../../runtime/shared/worktrees/contract.mjs';
import { samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { readGitHead } from '../../runtime/shared/worktrees/git-head.mjs';
import { readSessionWorkspace } from './workspace-state.mjs';

/**
 * @param {object} deps The host hooks of createWorkspaceTransitions plus its
 *   `backend()` loader and `pendingWorktree()` (the armed worktree intent).
 */
export function createSessionWorkspaceView({
  getSession,
  getCurrentCwd,
  getDesktopSession,
  createCurrentSession,
  inspectProject,
  backend,
  pendingWorktree,
}) {
  function hostedSession(sessionRef) {
    const session = getSession();
    const requested = String(sessionRef?.sessionId || '').trim();
    if (!session?.id || (requested && requested !== session.id)) {
      throw new Error(`workspace: session ${requested || '(none)'} is not hosted by this runtime.`);
    }
    return session;
  }

  async function ensureSession() {
    if (!getSession()?.id && typeof createCurrentSession === 'function') await createCurrentSession('workspace');
    return hostedSession(null);
  }

  function projectPathOf(session) {
    const desktop = getDesktopSession?.() || session?.desktopSession;
    if (desktop?.classification === 'project' && desktop.projectPath) return desktop.projectPath;
    return session?.cwd || getCurrentCwd();
  }

  /** The stored record, or the project-folder workspace (revision 0) of a session that never moved. */
  function currentWorkspace(session) {
    const stored = readSessionWorkspace(session);
    if (stored) return stored;
    const projectPath = projectPathOf(session);
    return normalizeSessionWorkspace({ projectPath, cwd: getCurrentCwd() || projectPath, revision: 0 });
  }

  let liveWorkspace = null;

  /**
   * The workspace the session publishes: a worktree-bound record as stored; a
   * project-folder session (never moved, back from a worktree, or carrying a
   * transition stub) with the folder's checked-out branch / detached commit and
   * repoCommonDir read straight from HEAD — no git process. Null outside a git
   * repository for a session without a record. Identity-stable while equal.
   */
  function getLiveWorkspace() {
    const session = getSession();
    const stored = readSessionWorkspace(session);
    if (isWorktreeBound(stored)) return session.workspace;
    let base;
    try {
      base = stored ?? currentWorkspace(session);
    } catch {
      return session?.workspace ?? null;
    }
    const head = readGitHead(base.cwd);
    if (!head) return session?.workspace ?? null;
    const next = {
      ...base,
      repoCommonDir: head.repoCommonDir,
      branch: head.branch,
      baseCommit: head.branch ? base.baseCommit : head.commit,
    };
    if (!liveWorkspace || !isDeepStrictEqual(liveWorkspace, next)) liveWorkspace = next;
    return liveWorkspace;
  }

  /** WORKTREE_PROJECT_MISMATCH unless `repoCommonDir` (when given) is the session Project's repository. */
  async function sessionProject(session, repoCommonDir) {
    const workspace = currentWorkspace(session);
    const project = await inspectProject(workspace.projectPath);
    if (repoCommonDir && !samePath(repoCommonDir, project.repoCommonDir)) {
      throw worktreeError(
        'WORKTREE_PROJECT_MISMATCH',
        "Managed worktrees belong to this session's Project repository; run the command there.",
        { projectPath: workspace.projectPath, repoCommonDir }
      );
    }
    return { workspace, project };
  }

  async function getBranchMenu() {
    const session = getSession();
    const workspace = session?.id
      ? currentWorkspace(session)
      : normalizeSessionWorkspace({ projectPath: projectPathOf(null), cwd: getCurrentCwd(), revision: 0 });
    const menu = await (await backend()).listBranchOccupancy({
      projectPath: workspace.projectPath,
      sessionId: session?.id || null,
    });
    const selectedEntry = workspace.worktreeId ? await (await backend()).findWorktreeContaining(workspace.cwd) : null;
    // A session outside a managed worktree (the project folder — never moved,
    // or back from a worktree — or a linked checkout of the selected branch)
    // is on whatever that folder has checked out now.
    // Its repository is the project's (a never-moved session has no stored
    // record), and a detached checkout shows branch null with the commit in
    // baseCommit — never mistaken for "not a repository".
    let view = workspace;
    if (!isWorktreeBound(workspace)) {
      const project = await inspectProject(workspace.cwd);
      const checkedOut = project.currentBranch ?? null;
      view = {
        ...workspace,
        repoCommonDir: project.repoCommonDir ?? workspace.repoCommonDir,
        branch: checkedOut,
        baseCommit: checkedOut ? workspace.baseCommit : (project.headCommit ?? null),
      };
    }
    return {
      workspace: view,
      pendingWorktree: pendingWorktree(),
      branches: branchMenuEntries(menu.branches, menu.occupancy),
      occupancy: menu.occupancy,
      retainedWorktree: selectedEntry ?? menu.retainedWorktree ?? null,
      // Creation notes of the retained worktree (submodules, include entries).
      warnings: Array.isArray(menu.retainedWorktree?.warnings) ? [...menu.retainedWorktree.warnings] : [],
    };
  }

  return {
    hostedSession,
    ensureSession,
    currentWorkspace,
    getLiveWorkspace,
    sessionProject,
    getBranchMenu,
  };
}
