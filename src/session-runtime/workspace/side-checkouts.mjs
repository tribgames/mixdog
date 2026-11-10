/**
 * Managed checkouts the hosted Lead makes without moving into them: a branch
 * worktree (`git worktree add`) and the read-only snapshots of its turns,
 * which the turn's admission release removes once nothing runs in them.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { WORKTREE_SNAPSHOT_KIND, worktreeError } from '../../runtime/shared/worktrees/contract.mjs';
import { admitTurn } from './admission-gate.mjs';

// A settled turn's snapshot cleanup waits at most 2^5 times its first delay between attempts.
const SNAPSHOT_BACKOFF_STEPS = 5;

/**
 * A managed worktree for `branch` without moving the session (`git
 * worktree add`): retained by this session like a branch it selected, so
 * entering it later (selectBranch) reuses it. A branch already checked out
 * elsewhere is WORKTREE_BRANCH_OCCUPIED, except in this session's own
 * managed worktree, which is returned as it is. `startPoint` (with
 * `create`): the commit the new branch starts at.
 */
async function addBranchWorktree(
  { hostedSession, sessionProject, backend, runtimeToken, newTxId },
  { branch, create = false, startPoint = null, confirmLarge = false, txId = '', repoCommonDir = null } = {}
) {
  const session = hostedSession(null);
  const { workspace } = await sessionProject(session, repoCommonDir);
  const backendApi = await backend();
  const { occupancy } = await backendApi.listBranchOccupancy({
    projectPath: workspace.projectPath,
    sessionId: session.id,
  });
  const held = occupancy.find((row) => row.branch === branch && row.kind !== 'free');
  if (held && !(held.kind === 'session' && held.sessionId === session.id)) {
    throw worktreeError('WORKTREE_BRANCH_OCCUPIED', `Branch ${branch} is checked out in ${held.path}.`, {
      branch,
      path: held.path,
      kind: held.kind,
      ...(held.sessionId ? { sessionId: held.sessionId } : {}),
    });
  }
  const resolved = await backendApi.resolveBranchWorkspace({
    projectPath: workspace.projectPath,
    branch,
    create: create === true,
    startPoint,
    sessionId: session.id,
    runtimeToken,
    txId: String(txId || '').trim() || newTxId(),
    confirmLarge: confirmLarge === true,
  });
  return {
    path: resolved.path,
    branch,
    worktreeId: resolved.entry?.id ?? null,
    created: resolved.created === true,
    baseCommit: resolved.entry?.baseCommit ?? null,
    mergeTarget: resolved.entry?.mergeTarget ?? null,
  };
}

/**
 * Remove this session's snapshot at `path` now; a dirty one only with
 * `force`, and none while a worker or background shell runs in it.
 */
async function removeSnapshot({ hostedSession, backend }, { path, force = false } = {}) {
  const session = hostedSession(null);
  const backendApi = await backend();
  const entry = await backendApi.getWorktreeByPath(path);
  if (entry?.kind !== WORKTREE_SNAPSHOT_KIND) throw worktreeError('WORKTREE_MISSING', undefined, { path });
  if (entry.holderSessionId !== session.id) {
    throw worktreeError(
      'WORKTREE_BUSY_JOBS',
      "This snapshot belongs to another session's turn; it is removed when that turn ends, or by a prune.",
      { reason: 'snapshot-held', sessionId: entry.holderSessionId, entryId: entry.id }
    );
  }
  const removed = await backendApi.removeSnapshotWorktree({ entryId: entry.id, force: force === true });
  return { ...removed, entryId: entry.id, path: entry.path };
}

/**
 * @param {object} deps The session view (hostedSession, sessionProject), the
 *   `backend()` loader, the runtime identity and the snapshot retry bounds.
 */
