// Preloaded into Node's daemon by a recorder (node --import <this file>, with MIXDOG_REC_STATUS_CLOCK naming a folder): the daemon's
// session status scheduler (session-status-scheduler.mjs) runs on a virtual clock that moves only when the recorder says so, so a
// session's runtime-derived status (route, context windows, agent status: local-session-runtime.mjs `createRuntimePulse`) is in the
// state the recorder brought it to, never in whichever state a pass happened to have reached.
//
// The recorder writes `advance-<n>.json` ({ steps: [{ markAll, ms }] }, n = 1, 2, ...) into the folder (by rename, so it is whole);
// the daemon runs each step - `markAll` marks every session's pass as a daemon-wide change does (the config-input epoch,
// `subscribeDaemonChanges`), then the clock moves `ms` and every timer due in that span runs in order - and answers `done-<n>.json`.
// An order names the daemon's pid: only that process answers; another process this preload reaches leaves the orders alone.
import { register } from 'node:module';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MIXDOG_REC_STATUS_CLOCK;
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
  // `scheduler`: the daemon made its scheduler (a session registered a pass).
  const clock = { now: () => at, timers, scheduler: null };
  globalThis.__mixdogRecStatusClock = clock;
  let handled = 0;
  const take = () => {
    for (;;) {
      let request;
      try {
        request = JSON.parse(readFileSync(join(dir, `advance-${handled + 1}.json`), 'utf8'));
      } catch {
        return;
      }
      if (request.pid !== process.pid) return;
      handled += 1;
      // No scheduler yet: no session has registered a pass, so there is nothing to settle; the clock still moves.
      const recomputes = () => clock.scheduler?.counters().recomputes ?? 0;
      const before = recomputes();
      for (const step of request.steps) {
        if (step.markAll) clock.scheduler?.markAll();
        advance(step.ms);
      }
      const answer = join(dir, `done-${handled}.json.tmp`);
      writeFileSync(answer, JSON.stringify({ pid: process.pid, at, passes: recomputes() - before }));
      renameSync(answer, join(dir, `done-${handled}.json`));
    }
  };
  watch(dir, take).unref();
}
