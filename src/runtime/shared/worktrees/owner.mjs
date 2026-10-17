/**
 * Live owner leases. Durable ownership is the registry record's
 * `ownerSessionId` (the session retains the worktree across restarts); the
 * lease says which runtime of that session holds it right now. A lease is
 * matched on the exact owner (sessionId + runtimeToken); the pid is a
 * diagnostic hint only, never the identity.
 *
 * Leases live at <root>/.owners/<id>.json (outside the worktree checkout, so
 * they never show up as untracked files in it).
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonText, writeJsonAtomicAsync } from '../atomic-file.mjs';
import { managedWorktreeRoot, normalizeWorktreeOwner } from './contract.mjs';

function ownerLeasePath(record) {
  return join(managedWorktreeRoot(record.repoCommonDir), '.owners', `${record.id}.json`);
}

export async function readOwnerLease(record, { strict = false } = {}) {
  try {
    const value = parseJsonText(await readFile(ownerLeasePath(record), 'utf8'));
    return {
      ...normalizeWorktreeOwner(value),
      entryId: value.entryId ?? record.id,
      claimedAt: value.claimedAt ?? null,
    };
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    if (error?.code === 'ENOENT' || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

export async function writeOwnerLease(record, owner) {
  const lease = { ...normalizeWorktreeOwner(owner), entryId: record.id, claimedAt: Date.now() };
  await writeJsonAtomicAsync(ownerLeasePath(record), lease);
  return lease;
}

export function sameOwner(left, right) {
  return !!left && !!right && left.sessionId === right.sessionId && left.runtimeToken === right.runtimeToken;
}

export async function removeOwnerLease(record) {
  await rm(ownerLeasePath(record), { force: true });
}
