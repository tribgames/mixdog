/**
 * Session-less branch operations on a registered Project's folder (a New
 * Task draft, the source-control dock): its branch menu, a guarded checkout
 * and a guarded merge. They act only on a registered Project (a repository
 * subfolder Project included): a checkout holds the folder (withProjectFolder)
 * while git changes it, a merge takes the shared management path.
 */
import { branchMenuEntries, projectWorkspace, worktreeError } from '../../runtime/shared/worktrees/contract.mjs';
import * as branchManagement from '../../runtime/shared/worktrees/branch-management.mjs';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return value.trim();
}

/**
 * @param {object} deps
 * @param {() => Promise<any>} deps.backend The managed-worktree backend.
 * @param {(path: string) => Promise<any>} deps.inspectProject
 * @param {(path: string) => Promise<string|null>} deps.findRegisteredProject
 * @param {<T>(sessionId: string|null, folder: string, fn: () => Promise<T>) => Promise<T>} deps.withProjectFolder
 * @param {Function} deps.withManagementFolders The shared admission of every merge and cleanup.
 */
export function createProjectBranchOps({
  backend,
  inspectProject,
  findRegisteredProject,
  withProjectFolder,
  withManagementFolders,
}) {
  /** WORKTREE_PROJECT_UNKNOWN unless `projectPath` is a registered Project. */
  async function registeredProject(projectPath) {
    const path = requireText(projectPath, 'projectPath');
    const registered = await findRegisteredProject(path);
    if (!registered) throw worktreeError('WORKTREE_PROJECT_UNKNOWN', undefined, { projectPath: path });
    return registered;
  }

  /**
   * A Project's branch menu with no session: the project folder's workspace
   * and the real occupancy (current / session / external / free).
   */
  async function getProjectBranchMenu({ projectPath } = {}) {
    const path = await registeredProject(projectPath);
    const project = await inspectProject(path);
    const menu = await (await backend()).listBranchOccupancy({ projectPath: path, sessionId: null });
    const workspace = projectWorkspace({
      projectPath: path,
      repoCommonDir: project.repoCommonDir,
      branch: project.currentBranch,
    });
    return {
      // Detached: branch null and the checked-out commit in baseCommit.
      workspace: project.currentBranch ? workspace : { ...workspace, baseCommit: project.headCommit ?? null },
      branches: branchMenuEntries(menu.branches, menu.occupancy),
      occupancy: menu.occupancy,
      retainedWorktree: null,
    };
  }

  /**
   * Check out (or create) `branch` in a Project folder with no session: the
   * same guarded path a session's branch change takes — refused while another
   * session works in the checkout, which is held until the switch is done;
   * the manager's repository lock, occupancy and no-carry (dirty) checks.
   */
  async function selectProjectBranch({
    projectPath,
    branch,
    create = false,
    remote = false,
    startPoint = null,
    detach = null,
  } = {}) {
    const path = await registeredProject(projectPath);
    if (detach !== null) {
      // A history entry checked out detached: the same guard, no branch.
      if (branch !== undefined || create === true || remote === true || startPoint !== null) {
        throw new TypeError('detach excludes branch, create, remote and startPoint.');
      }
      const commit = requireText(detach, 'detach');
      const project = await inspectProject(path);
      return withProjectFolder(null, project.topLevel || path, async () =>
        (await backend()).checkoutProjectBranch({ projectPath: path, detach: commit })
      );
    }
    const name = requireText(branch, 'branch');
    if (create === true && remote === true) throw new TypeError('create and remote are exclusive.');
    if (startPoint !== null && create !== true) throw new TypeError('startPoint needs create.');
    const project = await inspectProject(path);
    if (create !== true && remote !== true && project.currentBranch === name) return { branch: name, changed: false };
    return withProjectFolder(null, project.topLevel || path, async () => {
      const backendApi = await backend();
      return backendApi.checkoutProjectBranch({
        projectPath: path,
        branch: name,
        create: create === true,
        remote: remote === true,
        ...(startPoint !== null ? { startPoint: requireText(startPoint, 'startPoint') } : {}),
      });
    });
  }

  /**
   * Merge a local branch into a Project folder's checked-out branch with no
   * session: `target` is the branch the user confirmed and must still be
   * checked out (WORKTREE_TARGET_MISMATCH). The same guarded path as the
   * branch-row merge (manageProjectBranch): source and destination validated
   * and both folders held.
   */
  async function mergeProjectBranch({ projectPath, branch, target } = {}) {
    const path = await registeredProject(projectPath);
    return branchManagement.mergeConfirmedTarget(
      { projectPath: path, branch: requireText(branch, 'branch'), target: requireText(target, 'target') },
      withManagementFolders
    );
  }

  async function inspectProjectBranch({ projectPath, branch } = {}) {
    const path = await registeredProject(projectPath);
    return branchManagement.inspectProjectBranch({ projectPath: path, branch: requireText(branch, 'branch') });
  }

  async function manageProjectBranch(input = {}) {
    const path = await registeredProject(input.projectPath);
    return branchManagement.manageProjectBranch({ ...input, projectPath: path }, withManagementFolders);
  }

  return { getProjectBranchMenu, selectProjectBranch, mergeProjectBranch, inspectProjectBranch, manageProjectBranch };
}