export function createSideCheckouts({
  getSession,
  getCurrentCwd,
  hostedSession,
  sessionProject,
  backend,
  runtimeToken,
  newTxId,
  snapshotRetryMs,
  snapshotRetryLimit,
}) {
  // The creation txIds of the read-only snapshots the current admitted turn
  // made. Each turn owns its own set, so its cleanup never touches a later
  // turn's snapshots (a txId, unlike a freed slug, is never reused).
  let turnSnapshots = null;
  // The running cleanups of settled turns' snapshots (controller → session id).
  const snapshotCleanups = new Map();
  let disposed = false;

  /**
   * Turn admission (see admission-gate admitTurn); resolves the release. The
   * release also starts the removal of the read-only snapshots this turn
   * made — only those (removeTurnSnapshots).
   */
  async function admitTurnWorkspace({ signal } = {}) {
    const release = await admitTurn({ sessionId: getSession()?.id || '', cwd: () => getCurrentCwd() || '', signal });
    const made = new Set();
    turnSnapshots = made;
    return () => {
      release();
      if (turnSnapshots === made) turnSnapshots = null;
      const sessionId = getSession()?.id;
      if (made.size && sessionId) void removeTurnSnapshots(sessionId, [...made]);
    };
  }

  /**
   * Remove a settled turn's snapshots (by creation `txIds`) once nothing runs
   * in them: a worker turn or background shell holding a workspace lease
   * inside one keeps it (manager removeSessionSnapshots reports it `in-use`).
   * Those are retried with a doubling delay (`snapshotRetryMs`, at most
   * 2^SNAPSHOT_BACKOFF_STEPS times it) for at most `snapshotRetryLimit`
   * attempts; a snapshot removal that fails otherwise is not retried. What is
   * left then — or when the runtime is disposed, the session closes, is
   * deleted or is no longer the one hosted here — is the prune's and the
   * startup reconcile's. Admission is not held meanwhile: the removal only
   * ever names this turn's snapshots.
   */
  async function removeTurnSnapshots(sessionId, txIds) {
    if (disposed) return;
    const controller = new AbortController();
    snapshotCleanups.set(controller, sessionId);
    try {
      let pending = txIds;
      for (let attempt = 0; pending.length && attempt < snapshotRetryLimit; attempt++) {
        if (attempt > 0) {
          const wait = snapshotRetryMs * 2 ** Math.min(attempt - 1, SNAPSHOT_BACKOFF_STEPS);
          await delay(wait, undefined, { ref: false, signal: controller.signal });
        }
        const session = getSession();
        if (session?.id !== sessionId || session.closed === true) return;
        const report = await (await backend()).removeSessionSnapshots(sessionId, { txIds: pending });
        pending = report.kept.filter((row) => row.reason === 'in-use').map((row) => row.txId);
      }
    } catch {
      // Cancelled, or the backend failed: the rest is the maintenance's.
    } finally {
      snapshotCleanups.delete(controller);
    }
  }

  /** Stop the snapshot cleanups of `sessionId` (every session's when null). */
  function cancelSnapshotCleanups(sessionId = null) {
    for (const [controller, owner] of snapshotCleanups) {
      if (sessionId === null || owner === sessionId) controller.abort();
    }
  }

  /** Runtime teardown: no snapshot cleanup runs on (prune / startup reconcile finish them). */
  function dispose() {
    disposed = true;
    cancelSnapshotCleanups();
  }

  /**
   * A read-only snapshot of `commit` for this session's turn (`git worktree
   * add --detach`): a detached managed checkout no session works in,
   * removed when the turn settles (and nothing runs in it any more). The
   * session does not move. Only inside an admitted turn: a snapshot always
   * belongs to the turn that made it.
   */
  async function createSnapshot({ commit = 'HEAD', confirmLarge = false, txId = '', repoCommonDir = null } = {}) {
    const session = hostedSession(null);
    const made = turnSnapshots;
    if (!made) throw new Error('A read-only snapshot belongs to a turn; none is running in this session.');
    const { workspace } = await sessionProject(session, repoCommonDir);
    const tx = String(txId || '').trim() || newTxId();
    const entry = await (await backend()).createSnapshotWorktree({
      projectPath: workspace.projectPath,
      sessionId: session.id,
      runtimeToken,
      commit,
      txId: tx,
      confirmLarge: confirmLarge === true,
    });
    made.add(tx);
    return entry;
  }

  return {
    admitTurnWorkspace,
    addBranchWorktree: (input) =>
      addBranchWorktree({ hostedSession, sessionProject, backend, runtimeToken, newTxId }, input),
    createSnapshot,
    removeSnapshot: (input) => removeSnapshot({ hostedSession, backend }, input),
    cancelSnapshotCleanups,
    dispose,
  };
}
