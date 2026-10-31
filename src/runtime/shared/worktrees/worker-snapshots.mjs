// Read-only snapshot worktrees of delegated workers (`git worktree add
// --detach` through the git tool): the worker's session holds each one, and
// it is removed when that worker's turn settles (the session runtime's
// unload), like the Lead's turn snapshots. What a removal leaves (something
// still runs there, the process ends first) is the prune's and the startup
// reconcile's: a snapshot never outlives its holder.
//
// Dependency-free at load (the manager loads on first use) and shared through
// a global symbol, so every bundle copy of this module sees one ledger.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const STATE_KEY = Symbol.for('mixdog.workerSnapshots.v1');
const RETRY_MS = 2_000;
const RETRY_LIMIT = 5;

const loadManager = () => import('./manager.mjs');

function state() {
  globalThis[STATE_KEY] ??= { runtimeToken: `worker-snapshots-${randomUUID()}`, turns: new Map() };
  return globalThis[STATE_KEY];
}

/**
 * A snapshot of `commit` in the repository at `projectPath`, held by worker
 * session `sessionId` until its turn settles (releaseWorkerSnapshots).
 * @param {{ sessionId: string, projectPath: string, commit: string, txId?: string, confirmLarge?: boolean, manager?: object }} input
 */
export async function createWorkerSnapshot({
  sessionId,
  projectPath,
  commit,
  txId = '',
  confirmLarge = false,
  manager = null,
}) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('A worker snapshot needs the worker session.');
  const tx = String(txId || '').trim() || `worker-snapshot-${randomUUID()}`;
  const backend = manager || (await loadManager());
  const entry = await backend.createSnapshotWorktree({
    projectPath,
    sessionId: id,
    runtimeToken: state().runtimeToken,
    commit,
    txId: tx,
    confirmLarge: confirmLarge === true,
  });
  const { turns } = state();
  if (!turns.has(id)) turns.set(id, new Set());
  turns.get(id).add(tx);
  return entry;
}

/**
 * The worker's turn settled: remove the snapshots it made. One a worker or
 * background shell still runs in is retried with a doubling delay a few
 * times; the rest stays for the prune / startup reconcile.
 * @returns {Promise<{ removed: string[], kept: object[] }>}
 */
export async function releaseWorkerSnapshots(
  sessionId,
  { manager = null, retryMs = RETRY_MS, retryLimit = RETRY_LIMIT } = {}
) {
  const id = String(sessionId || '');
  const { turns } = state();
  const made = turns.get(id);
  const report = { removed: [], kept: [] };
  if (!made?.size) return report;
  turns.delete(id);
  const backend = manager || (await loadManager());
  let pending = [...made];
  for (let attempt = 0; pending.length && attempt < retryLimit; attempt++) {
    if (attempt > 0) await delay(retryMs * 2 ** (attempt - 1), undefined, { ref: false });
    const result = await backend.removeSessionSnapshots(id, { txIds: pending });
    report.removed.push(...result.removed);
    const inUse = result.kept.filter((row) => row.reason === 'in-use');
    report.kept = result.kept;
    pending = inUse.map((row) => row.txId);
  }
  return report;
}
