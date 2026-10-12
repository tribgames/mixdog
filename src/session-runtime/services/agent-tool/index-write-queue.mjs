// index-write-queue.mjs
// One in-process writer for a shared JSON index file (worker / Lead pool
// indexes). It replaces synchronous locked read-modify-writes, whose lock wait
// (Atomics.wait) and disk I/O ran on the daemon event loop.
//
// write(mutator) still runs the mutator synchronously and exactly once, against
// the in-memory projection (disk document + every not-yet-persisted change), so
// callers keep their read-your-writes and "did it apply?" semantics. What is
// persisted is the mutator's EFFECT (per-key set/delete + priority keys), not
// the mutator: an async job replays those effects onto the fresh on-disk
// document under the cross-process lock, so concurrent writers of other keys
// are merged, never overwritten. Jobs run strictly one at a time in FIFO order.
//
// write(mutator, { rerun: true }) is the conditional-update form: the mutator
// itself is queued and re-run against the locked fresh document, in order with
// the recorded effects, so a field-level update re-checks its condition against
// what is really on disk instead of replacing a whole value it once saw.
import { updateJsonAtomic, updateJsonAtomicSync } from '../../../runtime/shared/atomic-file.mjs';
import { registerJsonProjection } from '../../../runtime/shared/pending-json-projection.mjs';
import { sleep } from '../../../runtime/shared/sleep.mjs';

const RETRY_DELAYS_MS = [50, 250, 1000];
const unsettled = new Set(); // queues holding unpersisted writes
// Exit is the one place a bounded synchronous lock wait is acceptable: the
// loop is gone, and a dropped settlement would leave rows "running" forever.
const EXIT_LOCK_TIMEOUT_MS = 250;

function snapshot(arg) {
  if (arg instanceof Map) {
    const copy = new Map();
    for (const [key, value] of arg) copy.set(key, JSON.stringify(value));
    return copy;
  }
  if (arg instanceof Set) return new Set(arg);
  return null;
}

/** Effects of `run` on the Map/Set arguments, as replayable ops. */
function recordOps(args, run) {
  const before = args.map(snapshot);
  run();
  return args.map((arg, index) => {
    const prior = before[index];
    if (arg instanceof Map) {
      const set = [];
      const del = [];
      for (const [key, value] of arg) {
        const json = JSON.stringify(value);
        if (prior.get(key) !== json) set.push([key, json]);
      }
      for (const key of prior.keys()) if (!arg.has(key)) del.push(key);
      return { set, del };
    }
    if (arg instanceof Set) return { add: [...arg].filter((value) => !prior.has(value)) };
    return null;
  });
}

/**
 * Collapse a sequence of op sets into one op set per argument slot with the
 * same sequential outcome: every key ever deleted is deleted (so a foreign
 * writer's key is still removed), then each surviving key is set once with its
 * final value, ordered as sequential insertion would leave it (an overwrite
 * keeps its position, a delete/reinsert moves to the end). Set adds are unioned.
 */
function compactOps(batch) {
  const slots = [];
  for (const ops of batch) {
    ops.forEach((op, index) => {
      if (!op) return;
      let slot = slots[index];
      if (!slot) {
        slot = slots[index] = op.add ? { add: new Set() } : { del: new Set(), final: new Map() };
      }
      if (slot.add) {
        for (const value of op.add) slot.add.add(value);
        return;
      }
      for (const key of op.del) {
        slot.del.add(key);
        slot.final.delete(key);
      }
      for (const [key, json] of op.set) slot.final.set(key, json);
    });
  }
  return slots.map((slot) => {
    if (!slot) return null;
    if (slot.add) return { add: slot.add };
    return { del: slot.del, set: slot.final };
  });
}

function replayOps(ops, args, mergeSet) {
  args.forEach((arg, index) => {
    const op = ops[index];
    if (!op) return;
    if (arg instanceof Map) {
      for (const key of op.del) arg.delete(key);
      for (const [key, json] of op.set) arg.set(key, mergeSet(index, arg.get(key), JSON.parse(json)));
    } else if (arg instanceof Set) {
      for (const value of op.add) arg.add(value);
    }
  });
}

/** Entries are recorded op sets or re-run mutators; runs of op sets between
 *  re-run mutators compact, and every entry keeps its place in the order. */
function replayBatch(batch, args, mergeSet) {
  let run = [];
  const replayRun = () => {
    if (run.length) replayOps(compactOps(run), args, mergeSet);
    run = [];
  };
  for (const entry of batch) {
    if (typeof entry !== 'function') {
      run.push(entry);
      continue;
    }
    replayRun();
    entry(...args);
  }
  replayRun();
}

