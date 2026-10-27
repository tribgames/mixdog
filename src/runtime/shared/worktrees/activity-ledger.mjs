/*
 * The workspace admission ledger. Only the admission thread runs the ledger
 * operations below (activity-ledger-worker.mjs, started by activity-gate.mjs):
 * it owns this module's bookkeeping (`held`, `pending`, the heal timer) and
 * runs one operation at a time, in the order requested. Every other thread
 * of the process asks it through activity-gate.mjs.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseJsonText, quarantinePath, withFileLockSync, writeFileAtomicSync } from '../atomic-file.mjs';
import { isPidAliveOrUnknown } from '../pid-liveness.mjs';
import { findGitLayout } from './git-head.mjs';
import { canonicalPath, isWithin, samePath } from './paths.mjs';
import { worktreeError, worktreeRefusal } from './contract.mjs';
import { readRegistrySync } from './registry.mjs';

const FILE = 'mixdog-workspace-admission.json';
const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

/**
 * The Int32 slots the admission thread shares with the thread that started
 * it. SYNC: the id of the synchronous request its caller waits for; the
 * admission thread swaps it to -id when it answers, the caller to 0 when it
 * gives up — whichever comes first decides. ANSWERED counts synchronous
 * answers, DONE every finished request, STOPPED is set once the admission
 * thread is gone.
 */
export const LEDGER_SLOTS = Object.freeze({ SYNC: 0, ANSWERED: 1, DONE: 2, STOPPED: 3, COUNT: 4 });

/**
 * The admission policy's external exception: a linked checkout Mixdog did not
 * create (not a project's main folder, not a registered managed worktree) is
 * not lock-blocked by what is held elsewhere. Management takes no lease on it
 * and its readers are admitted whatever is held outside it; its running
 * readers still refuse a management action that touches it. A management lease
 * published inside the checkout itself (another profile, or a registry
 * recovered empty) still refuses its readers.
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

/*
 * The admission ledger lists every turn, command and management lease of a
 * repository. It is kept in two copies with the same content in the Git
 * common directory: `mixdog-workspace-admission.json` and its `.management`
 * mirror. A grant returns its release only once both copies hold it, and a
 * release is forgotten only once both copies dropped it, so damage to either
 * copy alone never loses an acknowledged lease. `recoveredAt` marks a ledger
 * that may be missing leases because no complete copy survived: readers still
 * run, management refuses, and only a quiescent reset that removes both
 * copies clears it (docs/git-github-integration.md). Time, healing and
 * releases never do.
 */
const VERSION = 2;
const isLease = (lease) =>
  !!lease &&
  ['turn', 'command', 'management'].includes(lease.kind) &&
  typeof lease.token === 'string' &&
  Number.isSafeInteger(lease.pid) &&
  lease.pid > 0 &&
  typeof lease.path === 'string' &&
  isAbsolute(lease.path);
// Only a pid PROVEN dead (ESRCH) drops its lease, whatever its kind; an
// unprobeable pid still counts as running. A live runtime keeps a command
// whose tree it cannot verify reserved under its own (live) pid until the
// tree is confirmed gone, so a lease that outlives every pid belongs to a
// restarted runtime that can no longer release it.
const aliveLease = (lease) => isPidAliveOrUnknown(lease.pid);
// A management hold shares one token across its folders, so a lease is
// identified by token and path.
const leaseKey = (lease) => `${lease.token}\0${lease.path}`;
const unverifiable = () => worktreeRefusal('workspace-admission-unreadable');
const copyPaths = (commonDir) => {
  const primary = join(commonDir, FILE);
  return [primary, `${primary}.management`];
};
const envMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const healIntervalMs = () => envMs('MIXDOG_ADMISSION_HEAL_MS', 2_000);

// The leases this process holds, put back into a ledger that lost them, and
// the tokens it released or failed to grant whose removal from both copies is
// not confirmed yet (token -> common dir), retried until it is.
const held = new Map();
const pending = new Map();
let healTimer = null;

/**
 * One copy as read under the ledger lock. A copy that cannot be read (access
 * denied, in use, a directory) or that a newer build wrote refuses everything
 * and is never written: neither may pass for an empty ledger. Anything else
 * that is not a ledger, or holds an invalid lease record, is damaged; its
 * valid records still count. A copy is complete when it accounts for every
 * acknowledged lease: intact, not uncertain, and version 2 — or the version 1
 * primary, since the version 1 mirror held management leases only.
 */
