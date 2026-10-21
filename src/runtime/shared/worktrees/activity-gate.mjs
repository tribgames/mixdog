import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, join } from 'node:path';
import {
  parseJsonText,
  quarantinePath,
  readJsonStateSync,
  unsupportedState,
  updateJsonAtomicSync,
  writeFileAtomicSync,
  writeJsonAtomicSync,
} from '../atomic-file.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';
import { findGitLayout } from './git-head.mjs';
import { canonicalPath, isWithin, samePath } from './paths.mjs';
import { worktreeError, worktreeRefusal } from './contract.mjs';
import { readRegistrySync } from './registry.mjs';

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
    entries = readRegistrySync().entries;
  } catch {
    // A damaged registry is kept aside and reads as a restored or empty one;
    // only a real I/O failure (access denied, in use) lands here.
    throw worktreeRefusal('workspace-admission-unreadable');
  }
  return !Object.values(entries).some(
    (record) => typeof record?.path === 'string' && samePath(record.path, layout.topLevel)
  );
}

const VERSION = 1;
const UNRECORDED = Symbol('unrecorded');
const emptyLedger = () => ({ version: VERSION, leases: [] });
const isNewer = (state) => Number.isSafeInteger(state?.version) && state.version > VERSION;
const isLease = (lease) =>
  !!lease &&
  ['turn', 'command', 'management'].includes(lease.kind) &&
  typeof lease.token === 'string' &&
  Number.isSafeInteger(lease.pid) &&
  lease.pid > 0 &&
  typeof lease.path === 'string' &&
  isAbsolute(lease.path);
const hasLedgerShape = (state) => state?.version === VERSION && Array.isArray(state.leases);

// The whole-file check: a newer build's ledger is intact data in a format this
// build cannot honour (left in place), anything else off-shape is damage. One
// bad lease record is not a damaged file; mutate() drops just that record.
function validateLedger(state) {
  if (isNewer(state)) throw unsupportedState('Workspace admission ledger was written by a newer build.');
  if (!hasLedgerShape(state)) throw new TypeError('Workspace admission ledger is malformed.');
  return state;
}

const refuseUnreadable = () => {
  throw worktreeRefusal('workspace-admission-unreadable');
};
const envMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
// How long the leases of a recovered ledger stay unknown. Every process
// holding a lease republishes it within one heal period, so after this window
// the ledger is whole again and destructive operations resume on their own.
const recoveryWindowMs = () => envMs('MIXDOG_ADMISSION_RECOVERY_MS', 15_000);
const healIntervalMs = () => envMs('MIXDOG_ADMISSION_HEAL_MS', 2_000);

// A path that cannot be read at all (access denied, in use, a directory) is an
// I/O failure, not damage: it refuses everything and is never touched.
function assertLedgerReadable(path) {
  try {
    readFileSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw worktreeRefusal('workspace-admission-unreadable');
  }
}

/**
 * A damaged ledger (NUL, truncated, malformed) must not block every prompt and
 * shell command of the workspace, nor may it make a destructive operation fail
 * open. Called under the ledger lock: its bytes are COPIED aside as
 * `<ledger>.corrupt-<ts>` and the same locked update replaces it with a ledger
 * carrying `recoveredAt`. The ledger is never moved away: a missing ledger
 * reads as "no leases", so any gap between the move and the publish (another
 * process taking the lock, or a crash) would admit management beside a live
 * foreign turn. A crash before the publish leaves the damaged file in place,
 * which the next writer recovers the same way. If the copy cannot be kept the
 * ledger is left untouched and everything refuses.
 */
function keepDamagedAside(path) {
  const aside = quarantinePath(path);
  try {
    writeFileAtomicSync(aside, readFileSync(path));
  } catch {
    throw worktreeRefusal('workspace-admission-unreadable');
  }
  process.stderr.write(`[state] ${path} is damaged; kept as ${aside}\n`);
}

function keepAside(path, value) {
  const aside = quarantinePath(path);
  try {
    writeFileAtomicSync(aside, JSON.stringify(value));
    process.stderr.write(`[state] ${path} held invalid lease records; kept as ${aside}\n`);
  } catch {
    // Best effort: the valid records carry on either way.
  }
}

const aliveLease = (lease) => isPidAliveOrUnknown(lease.pid);

// Management leases live in a mirror file as well as the ledger: damage to
// one never hides an operation in progress from the readers.
function readMirror(mirror) {
  try {
    const state = readJsonStateSync(mirror, { validate: validateLedger, strictOwner: true });
    return (state?.leases ?? []).filter((lease) => isLease(lease) && lease.kind === 'management' && aliveLease(lease));
  } catch {
    return [];
  }
}

function writeMirror(mirror, leases) {
  try {
    writeJsonAtomicSync(mirror, { version: VERSION, leases }, { compact: true });
  } catch (error) {
    process.stderr.write(`[state] ${mirror} could not be written (${error?.message})\n`);
  }
}

// Leases this process holds, republished into any ledger that lost them.
const held = new Map();
let healTimer = null;

// A management hold shares one token across its folders, so a lease is
// identified by token and path.
const leaseKey = (lease) => `${lease.token}\0${lease.path}`;

function track(commonDir, lease) {
  held.set(leaseKey(lease), { commonDir, lease });
  healTimer ??= setInterval(healHeld, healIntervalMs());
  healTimer.unref?.();
}

