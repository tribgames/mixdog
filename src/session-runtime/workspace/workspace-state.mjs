/**
 * Session workspace record helpers: reading the durable `workspace` field,
 * keeping it consistent when the cwd tool switches Projects, restoring it on
 * resume (missing worktree → recovery), and carrying the Project's memory
 * identity into a new worktree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdsNoData, writeFileAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { isWorktreeBound, nextRevision, normalizeSessionWorkspace } from '../../runtime/shared/worktrees/contract.mjs';
import { isWithin, samePath } from '../../runtime/shared/worktrees/paths.mjs';
import { resolveProjectId } from '../../runtime/memory/lib/project-id-resolver.mjs';
import { setWorkspaceCwdLock } from './admission-gate.mjs';

/** The session's persisted workspace, or null when absent or malformed. */
export function readSessionWorkspace(session) {
  if (!session?.workspace) return null;
  try {
    return normalizeSessionWorkspace(session.workspace);
  } catch {
    return null;
  }
}

/**
 * A manual Project selection (cwd tool / setCwd) while a workspace record
 * exists. Moving inside the bound worktree keeps the record; any other
 * directory is a Project switch and leaves the worktree (still retained) at a
 * new revision. Returns the record to store and the Project path the desktop
 * metadata must carry.
 * @returns {{ workspace: object|null, projectPath: string }}
 */
export function workspaceForProjectSelection(session, cwd) {
  const current = readSessionWorkspace(session);
  if (!current) return { workspace: session?.workspace ?? null, projectPath: cwd };
  if (isWorktreeBound(current) && isWithin(current.cwd, cwd)) {
    return { workspace: session.workspace, projectPath: current.projectPath };
  }
  if (!isWorktreeBound(current) && samePath(current.cwd, cwd)) {
    return { workspace: session.workspace, projectPath: cwd };
  }
  return {
    workspace: normalizeSessionWorkspace({ projectPath: cwd, cwd, revision: nextRevision(current) }),
    projectPath: cwd,
  };
}

/**
 * Where a session that replaces `session` (/new, /clear) starts: the Project
 * folder when `session` is bound to a worktree — that worktree belongs to the
 * session being left — else null (keep the current cwd).
 * @returns {string|null}
 */
export function replacementSessionCwd(session) {
  const workspace = readSessionWorkspace(session);
  return isWorktreeBound(workspace) ? workspace.projectPath : null;
}

/**
 * Execution root of a worktree-bound session for resume: the worktree when it
 * exists, else the Project folder flagged `missing`. Null when not bound.
 * @returns {{ cwd: string, missing: boolean }|null}
 */
export function boundWorkspaceCwd(session) {
  const workspace = readSessionWorkspace(session);
  if (!isWorktreeBound(workspace)) return null;
  if (existsSync(workspace.cwd)) return { cwd: workspace.cwd, missing: false };
  return { cwd: workspace.projectPath, missing: true };
}

/**
 * After a resume: a bound session whose worktree vanished enters `recovery`
 * (turns are refused with WORKTREE_MISSING until the user picks a branch or
 * removes the worktree); an intact one re-locks its workers to the worktree.
 */
export function restoreWorkspaceAfterResume(session) {
  const workspace = readSessionWorkspace(session);
  if (!session?.id) return workspace;
  if (!isWorktreeBound(workspace)) {
    setWorkspaceCwdLock(session.id, null);
    return workspace;
  }
  if (existsSync(workspace.cwd)) {
    setWorkspaceCwdLock(session.id, workspace.cwd);
    if (workspace.transition.state !== 'idle') {
      session.workspace = normalizeSessionWorkspace({ ...workspace, transition: { state: 'idle', txId: null } });
    }
    return session.workspace;
  }
  setWorkspaceCwdLock(session.id, null);
  session.workspace = normalizeSessionWorkspace({
    ...workspace,
    transition: { state: 'recovery', txId: `recovery:${workspace.worktreeId}` },
  });
  return session.workspace;
}

/**
 * Carry the Project's memory identity into a worktree that lives outside the
 * Project tree. Runs before anything resolves memory for the worktree (the
 * resolver memoizes per root). No-op when the checkout already has the file
 * or the Project has no identity.
 * @returns {boolean} Whether a file was written.
 */
export function copyProjectIdentity(projectPath, worktreePath) {
  const target = join(worktreePath, '.mixdog', 'project.id');
  // An id file with no data (empty, or NUL-filled by a crash) is missing.
  if (existsSync(target) && !holdsNoData(readFileSync(target))) return false;
  const id = resolveProjectId(projectPath);
  if (!id || holdsNoData(id)) return false;
  writeFileAtomicSync(target, `${id}\n`, { mode: 0o644 });
  return true;
}
