// Regression for the execution-pending-resume kick (engine/agent-job-feed.mjs).
// Guards two coupled defects:
//   A (body loss): parallel completions deferred while busy must each surface
//     their model-visible body on resume — the old single string slot dropped
//     all but the last.
//   B (missed resume): a deferred kick left after a busy->false transition that
//     did NOT go through drain-finally / normal-turn-end (watchdog force-release
//     or stale-unwind) must still fire when flushDeferred is called.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentJobFeed } from '../src/tui/engine/agent-job-feed.mjs';

// Minimal harness: a mutable busy flag, a pending queue, and a synchronous
// drain stub that "resumes" by surfacing every pending-resume entry's body.
function makeHarness() {
  const pending = [];
  const surfaced = [];
  const state = { busy: false };
  let draining = false;

  function drain() {
    if (draining) return Promise.resolve();
    draining = true;
    try {
      for (let i = 0; i < pending.length;) {
        const entry = pending[i];
        if (entry.mode === 'pending-resume') {
          surfaced.push(entry.text);
          pending.splice(i, 1);
        } else {
          i += 1;
        }
      }
    } finally {
      draining = false;
    }
    return Promise.resolve();
  }

  const feed = createAgentJobFeed({
    runtime: {},
    getState: () => state,
    set: () => {},
    nextId: () => 'id',
    getDisposed: () => false,
    patchItem: () => {},
    enqueue: () => {},
    drain,
    pushUserOrSyntheticItem: () => {},
    makeQueueEntry: (text, opts = {}) => ({ text, mode: opts.mode, priority: opts.priority }),
    getPending: () => pending,
    agentStatusState: () => ({}),
    displayedExecutionNotificationKeys: new Set(),
    pushNotice: () => {},
  });

  return { feed, pending, surfaced, state };
}

const microtasks = () => new Promise((r) => setImmediate(r));

test('A: two completions deferred while busy both surface their bodies on resume', async () => {
  const { feed, surfaced, state } = makeHarness();
  state.busy = true;
  feed.scheduleExecutionPendingResumeKick('body A');
  feed.scheduleExecutionPendingResumeKick('body B');
  await microtasks();
  // Both kicks deferred while busy; nothing surfaced yet.
  assert.deepEqual(surfaced, []);

  // Turn settles normally -> busy false -> flush re-arms the kick.
  state.busy = false;
  feed.flushDeferredExecutionPendingResumeKick();
  assert.equal(surfaced.length, 1, 'a single merged resume entry surfaced');
  assert.match(surfaced[0], /body A/, 'first body preserved');
  assert.match(surfaced[0], /body B/, 'second body preserved (not dropped)');
});

test('B: deferred kick after a non-drain busy->false transition still fires', async () => {
  const { feed, surfaced, state } = makeHarness();
  state.busy = true;
  feed.scheduleExecutionPendingResumeKick('only body');
  await microtasks();
  assert.deepEqual(surfaced, [], 'deferred while busy');

  // Simulate watchdog force-release / stale-unwind: busy flips to false WITHOUT
  // drain-finally, then flushDeferred runs on that transition.
  state.busy = false;
  feed.flushDeferredExecutionPendingResumeKick();
  assert.deepEqual(surfaced, ['only body'], 'resume fired on the non-drain transition');

  // Idempotent: a second flush with nothing deferred is a no-op.
  feed.flushDeferredExecutionPendingResumeKick();
  assert.deepEqual(surfaced, ['only body']);
});
