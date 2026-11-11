// Preloaded into Node's daemon by a recorder (node --import <this file>, with MIXDOG_REC_STATUS_CLOCK naming a folder): the daemon's
// session status scheduler (session-status-scheduler.mjs) runs on a virtual clock that moves only when the recorder says so, so a
// session's runtime-derived status (route, context windows, agent status: local-session-runtime.mjs `createRuntimePulse`) is in the
// state the recorder brought it to, never in whichever state a pass happened to have reached.
//
// The recorder writes `advance-<n>.json` ({ steps: [{ markAll, ms }] }, n = 1, 2, ...) into the folder (by rename, so it is whole);
// the daemon runs each step - `markAll` marks every session's pass as a daemon-wide change does (the config-input epoch,
// `subscribeDaemonChanges`), then the clock moves `ms` and every timer due in that span runs in order, then the work those timers
// started settles - and answers `done-<n>.json` (`{ error }` when a wait passed its deadline). The config-change debounce
// (config.mjs `notifyConfigChanged`) runs on the same clock, so a settings change reaches the sessions at an order, never between.
// An order names the daemon's pid: only that process answers; another process this preload reaches leaves the orders alone.
import { register } from 'node:module';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MIXDOG_REC_STATUS_CLOCK;
/** The type of the frame an order's answer broadcasts last (status-clock-hooks.mjs `STREAM`). */
const MARKER = 'rec-status-clock';
if (dir) {
  register('./status-clock-hooks.mjs', import.meta.url);
  let at = 0;
  let order = 0;
  const due = [];
  const timers = {
    setTimeout(run, ms) {
      const timer = { at: at + Math.max(0, Number(ms) || 0), order: ++order, run, unref: () => timer, ref: () => timer };
      due.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = due.indexOf(timer);
      if (index >= 0) due.splice(index, 1);
    },
  };
  const advance = (ms) => {
    const end = at + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = due[0];
      if (!next || next.at > end) break;
      due.shift();
      at = next.at;
      next.run();
    }
    at = end;
  };
  // `scheduler`: the daemon made its scheduler (a session registered a pass). `prewarms`: each agent tool's keychain prewarm
  // (status-clock-hooks.mjs), real I/O an order waits for (30 s deadline) before it moves the clock. `track`: work the clock's
  // timers started that goes on after its timer returned (a config-change pass, its effects, a notification's delivery chain:
  // status-clock-hooks.mjs); an order answers once all of it, and whatever it started in turn, has settled.
  const pending = new Set();
  const track = (promise) => {
    const settled = Promise.resolve(promise).then(
      () => undefined,
      () => undefined
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return promise;
  };
  // `config`: the config watch (status-clock-hooks.mjs). `watching(read)` once the watch is set up - `read` gives the watched files'
  // bytes, which the watch starts from; `seen(bytes)` on each event. `caughtUp()` resolves once the last event saw the bytes on disk
  // (at once when the watch saw them, or when there is no watch).
  const config = {
    read: null,
    last: null,
    waiters: new Set(),
    watching(read) {
      config.read = read;
      config.last = JSON.stringify(read());
    },
    seen(bytes) {
      config.last = JSON.stringify(bytes);
      for (const waiter of [...config.waiters]) waiter();
    },
    caughtUp() {
      return new Promise((resolve) => {
        const check = () => {
          if (config.read && JSON.stringify(config.read()) !== config.last) return;
          config.waiters.delete(check);
          resolve();
        };
        config.waiters.add(check);
        check();
      });
    },
  };
  // `contextRead(read)`: `syncContextStats`' read of the runtime's status (status-clock-hooks.mjs on context-state.mjs); `moveRead(run)`
  // runs the one a route move makes (routes-write.mjs:142). Between an order with `statusReads.start` and one with `statusReads.take`
  // each read a move makes is kept as the fields `syncContextDisplayFields` takes from it (context-state.mjs:116-136), and the first
  // `fail` of them find no status (`null`, as a runtime without one answers). Other reads (a settings change's) are left alone.
  const reads = { log: null, failing: 0, moving: false };
  const moveRead = (run) => {
    reads.moving = true;
    try {
      return run();
    } finally {
      reads.moving = false;
    }
  };
  const contextRead = (read) => {
    if (!reads.moving || !reads.log) return read();
    if (reads.failing > 0) {
      reads.failing -= 1;
      reads.log.push(null);
      return null;
    }
    const ctx = read();
    const compaction = ctx?.compaction;
    reads.log.push(
      ctx
        ? {
            contextWindow: ctx.contextWindow ?? null,
            compaction: { boundaryTokens: compaction?.boundaryTokens ?? null, triggerTokens: compaction?.triggerTokens ?? null, autoCompactTokenLimit: compaction?.autoCompactTokenLimit ?? null },
          }
        : null
    );
    return ctx;
  };
  const clock = { now: () => at, timers, scheduler: null, prewarms: new Set(), streams: new Set(), track, config, contextRead, moveRead };
  globalThis.__mixdogRecStatusClock = clock;  /** Until no tracked work is left: each round awaits what is pending, which may start more, then lets the event loop turn once - a
   *  store hands its change to subscribers on a later turn (the projection's publish timer starts there). */
  const drained = async () => {
    do {
      while (pending.size) await Promise.all(pending);
      await new Promise((resolve) => setImmediate(resolve));
    } while (pending.size);
  };
  /** `promise`, or a failure naming `label` after 30 real seconds. */
  const within = (label, promise) => {
    let deadline;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`status-clock: ${label} did not settle in 30 s`)), 30_000);
      }),
    ]).finally(() => clearTimeout(deadline));
  };
  let handled = 0;
  // One reader at a time; a change seen while it reads makes it read once more.
  let taking = false;
  let again = false;
  const take = async () => {
    if (taking) return void (again = true);
    taking = true;
    do {
      again = false;
      await takeOrders();
    } while (again);
    taking = false;
  };
  const takeOrders = async () => {
    for (;;) {
      let request;
      try {
        request = JSON.parse(readFileSync(join(dir, `advance-${handled + 1}.json`), 'utf8'));
      } catch {
        return;
      }
      if (request.pid !== process.pid) return;
      handled += 1;
      let reply;
      try {
        await within('the keychain prewarm', Promise.all([...clock.prewarms].map((prewarm) => prewarm())));
        // A settings write before the order is saved (its debounced writer, status-clock-hooks.mjs) and reaches the daemon as a watch
        // event (real I/O); the clock moves once both have.
        await within('the config saves accepted before the order', Promise.resolve(clock.drainWrites?.()));
        await within('the config watch event for the files on disk', config.caughtUp());
        // No scheduler yet: no session has registered a pass, so there is nothing to settle; the clock still moves.
        const recomputes = () => clock.scheduler?.counters().recomputes ?? 0;
        const before = recomputes();
        if (request.statusReads?.start) {
          reads.log = [];
          reads.failing = request.statusReads.fail ?? 0;
        }
        for (const step of request.steps) {
          if (step.markAll) clock.scheduler?.markAll();
          advance(step.ms);
          await within('the work the clock started', drained());
        }
        // The order's marker, after everything its passes published: a client that has read it holds what the daemon does.
        for (const broadcast of clock.streams) broadcast({ type: MARKER, key: `${MARKER}:${handled}`, order: handled });
        reply = { pid: process.pid, at, passes: recomputes() - before, marker: handled };
        if (request.statusReads?.take) {
          Object.assign(reply, { statusReads: reads.log, unfailed: reads.failing });
          reads.log = null;
          reads.failing = 0;
        }
      } catch (error) {
        reply = { pid: process.pid, error: error.message };
      }
      const answer = join(dir, `done-${handled}.json.tmp`);
      writeFileSync(answer, JSON.stringify(reply));
      renameSync(answer, join(dir, `done-${handled}.json`));
    }
  };
  watch(dir, take).unref();
}
