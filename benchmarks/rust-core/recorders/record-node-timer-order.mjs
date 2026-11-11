#!/usr/bin/env node
// The order in which Node's own event loop fires timers that are due in the same millisecond, recorded from real Node
// timers (no mock), for the core's replay clock (native/core/crates/mixdog-rt/src/virtual_clock.rs), whose replay of these
// cases is native/core/crates/mixdog-rt/tests/virtual_clock.rs `node_timer_order`.
//
// Each case runs in a Node process of its own (fresh timer lists), on an idle loop that turns exactly at each timer list's
// expiry: before every turn the thread is blocked until the loop's clock reaches the head list's expiry, so every timer due
// at that millisecond is due before the loop turns and none due later is. A run is kept only if it shows that: every timer
// armed in a turn has `_idleStart` equal to the turn's millisecond, and every timer that fires has its due equal to it.
// A run that misses (the loop's clock crossed into the next millisecond before Node read it) is discarded and the case run
// again in a new process, up to ATTEMPTS times; the manifest lists the attempts each case took.
//
//   node benchmarks/rust-core/recorders/record-node-timer-order.mjs --tree <export of b6f10295a with node_modules> [--only <case>]
//
// Output: native/core/fixtures/node-timer-order/golden.json (every case, its script, and the events in firing order with
// the millisecond each fired at, from the case's start).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMIT } from './lib/case-set.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const ATTEMPTS = 10;