function untrack(token) {
  for (const [key, { lease }] of held) if (lease.token === token) held.delete(key);
  if (!held.size && healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

function ledgerLacks(commonDir, keys) {
  let state;
  try {
    state = parseJsonText(readFileSync(join(commonDir, FILE), 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' || error instanceof SyntaxError;
  }
  if (isNewer(state)) return false;
  if (!hasLedgerShape(state)) return true;
  const stored = new Set(state.leases.filter(Boolean).map(leaseKey));
  return keys.some((key) => !stored.has(key));
}

function healHeld() {
  const byDir = new Map();
  for (const [key, { commonDir }] of held) byDir.set(commonDir, [...(byDir.get(commonDir) ?? []), key]);
  for (const [commonDir, keys] of byDir) {
    if (!ledgerLacks(commonDir, keys)) continue;
    try {
      mutate(
        commonDir,
        () => {},
        () => {}
      );
    } catch {
      // Retried on the next tick.
    }
  }
}

/**
 * Runs `update(leases, { unknown })` under the ledger lock. `unknown`: the
 * ledger was recovered recently and may be missing other processes' leases.
 * `onNewer` answers for a ledger of a newer build, which is left untouched:
 * it refuses by default; readers pass an answer that admits them unrecorded.
 */
function mutate(commonDir, update, onNewer = refuseUnreadable) {
  const path = join(commonDir, FILE);
  const mirror = `${path}.management`;
  assertLedgerReadable(path);
  let result;
  let refusal = null;
  updateJsonAtomicSync(
    path,
    (current) => {
      if (isNewer(current)) {
        result = onNewer();
        return undefined;
      }
      const now = Date.now();
      let state;
      let recovered = false;
      if (current === null) {
        state = emptyLedger();
        // `keepWithoutBackup` leaves a ledger whose text does not parse in
        // place, so null with a file present is damage; no file is a new ledger.
        if (existsSync(path)) {
          keepDamagedAside(path);
          recovered = true;
        }
      } else if (!hasLedgerShape(current)) {
        keepAside(path, current);
        state = emptyLedger();
        recovered = true;
      } else {
        state = { ...current, leases: current.leases.filter(isLease) };
        if (state.leases.length !== current.leases.length) {
          keepAside(path, current);
          recovered = true;
        }
      }
      if (recovered) state.recoveredAt = now;
      // Only a pid PROVEN dead (ESRCH) drops its lease, whatever its kind; an
      // unprobeable pid still counts as running. A live runtime keeps a command
      // whose tree it cannot verify reserved under its own (live) pid until the
      // tree is confirmed gone, so a lease that outlives every pid belongs to a
      // restarted runtime that can no longer release it.
      state.leases = state.leases.filter(aliveLease);
      const present = new Set(state.leases.map(leaseKey));
      const restore = [
        ...(recovered ? readMirror(mirror) : []),
        ...[...held.values()].filter((own) => own.commonDir === commonDir).map((own) => own.lease),
      ];
      for (const lease of restore) {
        if (present.has(leaseKey(lease)) || !aliveLease(lease)) continue;
        present.add(leaseKey(lease));
        state.leases.push(lease);
      }
      const unknown = Number.isFinite(state.recoveredAt) && now - state.recoveredAt < recoveryWindowMs();
      if (!unknown) delete state.recoveredAt;
      const managementTokens = () =>
        state.leases
          .filter((lease) => lease.kind === 'management')
          .map((lease) => lease.token)
          .join();
      const before = managementTokens();
      const unchanged = [...state.leases];
      try {
        result = update(state.leases, { unknown });
      } catch (error) {
        // A refusal still publishes the recovery: dropping the write would
        // leave the damaged file, and every retry would recover it again and
        // restart the window, so management would never resume.
        if (!recovered) throw error;
        refusal = error;
        state.leases = unchanged;
      }
      if (recovered || managementTokens() !== before) {
        writeMirror(
          mirror,
          state.leases.filter((lease) => lease.kind === 'management')
        );
      }
      return state;
    },
    // No backup restore: an older ledger would resurrect leases long released.
    { strictOwner: true, keepWithoutBackup: true, restoreBackup: false }
  );
  if (refusal) throw refusal;
  return result;
}

function release(commonDir, token) {
  let done = false;
  return () => {
    if (done) return;
    mutate(
      commonDir,
      (leases) => {
        for (let i = leases.length - 1; i >= 0; i--) if (leases[i].token === token) leases.splice(i, 1);
      },
      () => {}
    );
    done = true;
    untrack(token);
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
  const lease = { kind, sessionId, pid, token, path };
  const admitted = mutate(
    layout.commonDir,
    (leases) => {
      if (!external && leases.some((other) => other.kind === 'management' && overlaps(other.path, path))) return false;
      leases.push(lease);
      return true;
    },
    // A newer build's ledger cannot be written: the reader goes unrecorded
    // (prompts never wait on it) while management refuses on it.
    () => UNRECORDED
  );
  if (admitted === UNRECORDED) return () => {};
  if (!admitted) return null;
  track(layout.commonDir, lease);
  return release(layout.commonDir, token);
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
      const taken = [];
      mutate(commonDir, (leases, { unknown }) => {
        const conflicts = leases.filter(
          (lease) =>
            !(sessionId && lease.sessionId === sessionId && lease.pid === process.pid) &&
            paths.some(({ path }) => overlaps(path, lease.path))
        );
        if (conflicts.length) throw worktreeRefusal('folder-in-use');
        // A recovered ledger may be missing a live foreign turn: wait for the
        // holders to republish (bounded by the recovery window).
        if (unknown) throw worktreeRefusal('workspace-admission-unreadable');
        for (const { path, external } of paths) {
          if (external) continue;
          const lease = { kind: 'management', pid: process.pid, token, path };
          leases.push(lease);
          taken.push(lease);
        }
      });
      for (const lease of taken) track(commonDir, lease);
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
