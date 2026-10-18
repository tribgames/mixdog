import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { withFileLockSync, writeJsonAtomicSync } from '../atomic-file.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';
import { findGitLayout } from './git-head.mjs';
import { canonicalPath, isWithin, samePath } from './paths.mjs';
import { worktreeError, worktreeRefusal } from './contract.mjs';
import { registryPath } from './registry.mjs';

const FILE = 'mixdog-workspace-admission.json';
const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

/**
 * The admission policy's external exception: a linked checkout Mixdog did not
 * create (not a project's main folder, not a registered managed worktree) is
 * never lock-blocked. Management takes no lease on it and its readers are
 * admitted whatever is held elsewhere; its running readers still refuse a
 * management action that touches it.
 */
export function isExternalCheckout(folder) {
  const layout = findGitLayout(folder, { strict: true });
  if (!layout || samePath(layout.gitDir, layout.commonDir)) return false;
  let entries;
  try {
    entries = JSON.parse(readFileSync(registryPath(), 'utf8'))?.entries ?? {};
  } catch (error) {
    if (error?.code !== 'ENOENT') throw worktreeRefusal('workspace-admission-unreadable');
    entries = {};
  }
  return !Object.values(entries).some(
    (record) => typeof record?.path === 'string' && samePath(record.path, layout.topLevel)
  );
}

/**
 * Reads the ledger under its lock. A missing ledger is empty. A ledger that is
 * not JSON is a torn write (a crash or power loss after the rename committed
 * the file's size but not its bytes leaves it NUL-filled on NTFS): nothing in
 * it can be recovered and every lease it held belongs to a process that died
 * with it, so refusing forever would only lock the project out. It is moved
 * aside as `<FILE>.corrupt-<time>` for inspection and admission starts over
 * empty. A ledger that cannot be read at all (permissions, I/O, a directory in
 * its place) is not an empty one and still refuses, as does one that moves
 * aside unsuccessfully: an unreadable file is never overwritten.
 */
function readLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, leases: [] };
    throw worktreeRefusal('workspace-admission-unreadable');
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      throw worktreeRefusal('workspace-admission-unreadable');
    }
    return { version: 1, leases: [] };
  }
}

function mutate(commonDir, update) {
  const path = join(commonDir, FILE);
  return withFileLockSync(
    `${path}.lock`,
    () => {
      const state = readLedger(path);
      if (
        state?.version !== 1 ||
        !Array.isArray(state.leases) ||
        state.leases.some(
          (lease) =>
            !lease ||
            !['turn', 'command', 'management'].includes(lease.kind) ||
            typeof lease.token !== 'string' ||
            !Number.isSafeInteger(lease.pid) ||
            lease.pid <= 0 ||
            typeof lease.path !== 'string' ||
            !isAbsolute(lease.path)
        )
      ) {
        throw worktreeRefusal('workspace-admission-unreadable');
      }
      // Only a pid PROVEN dead (ESRCH) drops its lease, whatever its kind; an
      // unprobeable pid still counts as running. A live runtime keeps a command
      // whose tree it cannot verify reserved under its own (live) pid until the
      // tree is confirmed gone, so a lease that outlives every pid belongs to a
      // restarted runtime that can no longer release it.
      state.leases = state.leases.filter((lease) => isPidAliveOrUnknown(lease.pid));
      const result = update(state.leases);
      writeJsonAtomicSync(path, state, { lock: false });
      return result;
    },
    { strictOwner: true }
  );
}

function release(commonDir, token) {
  let done = false;
  return () => {
    if (done) return;
    mutate(commonDir, (leases) => {
      for (let i = leases.length - 1; i >= 0; i--) if (leases[i].token === token) leases.splice(i, 1);
    });
    done = true;
  };
}

/**
 * Readers share a checkout freely. Null means a management writer currently
 * owns it; a reader in an external checkout is never held back.
 */
export function tryAdmitWorkspaceActivity(sessionId, cwd, { pid = process.pid, kind = 'turn' } = {}) {
  if (!['turn', 'command'].includes(kind)) throw new TypeError('Invalid workspace reader kind.');
  const layout = findGitLayout(cwd, { strict: true });
  if (!layout) return () => {};
  const external = isExternalCheckout(cwd);
  const path = canonicalPath(cwd);
  const token = randomUUID();
  const admitted = mutate(layout.commonDir, (leases) => {
    if (!external && leases.some((lease) => lease.kind === 'management' && overlaps(lease.path, path))) return false;
    leases.push({ kind, sessionId, pid, token, path });
    return true;
  });
  return admitted ? release(layout.commonDir, token) : null;
}

export async function admitWorkspaceActivity(sessionId, cwd, signal, options) {
  for (;;) {
    signal?.throwIfAborted();
    const leave = tryAdmitWorkspaceActivity(sessionId, cwd, options);
    if (leave) {
      if (signal?.aborted) {
        leave();
        signal.throwIfAborted();
      }
      return leave;
    }
    await delay(100, undefined, { signal });
  }
}

/**
 * Writers refuse while any process's reader overlaps an affected folder, then
 * exclude later readers until the returned release is called. External
 * checkouts are only checked, never held. `sessionId`: the acting session,
 * whose own readers in this process do not count (its idleness is the
 * caller's check).
 */
export function holdWorkspaceActivity(folders, { sessionId = null } = {}) {
  const groups = new Map();
  for (const folder of folders) {
    const layout = findGitLayout(folder, { strict: true });
    if (!layout) throw worktreeError('WORKTREE_UNSUPPORTED_REPO');
    const paths = groups.get(layout.commonDir) ?? [];
    paths.push({ path: canonicalPath(folder), external: isExternalCheckout(folder) });
    groups.set(layout.commonDir, paths);
  }
  const releases = [];
  try {
    for (const [commonDir, paths] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const token = randomUUID();
      mutate(commonDir, (leases) => {
        const conflicts = leases.filter(
          (lease) =>
            !(sessionId && lease.sessionId === sessionId && lease.pid === process.pid) &&
            paths.some(({ path }) => overlaps(path, lease.path))
        );
        if (conflicts.length) throw worktreeRefusal('folder-in-use');
        for (const { path, external } of paths) {
          if (!external) leases.push({ kind: 'management', pid: process.pid, token, path });
        }
      });
      releases.push(release(commonDir, token));
    }
  } catch (error) {
    releaseAll(releases);
    throw error;
  }
  return () => releaseAll(releases);
}

/** Runs every release in reverse order even when one throws; the first failure is rethrown after all ran. */
export function releaseAll(releases) {
  let failure = null;
  for (const done of [...releases].reverse()) {
    try {
      done();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}