// A script is a list of actions run in order inside a callback (or at the case's start):
//   { timeout, ms, then?, unref?, ref? }   setTimeout(ms), `unref()`ed, then `ref()`ed again; when it fires: log, run `then`
//   { interval, ms, times, then?, unref? } setInterval(ms); each fire: log, run `then`; clearInterval after `times` fires
//   { clear }                        clearTimeout of the timer named `clear`
//   { immediate, then? }             setImmediate; when it runs: log, run `then`
//   { tick } / { promise }           process.nextTick / Promise.resolve().then, each logging its name
// `core` says whether the core's timers can express the case (`mixdog_rt::time` and the ticker, a spawned task for a tick or
// a promise job) and, when not, why: the replay runs exactly the cases with `core: true`.
const t = (timeout, ms, then = [], extra = {}) => ({ timeout, ms, then, ...extra });
const CASES = [
  { name: 'same-due-armed-in-order', core: true, script: [t('a', 100), t('b', 100), t('c', 100)] },
  { name: 'a-requeued-list-after-an-older-list', core: true, script: [t('x50', 50, [t('y50', 50)]), t('z100', 100)] },
  { name: 'reviewer-with-first100', core: true, script: [t('first100', 100), t('p10', 10, [t('q100', 100)]), t('r20', 20, [t('s90', 90)])] },
  { name: 'reviewer-without-first100', core: true, script: [t('p10', 10, [t('q100', 100)]), t('r20', 20, [t('s90', 90)])] },
  {
    name: 'many-lists-due-at-once',
    core: true,
    script: [t('a60', 60), t('g20', 20), t('k10', 10, [t('b50', 50)]), t('k20', 20, [t('c40', 40)]), t('k30', 30, [t('d30', 30), t('e30', 30)]), t('k40', 40, [t('h20', 20)])],
  },
  { name: 'zero-and-one-ms-inside-a-timer', core: true, script: [t('a', 100, [t('n0', 0), t('n1', 1), t('n2', 2)]), t('x101', 101), t('y102', 102)] },
  { name: 'armed-inside-a-timer-for-an-instant-already-queued', core: true, script: [t('a', 100, [t('b', 10)]), t('c', 110), t('d', 110)] },
  { name: 'ticks-and-promises-between-timers', core: true, script: [t('a', 10, [{ tick: 'a-tick' }, { promise: 'a-promise' }]), t('b', 10, [{ tick: 'b-tick' }]), t('c', 20)] },
  { name: 'a-promise-queued-before-a-tick', core: 'process.nextTick runs before promise jobs whatever their order; the core runs the tasks a timer spawns in the order it spawned them, and no core code is a counterpart of process.nextTick (Node b6f10295a calls it nowhere in src/ outside tests)', script: [t('a', 10, [{ promise: 'a-promise' }, { tick: 'a-tick' }]), t('b', 10)] },
  { name: 'immediates-after-all-timers-of-a-turn', core: true, script: [t('a', 10, [{ immediate: 'a-immediate' }, { tick: 'a-tick' }]), t('b', 10), t('c', 11)] },
  { name: 'immediates-queued-by-immediates-run-a-loop-turn-later', core: true, script: [t('a', 10, [{ immediate: 'i1', then: [{ immediate: 'i2', then: [t('n1', 1)] }] }, t('n0', 1)]), t('b', 10, [{ immediate: 'ib' }]), t('c', 11)] },
  { name: 'an-immediate-from-the-start-before-a-1ms-timer', core: true, script: [t('a', 1), { immediate: 'i0' }] },
  { name: 'immediates-of-two-lists-in-the-order-queued', core: true, script: [t('x', 10, [{ immediate: 'ix' }]), t('y', 5, [t('z', 5, [{ immediate: 'iz' }])])] },
  { name: 'a-timer-armed-by-an-immediate', core: true, script: [t('a', 10, [{ immediate: 'i', then: [t('n0', 0)] }]), t('b', 11)] },
  { name: 'an-interval-rearms-after-its-callback', core: true, script: [{ interval: 'i', ms: 50, times: 3, then: [t('j50', 50)] }, t('t100', 100), t('t150', 150)] },
  { name: 'clearing-due-timers-from-an-earlier-one', core: true, script: [t('a', 100, [{ clear: 'b' }, { clear: 'w' }]), t('b', 100), t('c', 100), t('x', 10, [t('w', 90)])] },
  { name: 'unref-keeps-the-order', core: true, script: [t('a', 100, [], { unref: true }), t('b', 100)] },
  { name: 'clearing-an-unrefed-timer-keeps-its-list', core: true, script: [t('u', 100, [], { unref: true }), t('k', 10, [{ clear: 'u' }, t('v', 100)]), t('r', 20, [t('s', 90)])] },
  { name: 'clearing-a-reref-ed-timer-recreates-its-list', core: true, script: [t('u', 100, [], { unref: true, ref: true }), t('k', 10, [{ clear: 'u' }, t('v', 100)]), t('r', 20, [t('s', 90)])] },
  { name: 'a-rearmed-unrefed-watchdog-joins-its-old-list', core: true, script: [t('w1', 100, [], { unref: true }), t('k', 10, [{ clear: 'w1' }, t('w2', 100, [], { unref: true })]), t('r', 20, [t('s', 90)])] },
  { name: 'clearing-an-unrefed-interval-keeps-its-list', core: true, script: [{ interval: 'w', ms: 50, times: 99, unref: true }, t('k', 60, [{ clear: 'w' }, t('v', 50)]), t('r', 70, [t('s', 40)])] },
  { name: 'clearing-a-refed-timer-recreates-its-list', core: true, script: [t('a', 100), t('k', 10, [{ clear: 'a' }, t('b', 100)]), t('m', 20, [t('c', 90)])] },
  { name: 'fractions-of-a-millisecond-are-cut', core: true, script: [t('a', 1.7), t('b', 1), t('c', 0.4)] },
];

