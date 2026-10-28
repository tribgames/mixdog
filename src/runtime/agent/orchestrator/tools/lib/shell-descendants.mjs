// Post-exit descendant observation for the shell runner.
//
// The question this module answers is "did the command leave anything
// RUNNING?", and it answers it by looking at PROCESSES — never at the command
// text. Nothing here parses, classifies or rewrites a single byte of what the
// caller typed; the shell receives the command exactly as written and the
// decision is taken afterwards from what the operating system reports.
//
// Evidence per platform, both produced by the existing spawn infrastructure:
//   POSIX  — native/mixdog-spawn spawns every shell with `process_group(0)`,
//            so the command owns a process group whose id is the shell pid.
//            Once the shell has exited and been reaped, ANY remaining member
//            of that group is a descendant it left behind, and one signal to
//            the negative pgid reaches all of them.
//   win32  — inspect the process table after every root exit. Closed pipes
//            cannot prove termination: descendants may redirect their stdio.
//            The strict snapshot names survivors still linked to the root.
//
// Every process is tracked by IDENTITY — pid plus creation token from the
// same table read — never by pid alone: a recycled pid is a different process
// and neither keeps a tracked survivor "alive" nor becomes a kill target.
import { killProcessTrees, readProcessTable } from '../../mcp/child-tree.mjs';

const isWin = process.platform === 'win32';

// Cadence of every termination re-check (unconfirmed kill, background job,
// survivors a finished command left behind).
export const TERMINATION_RECHECK_MS = 5_000;

// Upper bound on how long a kill waits for its pre-kill snapshot (one process-
// table read, ~1 s on Windows). The kill is sent at the bound regardless; the
// read is not abandoned — a snapshot that lands later is still absorbed.
export const PROCESS_TABLE_READ_BOUND_MS = 2_000;

// Kill-and-observe rounds of a survivor kill before it reports what is left.
const KILL_ROUNDS = 3;

/** Resolve `promise`'s value, or `onTimeout` once `ms` elapse first. The
 *  bound's timer is cleared whichever side wins. */