function reportFailure(file, what, error) {
  process.stderr.write(`[index-write] ${file}: ${what}: ${error?.message || error}\n`);
}

/**
 * @param {object} options
 * @param {string|null} options.file       index file; null → every write is a no-op
 * @param {(cur: any, mutator: Function) => any} options.rewrite
 *        builds the next document from a raw one; `mutator` receives the keyed collections
 * @param {() => any} options.readDoc      fresh raw document from disk (sync read)
 * @param {() => void} [options.onPersisted]  the file changed on disk
 * @param {(index: number, prev: any, next: any) => any} [options.mergeSet]
 *        value a recorded set leaves in Map argument `index`, given the locked
 *        document's current value there; default: the recorded value
 */
export function createIndexWriteQueue({
  file,
  rewrite,
  readDoc,
  onPersisted = () => {},
  mergeSet = (_index, _prev, next) => next,
}) {
  let projection = null; // raw document including unpersisted ops, else null
  const self = { flush, flushSync: () => flushSync() };
  if (file) registerJsonProjection(file, () => projection);
  let version = 0;
  let pending = []; // op sets not yet handed to a job
  let inflight = []; // op sets of the running job
  let running = null;
  let timer = null;

  function clearTimer() {
    if (!timer) return;
    clearImmediate(timer);
    timer = null;
  }

  function schedule() {
    if (timer || running || pending.length === 0) return;
    timer = setImmediate(drain);
  }

  async function persist(batch) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await updateJsonAtomic(file, (cur) => rewrite(cur, (...args) => replayBatch(batch, args, mergeSet)), {
          lock: true,
        });
        return;
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          reportFailure(file, `dropped ${batch.length} unpersisted write(s)`, error);
          return;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  function drain() {
    timer = null;
    if (running || pending.length === 0) return;
    inflight = pending;
    pending = [];
    const batch = inflight;
    running = persist(batch).then(() => {
      inflight = [];
      running = null;
      onPersisted();
      if (pending.length === 0) {
        projection = null;
        unsettled.delete(self);
      }
      schedule();
    });
  }

  /** Resolves once everything written so far is on disk (or dropped). */
  async function flush() {
    for (;;) {
      if (running) {
        await running;
        continue;
      }
      if (pending.length === 0) return;
      clearTimer();
      drain();
    }
  }

  /** Exit path: persist inflight + pending ops synchronously (bounded lock wait). */
  function flushSync() {
    const ops = [...inflight, ...pending];
    if (!file || ops.length === 0) return true;
    clearTimer();
    pending = [];
    try {
      updateJsonAtomicSync(file, (cur) => rewrite(cur, (...args) => replayBatch(ops, args, mergeSet)), {
        lock: true,
        timeoutMs: EXIT_LOCK_TIMEOUT_MS,
      });
    } catch (error) {
      reportFailure(file, `synchronous flush of ${ops.length} write(s) failed; kept queued`, error);
      pending = ops;
      return false;
    }
    inflight = [];
    projection = null;
    unsettled.delete(self);
    onPersisted();
    return true;
  }

  return {
    /** Run `mutator` now against the projection; persist its effect later
     *  (`rerun`: persist by re-running it on the locked document instead).
     *  Returns the projected document, or null (no file / mutator threw). */
    write(mutator, { rerun = false } = {}) {
      if (!file || typeof mutator !== 'function') return null;
      try {
        let ops = null;
        const next = rewrite(projection ?? readDoc(), (...args) => {
          if (rerun) mutator(...args);
          else ops = recordOps(args, () => mutator(...args));
        });
        projection = next;
        version += 1;
        pending.push(rerun ? mutator : ops);
        unsettled.add(self);
        schedule();
        return next;
      } catch {
        return null;
      }
    },
    /** Document including unpersisted writes, or null when disk is current. */
    projection: () => projection,
    version: () => version,
    hasUnpersisted: () => projection !== null,
    flush,
    flushSync,
  };
}

/** Synchronous variant (exit paths, tests that read the file directly). */
export function flushAllIndexWritesSync() {
  for (const queue of [...unsettled]) queue.flushSync();
}

/** Resolves once every queue in this process has persisted what it holds. */
export async function flushAllIndexWrites() {
  while (unsettled.size > 0) await Promise.all([...unsettled].map((queue) => queue.flush()));
}
