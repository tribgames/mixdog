/**
 * Process-wide admission gate shared by Lead workspace transitions, turn
 * admission and worker spawning.
 *
 * - A transition and a worker spawn of the same Lead never overlap: a
 *   transition refuses while a spawn is being prepared, a spawn refuses while
 *   a transition is in flight.
 * - Turns and transitions are mutually exclusive: an admitted turn is
 *   registered until it settles; a turn that arrives while its own session
 *   transitions, or while another session changes the checkout its cwd lies
 *   in (a held checkout folder), waits for that change to settle. A checkout
 *   folder can only be held while no other session's admitted turn runs in it.
 * - Each worktree-bound Lead's execution root, which every worker of that Lead
 *   runs in.
 */
import { worktreeError, worktreeRefusal } from '../../runtime/shared/worktrees/contract.mjs';
import { throwIfAborted } from '../../runtime/shared/worktrees/git.mjs';
import { isWithin } from '../../runtime/shared/worktrees/paths.mjs';
import { tryAdmitWorkspaceActivity } from '../../runtime/shared/worktrees/activity-gate.mjs';
import { setTimeout as delay } from 'node:timers/promises';

/** @type {Map<string, { txId: string, settled: Promise<void> }>} Lead session id → in-flight transition. */
const transitions = new Map();
/** @type {Map<string, number>} Lead session id → spawns being prepared. */
const spawns = new Map();
/** @type {Map<string, string>} Lead session id → bound worktree execution root. */
const cwdLocks = new Map();
/** @type {Map<symbol, { sessionId: string, cwd: () => string }>} Admitted turns (live cwd). */
const turns = new Map();
/** @type {Map<symbol, { sessionId: string, folder: string, settled: Promise<void> }>} Checkouts being changed. */
const folderHolds = new Map();

const key = (sessionId) => String(sessionId || '').trim();

function latch() {
  let resolve;
  const settled = new Promise((done) => {
    resolve = done;
  });
  return { settled, resolve };
}

function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    fn();
    done = true;
  };
}

const within = (folder, cwd) => Boolean(folder && cwd) && isWithin(folder, cwd);

/**
 * Enter a transition for `sessionId`; the returned function leaves it.
 * @returns {() => void}
 */
export function beginWorkspaceTransition(sessionId, txId) {
  const id = key(sessionId);
  if (!id) throw new TypeError('workspace transition requires a session id.');
  if (transitions.has(id)) {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'Another workspace change is in progress for this session.', {
      reason: 'transition',
    });
  }
  if ((spawns.get(id) || 0) > 0) {
    throw worktreeError('WORKTREE_BUSY_JOBS', undefined, { reason: 'workers', starting: spawns.get(id) });
  }
  const gate = latch();
  transitions.set(id, { txId: String(txId || 'tx'), settled: gate.settled });
  return once(() => {
    transitions.delete(id);
    gate.resolve();
  });
}

/**
 * Hold `folder` (a checkout root) while its branch changes or a merge lands
 * in it. Refuses (WORKTREE_BUSY_JOBS, `folder-in-use`) while another session's
 * admitted turn runs inside it, and (`transition`) while another change holds
 * an overlapping checkout; turns arriving meanwhile wait (admitTurn). The
 * holder's own turns are its own business (the Lead busy check).
 * `hold: false` (an external checkout, never lock-blocked) only refuses.
 * @param {string|null} sessionId The changing session; '' / null for a session-less change.
 * @returns {() => void} Release.
 */
export function holdCheckoutFolder(sessionId, folder, { hold = true } = {}) {
  const id = key(sessionId);
  const users = new Set();
  for (const turn of turns.values()) {
    if (turn.sessionId !== id && within(folder, turn.cwd())) users.add(turn.sessionId);
  }
  if (users.size) throw worktreeRefusal('folder-in-use', { sessions: [...users] });
  if (!hold) return () => {};
  if ([...folderHolds.values()].some((hold) => within(hold.folder, folder) || within(folder, hold.folder))) {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'Another branch change is in progress in the project folder.', {
      reason: 'transition',
    });
  }
  const token = Symbol('checkout-folder');
  const gate = latch();
  folderHolds.set(token, { sessionId: id, folder, settled: gate.settled });
  return once(() => {
    folderHolds.delete(token);
    gate.resolve();
  });
}

function admissionBlocker(id, cwd) {
  const own = transitions.get(id);
  if (own) return own.settled;
  const path = cwd();
  for (const hold of folderHolds.values()) {
    if (hold.sessionId !== id && within(hold.folder, path)) return hold.settled;
  }
  return null;
}

function settledOrAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}

/**
 * Admit one turn of `sessionId`, whose live cwd is `cwd()`: waits while the
 * session itself transitions or another session holds the checkout the cwd
 * lies in, then registers the turn until the returned release is called.
 * An abort while waiting rejects and registers nothing.
 * @param {{ sessionId: string, cwd: () => string, signal?: AbortSignal }} input
 * @returns {Promise<() => void>}
 */
export async function admitTurn({ sessionId, cwd, signal }) {
  const id = key(sessionId);
  for (;;) {
    throwIfAborted(signal);
    const blocker = admissionBlocker(id, cwd);
    if (blocker) {
      await settledOrAborted(blocker, signal);
      continue;
    }
    const release = tryAdmitWorkspaceActivity(id, cwd());
    if (!release) {
      await delay(100, undefined, { signal });
      continue;
    }
    const token = Symbol('turn');
    const leases = [release];
    turns.set(token, { sessionId: id, cwd, leases });
    return once(() => {
      const errors = [];
      for (const leave of leases) {
        try {
          leave();
        } catch (error) {
          errors.push(error);
        }
      }
      turns.delete(token);
      if (errors.length) throw new AggregateError(errors, 'Workspace admission could not be released.');
    });
  }
}

/** Keep the old root protected and acquire the destination before an admitted turn moves. */
export function retainAdmittedTurnWorkspace(sessionId, cwd) {
  for (const turn of turns.values()) {
    if (turn.sessionId !== key(sessionId) || turn.cwd() === cwd) continue;
    const leave = tryAdmitWorkspaceActivity(sessionId, cwd);
    if (!leave) throw worktreeRefusal('folder-in-use');
    turn.leases.push(leave);
  }
}

/**
 * Admit one worker spawn preparation for the Lead(s) in `sessionIds`.
 * @param {Array<string|null|undefined>} sessionIds Owner and caller session ids.
 * @returns {() => void}
 */
export function enterWorkerSpawn(sessionIds) {
  const ids = [...new Set(sessionIds.map(key).filter(Boolean))];
  if (ids.some((id) => transitions.has(id))) {
    throw worktreeError('WORKTREE_BUSY_JOBS', 'The Lead workspace is changing; spawn the worker after it settles.', {
      reason: 'transition',
    });
  }
  for (const id of ids) spawns.set(id, (spawns.get(id) || 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    for (const id of ids) {
      const next = (spawns.get(id) || 1) - 1;
      if (next > 0) spawns.set(id, next);
      else spawns.delete(id);
    }
  };
}

/** Record (or clear with null) the worktree root a Lead's workers must run in. */
export function setWorkspaceCwdLock(sessionId, cwd) {
  const id = key(sessionId);
  if (!id) return;
  if (cwd) cwdLocks.set(id, String(cwd));
  else cwdLocks.delete(id);
}

/** The locked worker cwd for the first Lead id that has one, or null. */
export function workspaceCwdLock(sessionIds) {
  for (const id of sessionIds.map(key)) {
    if (id && cwdLocks.has(id)) return cwdLocks.get(id);
  }
  return null;
}
