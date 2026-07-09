// Regression: consolidated completion dedup on the delivered-completions
// registry (src/tui/engine/agent-job-feed.mjs execution-ui branch).
//
// Symptom guarded: after a turn completes and the lead goes IDLE, a duplicate
// execution completion (SAME execution_id, slightly different composite
// status/body key) must NOT re-enqueue a model-visible twin — otherwise
// post-turn drain() spawns a fresh turn. A genuinely-new completion (different
// execution_id) must still enqueue so the lead wakes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentJobFeed } from '../src/tui/engine/agent-job-feed.mjs';
import {
  _clearDeliveredCompletions,
} from '../src/runtime/agent/orchestrator/session/manager/delivered-completions.mjs';

const completionText = 'Async agent task task_1 completed finished.\n\nResult:\n> ok';
const completionMeta = { type: 'agent_task_result', execution_id: 'task_1', status: 'completed' };

function makeHarness() {
  const enqueued = [];       // captured enqueue entries (spy)
  const pending = [];        // real queue depth proxy
  let enqueueCalls = 0;      // spy call-count
  let handler = null;
  const state = { busy: false };
  const feed = createAgentJobFeed({
    runtime: { onNotification: (fn) => { handler = fn; return () => {}; } },
    getState: () => state,
    set: () => {},
    nextId: () => 'id',
    getDisposed: () => false,
    patchItem: () => {},
    enqueue: (body, opts) => {
      enqueueCalls += 1;
      enqueued.push({ body, opts });
      pending.push({ body, opts });
      return true;
    },
    drain: () => Promise.resolve(),
    pushUserOrSyntheticItem: () => {},
    makeQueueEntry: (text, opts = {}) => ({ text, ...opts }),
    getPending: () => pending,
    agentStatusState: () => ({}),
    displayedExecutionNotificationKeys: new Set(),
    pushNotice: () => {},
  });
  feed.subscribeRuntimeNotifications();
  return { enqueued, pending, enqueueCalls: () => enqueueCalls, deliver: (event) => handler(event) };
}

test('re-arriving delivered completion (same execution_id) does NOT enqueue a new turn', () => {
  _clearDeliveredCompletions();
  const { enqueueCalls, pending, deliver } = makeHarness();

  // First arrival: brand-new completion → enqueued + ACKed.
  const first = { content: completionText, meta: completionMeta };
  deliver(first);
  assert.equal(enqueueCalls(), 1, 'new completion enqueues the model-visible twin');
  assert.equal(pending.length, 1, 'one pending entry queued');
  assert.equal(first.modelVisibleDelivered, true, 'first delivery ACKs runtime-core mirror suppression');

  // Duplicate: SAME execution_id, different composite key (meta.type differs →
  // different notificationQueueKey AND a different model-visible text hash), but
  // still a persistable terminal completion. Dedup must recognize it purely via
  // the execution_id registry key, not the status/body-derived composite.
  const dup = { content: completionText, meta: { ...completionMeta, type: 'background_task_result' } };
  deliver(dup);
  // END-TO-END proxy for "no idle refire": the handler returned with NO new
  // enqueue call and NO new pending entry, so post-turn drain has nothing new to
  // fire — yet the ack is still set so runtime-core never mirrors it either.
  assert.equal(enqueueCalls(), 1, 'already-delivered completion triggers NO new enqueue (no idle refire)');
  assert.equal(pending.length, 1, 'queue depth stable — dup pushed no new pending entry');
  assert.equal(dup.modelVisibleDelivered, true, 'duplicate still ACKs so mirror/fallback stays suppressed');
});

test('genuinely-new completion (different execution_id) still enqueues + wakes the lead', () => {
  _clearDeliveredCompletions();
  const { enqueueCalls, deliver } = makeHarness();

  deliver({ content: completionText, meta: completionMeta });
  const secondText = 'Async agent task task_2 completed finished.\n\nResult:\n> done';
  deliver({ content: secondText, meta: { type: 'agent_task_result', execution_id: 'task_2', status: 'completed' } });
  assert.equal(enqueueCalls(), 2, 'a new execution_id triggers exactly one new enqueue (lead wakeup preserved)');
});

// CARD dedup regression: the transcript-card first-delivery guard keys on a
// stable execution_id-based key (executionCardKey → card:<id>:<hasBody>), NOT
// the full composite notificationKey. A duplicate completion re-arriving with a
// different type/status (same execution_id, same hasBody) must push ONE card;
// a bodyless preview (b0) followed by the real result (b1) must still push TWO.
function makeCardHarness() {
  let handler = null;
  let cardPushes = 0;
  const feed = createAgentJobFeed({
    runtime: { onNotification: (fn) => { handler = fn; return () => {}; } },
    getState: () => ({ busy: false }),
    set: () => {},
    nextId: () => 'id',
    getDisposed: () => false,
    patchItem: () => {},
    enqueue: () => true,
    drain: () => Promise.resolve(),
    pushUserOrSyntheticItem: () => { cardPushes += 1; },
    makeQueueEntry: (text, opts = {}) => ({ text, ...opts }),
    getPending: () => [],
    agentStatusState: () => ({}),
    displayedExecutionNotificationKeys: new Set(),
    pushNotice: () => {},
  });
  feed.subscribeRuntimeNotifications();
  return { cardPushes: () => cardPushes, deliver: (event) => handler(event) };
}

test('duplicate completion (same execution_id, differing type/status) pushes ONE card', () => {
  _clearDeliveredCompletions();
  const { cardPushes, deliver } = makeCardHarness();

  deliver({ content: completionText, meta: completionMeta });
  assert.equal(cardPushes(), 1, 'first completion pushes a card');

  deliver({ content: completionText, meta: { ...completionMeta, type: 'background_task_result', status: 'finished' } });
  assert.equal(cardPushes(), 1, 'dup with differing type/status pushes NO second card (execution_id card key)');
});

test('bodyless preview (b0) then real result (b1), same execution_id, pushes TWO cards', () => {
  _clearDeliveredCompletions();
  const { cardPushes, deliver } = makeCardHarness();

  // Bodyless preview: header-only, no blank-line-separated result body → b0.
  deliver({ content: 'Async agent task task_9 completed finished.', meta: { type: 'agent_task_result', execution_id: 'task_9', status: 'completed' } });
  assert.equal(cardPushes(), 1, 'preview pushes a card');

  // Real result: carries a body after a blank line → b1 (upgrade preserved).
  deliver({ content: 'Async agent task task_9 completed finished.\n\nResult:\n> ok', meta: { type: 'agent_task_result', execution_id: 'task_9', status: 'completed' } });
  assert.equal(cardPushes(), 2, 'result body (b1) pushes a second card — preview→result upgrade intact');
});