/** One case in this process: the events, or the reason the run missed its millisecond. */
function runCase(spec) {
  const require = createRequire(import.meta.url);
  const { internalBinding } = require('internal/test/binding');
  const { timerListQueue } = require('internal/timers');
  const binding = internalBinding('timers');
  const now = () => binding.getLibuvNow();
  const events = [];
  const misses = [];
  const handles = new Map();
  let start = 0;
  let current = 0;
  // The case's immediates queued and not yet run.
  let immediates = 0;
  const log = (name) => events.push([name, current - start]);
  const due = (handle) => handle._idleStart + Math.trunc(handle._repeat ?? handle._idleTimeout);
  const armed = (name, handle) => {
    if (handle._idleStart !== current) misses.push(`${name} armed at ${handle._idleStart - start}, in the turn at ${current - start}`);
    handles.set(name, handle);
  };
  const fired = (name, handle) => {
    if (due(handle) !== current) misses.push(`${name} due at ${due(handle) - start} fired in the turn at ${current - start}`);
    log(name);
  };
  const run = (actions) => {
    for (const action of actions) {
      if ('timeout' in action) {
        const handle = setTimeout(() => {
          fired(action.timeout, handle);
          run(action.then);
        }, action.ms);
        if (action.unref) handle.unref();
        if (action.ref) handle.ref();
        armed(action.timeout, handle);
      } else if ('interval' in action) {
        let fires = 0;
        const handle = setInterval(() => {
          fired(action.interval, handle);
          fires += 1;
          if (fires === action.times) clearInterval(handle);
          run(action.then ?? []);
        }, action.ms);
        if (action.unref) handle.unref();
        armed(action.interval, handle);
      } else if ('clear' in action) clearTimeout(handles.get(action.clear));
      else if ('tick' in action) process.nextTick(() => log(action.tick));
      else if ('promise' in action) Promise.resolve().then(() => log(action.promise));
      else if ('immediate' in action) {
        immediates += 1;
        setImmediate(() => {
          immediates -= 1;
          log(action.immediate);
          run(action.then ?? []);
        });
      } else throw new Error(`unknown action ${JSON.stringify(action)}`);
    }
  };
  // Blocks until the loop's clock reaches the head list's expiry, then lets the loop turn; once no list is left, ends. While
  // the case's immediates are queued it only queues itself behind them, so they run (and log) in the turn they belong to.
  const turn = () => {
    if (immediates > 0) {
      setImmediate(turn);
      return;
    }
    const head = timerListQueue.peek();
    if (!head) {
      process.stdout.write(`${JSON.stringify(misses.length ? { misses } : { events })}\n`);
      process.exit(misses.length ? 3 : 0);
    }
    current = head.expiry;
    while (now() < current);
    setImmediate(turn);
  };
  setImmediate(() => {
    start = current = now();
    run(spec.script);
    setImmediate(turn);
  });
}

const args = parseArgs();
if (args.has('case')) {
  runCase(CASES.find((spec) => spec.name === args.get('case')));
} else {
  const only = args.get('only');
  const selected = only ? CASES.filter((spec) => spec.name === only) : CASES;
  if (!selected.length) throw new Error(`no case named ${only}`);
  const recorder = fileURLToPath(import.meta.url);
  const cases = [];
  for (const spec of selected) {
    let attempts = 0;
    let result = null;
    while (!result) {
      attempts += 1;
      const child = spawnSync(process.execPath, ['--expose-internals', recorder, '--case', spec.name], { encoding: 'utf8', timeout: 60_000, windowsHide: true, killSignal: 'SIGKILL' });
      if (child.error) throw child.error;
      const last = child.stdout.trim().split('\n').at(-1);
      const out = last ? JSON.parse(last) : null;
      if (child.status === 0 && out?.events) result = out.events;
      else if (child.status === 3 && attempts < ATTEMPTS) continue;
      else throw new Error(`case ${spec.name}, attempt ${attempts}: exit ${child.status}: ${child.stdout}${child.stderr}`);
    }
    cases.push({ name: spec.name, core: spec.core, script: spec.script, attempts, events: result });
    console.log(`${spec.name}: ${result.map(([name, at]) => `${name}@${at}`).join(' ')} (attempt ${attempts})`);
  }
  if (!only) {
    const finalDir = join(FIXTURES_ROOT, 'node-timer-order');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), { node: process.version, cases });
    writeSetManifest(stage, {
      set: 'node-timer-order',
      recorder: 'benchmarks/rust-core/recorders/record-node-timer-order.mjs',
      command: `node benchmarks/rust-core/recorders/record-node-timer-order.mjs --tree <export of ${COMMIT} with node_modules>`,
      // No product code is loaded: the tree states the Node product the recording stands for, as every set does.
      identity: exactProductIdentity(resolveTree(args), COMMIT),
      extra: {
        ...recorderProvenance(import.meta.url),
        attempts: Object.fromEntries(cases.map((spec) => [spec.name, spec.attempts])),
        exclusions: Object.fromEntries(cases.filter((spec) => spec.core !== true).map((spec) => [spec.name, spec.core])),
      },
    });
    commitStage(stage, finalDir);
  }
}
