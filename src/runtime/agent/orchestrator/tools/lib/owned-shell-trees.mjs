// Owner-wide shell cancellation (session close) with the same pre-kill
// identity snapshot every other kill takes. Each live shell tree — a
// foreground run or a promoted background job — registers how to prepare its
// kill; the owner cancel prepares them all, waits for their snapshots at most
// PROCESS_TABLE_READ_BOUND_MS, and then sends the kill whether or not they
// arrived. A missing snapshot leaves the outcome unknown, so the workspace
// stays held under the observation loop instead of being released blind.
import { cancelNativeTasks } from './native-spawn-client.mjs';
import { killAfterSnapshot } from './shell-descendants.mjs';

// jobId -> { ownerSessionId, prepareKill }. prepareKill() marks the tree as
// killed by its owner and returns true when its snapshot is already complete,
// otherwise a promise for it.
const ownedTrees = new Map();
// owner -> send(): cancels still waiting for their snapshots. Runtime
// shutdown sends them at once — a kill is never lost to an exit.
const pendingCancels = new Map();

export function registerOwnedShellTree(jobId, entry) {
  const key = String(jobId || '').trim();
  if (key && typeof entry?.prepareKill === 'function') ownedTrees.set(key, entry);
}

/** Drops `entry` only while it is still the registered one for the job. */
export function unregisterOwnedShellTree(jobId, entry) {
  const key = String(jobId || '').trim();
  if (ownedTrees.get(key) === entry) ownedTrees.delete(key);
}

/** Prepare the kill of every registered tree — of one owner, or of all when
 *  `ownerSessionId` is null (runtime shutdown) — and unregister them. Returns
 *  the snapshots still pending (empty when all were complete). */
export function prepareOwnedShellTreeKills(ownerSessionId = null) {
  const owner = ownerSessionId == null ? null : String(ownerSessionId).trim();
  const pending = [];
  for (const [jobId, entry] of [...ownedTrees]) {
    if (owner !== null && String(entry.ownerSessionId || '') !== owner) continue;
    let ready;
    try {
      ready = entry.prepareKill();
    } catch {
      ready = false;
    }
    if (ready !== true) pending.push(Promise.resolve(ready).catch(() => false));
    unregisterOwnedShellTree(jobId, entry);
  }
  return pending;
}

/** Cancel every shell tree of one owner session. Synchronous (the native
 *  cancel's own result) when every snapshot is already complete; otherwise a
 *  promise that sends the cancel once the snapshots land or the bound passes. */
export function cancelOwnedShellTrees(ownerSessionId) {
  const owner = String(ownerSessionId || '').trim();
  const pending = prepareOwnedShellTreeKills(owner);
  if (pending.length === 0) return cancelNativeTasks({ ownerSessionId: owner });
  let result = null;
  const send = () => {
    if (pendingCancels.get(owner) === send) pendingCancels.delete(owner);
    result = result ?? cancelNativeTasks({ ownerSessionId: owner });
    return result;
  };
  pendingCancels.set(owner, send);
  return killAfterSnapshot(Promise.all(pending), send);
}

/** Send every owner cancel still waiting for its snapshot, now (runtime
 *  shutdown). A snapshot that has not landed leaves that outcome unknown. */
export function flushPendingOwnerCancels() {
  let sent = 0;
  for (const send of [...pendingCancels.values()]) {
    send();
    sent += 1;
  }
  return sent;
}
