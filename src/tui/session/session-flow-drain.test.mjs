import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionFlow } from './session-flow.mjs';

const tick = () => new Promise(setImmediate);

const COMPLETION = '<task-notification><task-id>task_agent_1</task-id><status>completed</status></task-notification>';

function fixture({ busy = true } = {}) {
  const state = { busy, commandBusy: false, queued: [] };
  const pending = [];
  const turns = [];
  const items = [];
  let nextId = 0;
  const bag = {
    runtime: { id: 'session-drain-recheck' },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `queued-${++nextId}`,
    tuiDebug() {},
    pushUserOrSyntheticItem: (text, id, kind) => items.push({ text, id, kind }),
    flushDeferredExecutionPendingResumeKick() {},
    runTurn: async (content, options) => {
      turns.push({ content, options });
      return 'done';
    },
  };
  return { state, pending, turns, items, flow: createSessionFlow(bag) };
}

test('a completion queued during a turn drains even when no release edge reaches the queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();

  assert.equal(f.flow.enqueue(COMPLETION, { mode: 'task-notification', priority: 'next', key: 'exec-1' }), true);
  await tick();
  assert.deepEqual(f.turns, [], 'the active turn owns the session');

  t.mock.timers.tick(10_000);
  await tick();
  assert.deepEqual(f.turns, [], 'the re-check never starts a second turn while one runs');

  // The turn settles without its busy release reaching this flow — the
  // one-shot edge the queue used to depend on.
  f.state.busy = false;
  t.mock.timers.tick(2_000);
  await tick();
  assert.equal(f.turns.length, 1);
  assert.equal(String(f.turns[0].content).includes('task_agent_1'), true);
  assert.deepEqual(f.items, [{ text: f.items[0]?.text, id: 'queued-1', kind: 'injected' }]);
  assert.deepEqual(f.pending, []);

  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(f.turns.length, 1, 'an empty queue stops the re-check');
});