function readCopy(path, primary) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, leases: [] };
    throw unverifiable();
  }
  let ledger = null;
  try {
    ledger = parseJsonText(bytes.toString('utf8'));
  } catch {
    // Unparseable: damaged below.
  }
  if (Number.isSafeInteger(ledger?.version) && ledger.version > VERSION) throw unverifiable();
  if (![1, VERSION].includes(ledger?.version) || !Array.isArray(ledger.leases)) {
    return { path, bytes, leases: [], damaged: true };
  }
  const leases = ledger.leases.filter(isLease);
  const damaged = leases.length !== ledger.leases.length;
  const uncertain = Object.hasOwn(ledger, 'recoveredAt');
  const complete = !damaged && !uncertain && (ledger.version === VERSION || primary);
  return { path, bytes, leases, damaged, uncertain, complete, recoveredAt: ledger.recoveredAt };
}

/**
 * The ledger recovered from both copies: the union of their valid lease
 * records (one copy lacking a lease never drops it), less proven-dead pids
 * and this process's pending removals, plus the leases this process holds.
 * It stays uncertain when either copy is, and becomes so when a copy exists
 * but none is complete. Both copies missing reads as a new repository.
 */
function recover(commonDir, copies) {
  const own = [...held.values()].filter((entry) => entry.commonDir === commonDir).map((entry) => entry.lease);
  const leases = new Map();
  for (const lease of [...copies.flatMap((copy) => copy.leases), ...own]) {
    const key = leaseKey(lease);
    if (!leases.has(key) && pending.get(lease.token) !== commonDir && aliveLease(lease)) leases.set(key, lease);
  }
  const ledger = { version: VERSION, leases: [...leases.values()] };
  const uncertain =
    copies.some((copy) => copy.uncertain) ||
    (copies.some((copy) => copy.bytes) && !copies.some((copy) => copy.complete));
  if (uncertain) ledger.recoveredAt = copies.map((copy) => copy.recoveredAt).find(Number.isFinite) ?? Date.now();
  return ledger;
}

/**
 * #117: the bytes of a damaged copy are copied aside as `<copy>.corrupt-<ts>`
 * before it is rewritten. If they cannot be kept, nothing is written and
 * everything refuses.
 */
function keepDamagedAside(copies) {
  for (const copy of copies.filter((each) => each.damaged)) {
    const aside = quarantinePath(copy.path);
    try {
      writeFileAtomicSync(aside, copy.bytes);
    } catch {
      throw unverifiable();
    }
    process.stderr.write(`[state] ${copy.path} is damaged; kept as ${aside}\n`);
  }
}

/** Writes the primary, then the mirror; a copy that already holds the ledger is left alone. */
function publish(copies, ledger) {
  const text = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  for (const copy of copies) {
    if (copy.bytes?.equals(text)) continue;
    copy.bytes = null; // Unknown until the write lands.
    writeFileAtomicSync(copy.path, text);
    copy.bytes = text;
  }
}

function settle(tokens) {
  for (const token of tokens) pending.delete(token);
  syncHealTimer();
}

/**
 * Runs `update(leases, { unknown })` on the recovered ledger under the
 * primary copy's lock and publishes the result to both copies before
 * returning. `unknown`: the ledger may be missing leases. A refused update
 * still publishes the repaired ledger. A grant that cannot be published is
 * refused: its leases become pending removals and the ledger without them is
 * published again; whatever that leaves behind is withdrawn by the next
 * mutation or heal tick, which also blocks every later grant until it lands.
 */
function mutate(commonDir, update = () => {}) {
  const paths = copyPaths(commonDir);
  return withFileLockSync(
    `${paths[0]}.lock`,
    () => {
      const copies = paths.map((path, index) => readCopy(path, index === 0));
      keepDamagedAside(copies);
      const withdrawn = [...pending].filter(([, dir]) => dir === commonDir).map(([token]) => token);
      const base = recover(commonDir, copies);
      const leases = [...base.leases];
      let result;
      let refusal = null;
      try {
        result = update(leases, { unknown: Object.hasOwn(base, 'recoveredAt') });
      } catch (error) {
        refusal = error;
      }
      const granted = refusal ? [] : leases.filter((lease) => !base.leases.includes(lease));
      try {
        publish(copies, refusal ? base : { ...base, leases });
        settle(withdrawn);
      } catch (error) {
        process.stderr.write(`[state] ${paths[0]} could not be published (${error?.message})\n`);
        if (refusal) throw refusal;
        for (const lease of granted) pending.set(lease.token, commonDir);
        if (granted.length) {
          try {
            publish(copies, base);
            settle([...withdrawn, ...granted.map((lease) => lease.token)]);
          } catch {
            syncHealTimer();
          }
        }
        throw unverifiable();
      }
      if (refusal) throw refusal;
      return result;
    },
    { strictOwner: true }
  );
}

