#!/usr/bin/env node
/**
 * Regression harness for the ctrl+wheel mouse-mode restore state machine.
 *
 * Run: node scripts/mouse-tracking-restore-smoke.mjs
 */
import {
  cancelPendingMouseTrackingRestores,
  createMouseTrackingRestoreScheduler,
} from '../src/tui/app/use-mouse-input.mjs';

const expected = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l';
const expectedPassthrough = '\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l';
let failures = 0;

function check(name, condition) {
  if (condition) console.log(`ok   - ${name}`);
  else {
    failures += 1;
    console.log(`FAIL - ${name}`);
  }
}

function fakeTimers() {
  const entries = [];
  return {
    entries,
    setTimeoutFn(fn, delay) {
      const entry = { fn, delay, cleared: false, ran: false, unref() {} };
      entries.push(entry);
      return entry;
    },
    clearTimeoutFn(entry) {
      entry.cleared = true;
    },
    runNext() {
      const entry = entries.find((item) => !item.cleared && !item.ran);
      if (!entry) return false;
      entry.ran = true;
      entry.fn();
      return true;
    },
  };
}

function createHarness({ alwaysFail = false } = {}) {
  const timers = fakeTimers();
  const writes = [];
  const stdout = {
    write(value, callback) {
      writes.push({ value, callback });
      if (alwaysFail) callback(Object.assign(new Error('temporarily unavailable'), { code: 'EAGAIN' }));
      return false; // backpressure alone is not failure
    },
  };
  const scheduler = createMouseTrackingRestoreScheduler(stdout, timers);
  scheduler.attach();
  return { scheduler, timers, writes };
}

{
  const { scheduler, timers, writes } = createHarness();
  scheduler.schedule();
  check('initial restore is delayed 700ms', timers.entries[0]?.delay === 700);
  timers.runNext();
  check('restore emits all mouse modes plus alternate-scroll off', writes[0]?.value === expected);
  writes[0].callback(Object.assign(new Error('temporarily unavailable'), { code: 'EAGAIN' }));
  check('async EAGAIN schedules a 200ms retry', timers.entries[1]?.delay === 200);
  scheduler.detach();
}

{
  const { scheduler, timers, writes } = createHarness({ alwaysFail: true });
  scheduler.schedule();
  while (timers.runNext()) { /* drain deterministic retries */ }
  check('async failure is capped at five retries', writes.length === 6);
  check('retry cap leaves no runnable timer', timers.runNext() === false);
  scheduler.detach();
}

{
  const { scheduler, timers, writes } = createHarness();
  scheduler.schedule();
  const staleTimer = timers.entries[0];
  scheduler.schedule();
  staleTimer.fn(); // simulate a callback already queued when clearTimeout ran
  check('stale-generation restore callback is a no-op', writes.length === 0);
  timers.runNext();
  check('current generation still restores', writes.length === 1);
  scheduler.detach();
}

{
  const { scheduler, timers, writes } = createHarness();
  scheduler.passthrough();
  check('ctrl+wheel emits the guarded passthrough modes', writes[0]?.value === expectedPassthrough);
  const queuedBeforeTerminalRestore = timers.entries[0];
  cancelPendingMouseTrackingRestores();
  queuedBeforeTerminalRestore.fn();
  const writesAtRestore = writes.length;
  scheduler.passthrough(); // late buffered ctrl+wheel after restoreTerminal()
  check('late ctrl+wheel after terminal restore emits no mode bytes',
    writes.length === writesAtRestore && timers.runNext() === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