export function withinBound(promise, ms, onTimeout) {
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
    timer.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

/** Every kill path: wait for the pre-kill `snapshot` (true, or a promise) at
 *  most PROCESS_TABLE_READ_BOUND_MS, then run `kill` whether it landed or not. */
export function killAfterSnapshot(snapshot, kill) {
  return withinBound(Promise.resolve(snapshot), PROCESS_TABLE_READ_BOUND_MS, false).then(kill);
}

const identityKey = (entry) => `${entry.pid}:${entry.token ?? ''}`;

/** Tracks one command's process tree across its termination.
 *
 *  `capture()` records the identities of the root and every descendant while
 *  the root is still alive — before a kill can break the parent chain (an
 *  exited Windows intermediate orphans its children; a POSIX descendant may
 *  leave the process group). `observe()` takes one strict table read and
 *  answers 'running', 'gone' or 'unknown':
 *    - the root is alive (same identity)                     → running
 *    - a tracked identity, a descendant still linked to one,
 *      or (POSIX) a member of the command's group is alive   → running
 *    - no complete pre-exit capture exists                   → unknown
 *    - a tracked process without a creation token is present → unknown
 *  A failed table read rejects; callers treat it as unknown. */
export function createProcessTreeTracker({ pid, members = [], exitObserved = false } = {}) {
  const rootPid = Number(pid) || 0;
  let rootToken = null;
  let complete = false;
  const tracked = new Map();
  let live = [];
  for (const entry of members) tracked.set(identityKey(entry), { ...entry });
  if (exitObserved) complete = rootPid > 0;

  const present = (table, entry) => {
    if (!table.tokenOf.has(entry.pid)) return false;
    if (entry.token == null) return null;
    return table.tokenOf.get(entry.pid) === entry.token;
  };
  const track = (table, child) => {
    const entry = { pid: child, token: table.tokenOf.get(child) ?? null, name: table.nameOf.get(child) || '' };
    const key = identityKey(entry);
    if (tracked.has(key)) return false;
    tracked.set(key, entry);
    return true;
  };
  // The root's pid still names OUR root (or nothing): its dangling child links
  // are ours. A different process under that pid is a reuse — not ours.
  const rootPidIsOurs = (table, rootAlive) =>
    rootAlive || !table.tokenOf.has(rootPid) || (rootToken != null && table.tokenOf.get(rootPid) === rootToken);

  function absorb(table, rootAlive) {
    const from = [];
    if (rootPidIsOurs(table, rootAlive)) from.push(rootPid);
    for (const entry of tracked.values()) if (present(table, entry) === true) from.push(entry.pid);
    const seen = new Set(from);
    while (from.length) {
      const cur = from.pop();
      for (const child of table.childrenOf.get(cur) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        track(table, child);
        from.push(child);
      }
    }
    // POSIX: the command owns the group whose id is the root pid. While any
    // member exists that id cannot be reused, so a live process holding the
    // pid that is not our root means our group is gone.
    if (!isWin && rootPidIsOurs(table, rootAlive)) {
      for (const [member, pgid] of table.pgidOf ?? []) {
        if (pgid === rootPid && member !== rootPid) track(table, member);
      }
    }
    if (rootAlive) {
      rootToken = rootToken ?? table.tokenOf.get(rootPid) ?? null;
      complete = true;
    }
  }

  function rootIsAlive(table, rootExited) {
    if (rootExited || !table.tokenOf.has(rootPid)) return false;
    return rootToken == null || table.tokenOf.get(rootPid) === rootToken;
  }

  return {
    get complete() {
      return complete;
    },
    /** Identities currently known alive after the last observation. */
    get live() {
      return live;
    },
    /** Pre-termination snapshot; call while the root still runs. */
    async capture({ rootExited = false } = {}) {
      if (rootPid <= 0) return false;
      // Even if an in-flight read saw the root, children may have appeared
      // since it began. Join the next fresh read before parent links break.
      const table = await readProcessTable();
      absorb(table, rootIsAlive(table, rootExited));
      return complete;
    },
    /** For a root that exited ON ITS OWN (no kill in between): it is observed
     *  after exit exactly like a foreground command's settle. Callers never
     *  waive a missing pre-kill snapshot with it. */
    acceptExitObservation() {
      if (rootPid > 0) complete = true;
    },
    async observe({ rootExited = true } = {}) {
      if (rootPid <= 0) return 'unknown';
      const table = await readProcessTable();
      const rootAlive = rootIsAlive(table, rootExited);
      absorb(table, rootAlive);
      live = [];
      if (rootAlive) {
        live = [{ pid: rootPid, token: rootToken, name: table.nameOf.get(rootPid) || '' }];
        return 'running';
      }
      let unknown = false;
      for (const entry of tracked.values()) {
        const state = present(table, entry);
        if (state === true) live.push(entry);
        else if (state === null) unknown = true;
      }
      if (live.length > 0) return 'running';
      // Known survivors can still be swept after an incomplete capture, but
      // their absence cannot prove that an unobserved descendant is gone.
      return !complete || unknown ? 'unknown' : 'gone';
    },
  };
}

/** Terminate every identity the last observation found alive (console hosts
 *  excepted: they are witnesses, never workers). These are processes of a tree
 *  that was KILLED — they escaped its process group (setsid, job control, a
 *  double fork that kept its parent link) or outlived the root on Windows —
 *  so the kill is not finished while they run. Windows: taskkill /T /F;
 *  POSIX: SIGTERM, then SIGKILL after a short grace. */
export function sweepLiveIdentities(tracker) {
  const targets = tracker.live
    .filter((entry) => entry.token != null && !CONSOLE_HOST.test(entry.name))
    .map((entry) => entry.pid);
  return targets.length > 0 ? killProcessTrees(targets) : Promise.resolve();
}

/** A tracker for a watch that goes on after its hold was force-released: an
 *  observation that stays 'unknown' on a tracker that can never complete (the
 *  root is gone and its pre-kill capture was incomplete) ends the watch via
 *  `stop`. Termination is never reported by it. */
export function endWatchWhenUnconfirmable(tracker, { released, stop }) {
  return Object.create(tracker, {
    observe: {
      value: async (options) => {
        const state = await tracker.observe(options);
        if (released() && state === 'unknown' && !tracker.complete) stop();
        return state;
      },
    },
  });
}

/** One observation loop: observe now, then every `intervalMs` until the tree
 *  is confirmed gone, then run `onTerminated` once. 'running', 'unknown', a
 *  failed or unanswered (by the next cadence tick) observation and a failing
 *  `onTerminated` all re-check on the same cadence; the first pass that is not
 *  'gone' calls `onUnconfirmed` once. The returned stop() clears the pending
 *  timer; nothing else (listener, timer) outlives the loop. Nothing in it ever
 *  releases on time alone.
 *
 *  `sweep` (a killed tree; a boolean, or a predicate read on every pass so a
 *  cancel that arrives later is retried each cadence): a pass that finds captured identities alive
 *  terminates them and observes again in the same pass, so a cancellation
 *  ends with the tree gone instead of a held folder over live processes.
 *  A missing pre-kill capture stays unknown even if the owning session
 *  closes: its lifetime is not evidence that every descendant has exited. */
export function watchTermination({
  tracker,
  rootExited = () => true,
  onTerminated,
  onUnconfirmed = null,
  releaseRequested = null,
  intervalMs = TERMINATION_RECHECK_MS,
  sweep = false,
}) {
  let timer = null;
  let stopped = false;
  let reportedUnconfirmed = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const pass = async () => {
    timer = null;
    if (stopped) return;
    let state = 'unknown';
    let observation = null;
    // An explicit user force-release made from another process (the hold's
    // workspace is visible there): released as if confirmed, never on time.
    if (releaseRequested?.()) state = 'gone';
    else
      try {
        observation = tracker.observe({ rootExited: rootExited() });
        observation.catch(() => {});
        // A pass that has not answered by the next cadence tick is unknown.
        state = await withinBound(observation, intervalMs, 'unknown');
        if (state === 'running' && !stopped && (typeof sweep === 'function' ? sweep() : sweep)) {
          await withinBound(
            sweepLiveIdentities(tracker).catch(() => {}),
            intervalMs,
            null
          );
          await observation.catch(() => {});
          observation = tracker.observe({ rootExited: rootExited() });
          observation.catch(() => {});
          state = await withinBound(observation, intervalMs, 'unknown');
        }
      } catch {
        state = 'unknown';
      }
    if (stopped) return;
    if (state !== 'gone' && !reportedUnconfirmed) {
      reportedUnconfirmed = true;
      try {
        onUnconfirmed?.();
      } catch {
        /* presentation only */
      }
    }
    if (state === 'gone') {
      try {
        await onTerminated();
        stop();
        return;
      } catch {
        /* the release failed: the reservation stays and is re-checked */
      }
    }
    // The next pass never starts beside this pass's enumerator: a table read
    // always settles by its own deadline (killed on timeout).
    if (observation)
      await observation.then(
        () => {},
        () => {}
      );
    if (stopped) return;
    timer = setTimeout(pass, intervalMs);
    timer.unref?.();
  };
  void pass();
  return stop;
}

// Windows attaches a console host to the hidden console the shell runs in. It
// is a real child of the shell and it lives exactly as long as console clients
// remain, which makes it a liveness WITNESS for descendants that pid-level
// tracking can no longer reach — but it is never a kill target: terminating it
// leaves the actual worker running (verified) and would only destroy the
// witness.
const CONSOLE_HOST = /^conhost\.exe$/i;

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Observe what the finished command left running.
 *
 *  Returns null when nothing is left (the normal case — the caller then
 *  reports a plain completion), or a handle describing the survivors:
 *    groupPid   POSIX process group that still has members
 *    killPids   pids a cancellation can signal directly
 *    watchPids  pids of the observed survivors
 *    watch      their identities ({ pid, token, name }); liveness and kills
 *               compare these, never the bare pid
 *    reachable  false when survivors are observable but no longer addressable
 *               by pid (Windows re-parents nothing: a process whose parent
 *               exited keeps a dangling parent id, so an intermediate that
 *               already exited breaks the link).
 *  Rejects when the process table cannot be read completely. */
export async function probeShellDescendants({ pid } = {}) {
  const root = Number(pid) || 0;
  if (root <= 0) return null;
  // POSIX fast path: no member of the command's group at all.
  if (!isWin && !groupAlive(root)) return null;
  const tracker = createProcessTreeTracker({ pid: root, exitObserved: true });
  const state = await tracker.observe({ rootExited: true });
  if (state === 'gone') return null;
  if (state === 'unknown') throw new Error('Remaining child processes could not be verified.');
  return survivorHandle(root, tracker.live);
}

function survivorHandle(rootPid, live) {
  const watch = live.map(({ pid, token, name }) => ({ pid, token, name }));
  const killPids = watch.filter((entry) => !CONSOLE_HOST.test(entry.name)).map((entry) => entry.pid);
  return {
    rootPid,
    groupPid: isWin ? null : rootPid,
    killPids,
    watchPids: watch.map((entry) => entry.pid),
    watch,
    reachable: !isWin || killPids.length > 0,
  };
}

const trackerFor = (handle) =>
  createProcessTreeTracker({ pid: handle.rootPid, members: handle.watch, exitObserved: true });

/** Resolve once every observed survivor (by identity) has exited, or false
 *  once `signal` aborts. These processes are not our children any more, so
 *  there is no exit event to subscribe to; the shared observation loop
 *  re-checks them at the termination cadence. */
export function waitForShellDescendants(handle, { signal = null, sweep = false } = {}) {
  if (!handle) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      stop();
      resolve(false);
    };
    const stop = watchTermination({
      tracker: trackerFor(handle),
      sweep,
      onTerminated: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Terminate the survivors, signalling only processes whose identity still
 *  matches the observation, then RE-OBSERVE so the caller reports what
 *  actually died instead of what was signalled. Never rejects. */
export async function killShellDescendants(handle) {
  if (!handle) return { terminated: true, survivors: [] };
  try {
    const table = await readProcessTable();
    // The group id is ours only while no other process holds the root pid.
    if (handle.groupPid && !table.tokenOf.has(handle.groupPid)) {
      try {
        process.kill(-handle.groupPid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await delay(200);
      if (groupAlive(handle.groupPid)) {
        try {
          process.kill(-handle.groupPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await delay(100);
      }
    }
    const targets = handle.watch
      .filter((entry) => entry.token != null && table.tokenOf.get(entry.pid) === entry.token)
      .filter((entry) => !CONSOLE_HOST.test(entry.name))
      .map((entry) => entry.pid);
    await killProcessTrees(targets).catch(() => {});
    const tracker = trackerFor(handle);
    let state = await tracker.observe({ rootExited: true });
    // What the first kill missed (a child forked meanwhile, a slow exit) is
    // found by the re-observation itself and killed in the next round.
    for (let round = 1; state === 'running' && round < KILL_ROUNDS; round += 1) {
      await sweepLiveIdentities(tracker).catch(() => {});
      state = await tracker.observe({ rootExited: true });
    }
    return { terminated: state === 'gone', survivors: tracker.live.map((entry) => entry.pid) };
  } catch {
    return { terminated: false, survivors: [...handle.watchPids] };
  }
}