// Without the lock, a cheap check that both copies are the same current
// ledger holding every live lease this process holds there and none of the
// tokens it is withdrawing. Repair, never proof that the ledger is complete.
function inSync(commonDir) {
  let ledger;
  try {
    const [primary, mirror] = copyPaths(commonDir).map((path) => readFileSync(path));
    if (!primary.equals(mirror)) return false;
    ledger = parseJsonText(primary.toString('utf8'));
  } catch {
    return false;
  }
  if (ledger?.version !== VERSION || !Array.isArray(ledger.leases)) return false;
  const stored = new Set(ledger.leases.filter(isLease).map(leaseKey));
  return (
    [...held].every(([key, entry]) => entry.commonDir !== commonDir || stored.has(key) || !aliveLease(entry.lease)) &&
    !ledger.leases.some((lease) => pending.get(lease?.token) === commonDir)
  );
}

function healHeld() {
  const dirs = new Set([...[...held.values()].map((entry) => entry.commonDir), ...pending.values()]);
  for (const commonDir of dirs) {
    if (inSync(commonDir)) continue;
    try {
      mutate(commonDir);
    } catch {
      // Retried on the next tick.
    }
  }
  syncHealTimer();
}

function syncHealTimer() {
  if (held.size || pending.size) {
    healTimer ??= setInterval(healHeld, healIntervalMs());
    healTimer.unref?.();
  } else if (healTimer) {
    clearInterval(healTimer);
    healTimer = null;
  }
}

function track(commonDir, lease) {
  held.set(leaseKey(lease), { commonDir, lease });
  syncHealTimer();
}

// Forgotten as held first, so nothing puts the lease back; its token stays
// pending until both copies dropped it. Never throws: a removal that did not
// land is retried by the next mutation or heal tick.
function releaseLease({ commonDir, token }) {
  for (const [key, entry] of held) if (entry.lease.token === token) held.delete(key);
  pending.set(token, commonDir);
  try {
    mutate(commonDir);
  } catch {
    // Retried by the next mutation or heal tick.
  }
  syncHealTimer();
}

/**
 * Releases the handles a grant returned, last granted first (one per
 * repository the grant touched).
 */
export function release({ leases }) {
  for (const handle of [...leases].reverse()) releaseLease(handle);
}

/**
 * Readers share a checkout freely. Null means a management writer currently
 * owns it; a reader in an external checkout is admitted whatever is held
 * outside it, but refused by a management lease inside it. Otherwise the
 * handles to release (none outside a Git checkout). Throws
 * `workspace-admission-unreadable` when the ledger cannot be read, was
 * written by a newer build, or the grant could not be made durable in both
 * copies: no work may run unrecorded.
 */
export function admit({ sessionId, cwd, pid = process.pid, kind = 'turn' }) {
  const layout = findGitLayout(cwd, { strict: true });
  if (!layout) return { leases: [] };
  const external = isExternalCheckout(cwd);
  const path = canonicalPath(cwd);
  const token = randomUUID();
  const lease = { kind, sessionId, pid, token, path };
  // External is this profile's registry view: management another profile (or
  // a registry recovered empty) published inside this very checkout still holds.
  const checkout = canonicalPath(layout.topLevel);
  const holds = (other) => (external ? isWithin(checkout, other.path) : overlaps(other.path, path));
  const admitted = mutate(layout.commonDir, (leases) => {
    if (leases.some((other) => other.kind === 'management' && holds(other))) return false;
    leases.push(lease);
    return true;
  });
  if (!admitted) return null;
  track(layout.commonDir, lease);
  return { leases: [{ commonDir: layout.commonDir, token }] };
}

/**
 * Writers refuse while any process's reader overlaps an affected folder, then
 * exclude later readers until the returned handles are released. External
 * checkouts are only checked, never held. `sessionId`: the acting session,
 * whose own readers in this process do not count (its idleness is the
 * caller's check).
 */
export function hold({ folders, sessionId = null }) {
  const groups = new Map();
  for (const folder of folders) {
    const layout = findGitLayout(folder, { strict: true });
    if (!layout) throw worktreeError('WORKTREE_UNSUPPORTED_REPO');
    const paths = groups.get(layout.commonDir) ?? [];
    paths.push({ path: canonicalPath(folder), external: isExternalCheckout(folder) });
    groups.set(layout.commonDir, paths);
  }
  const handles = [];
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
        // The ledger may be missing a live foreign lease: refused until reset.
        if (unknown) throw unverifiable();
        for (const { path, external } of paths) {
          if (external) continue;
          const lease = { kind: 'management', pid: process.pid, token, path };
          leases.push(lease);
          taken.push(lease);
        }
      });
      for (const lease of taken) track(commonDir, lease);
      handles.push({ commonDir, token });
    }
  } catch (error) {
    release({ leases: handles });
    throw error;
  }
  return { leases: handles };
}
