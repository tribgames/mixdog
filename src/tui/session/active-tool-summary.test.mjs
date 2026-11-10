import assert from 'node:assert/strict';
import test from 'node:test';
import { createActiveToolTracker } from './active-tool-summary.mjs';

function createTracker() {
  let state = { activeToolSummary: null, activeTools: null };
  const patches = [];
  const tracker = createActiveToolTracker({
    getState: () => state,
    set: (patch) => {
      patches.push(patch);
      state = { ...state, ...patch };
    },
  });
  return { tracker, patches, getState: () => state };
}

test('surfaced categories publish counts with the earliest start per category', () => {
  const { tracker, getState } = createTracker();
  tracker.markToolCallActive('a', 'Shell', 2, 200);
  tracker.markToolCallActive('b', 'Shell', 1, 100);
  tracker.markToolCallActive('c', 'Agent', 0, 300);
  assert.equal(getState().activeToolSummary, '3:100:0:0:1:300');
  assert.deepEqual(getState().activeTools, {
    shell: { count: 3, startedAt: 100 },
    agent: { count: 1, startedAt: 300 },
  });
  tracker.markToolCallDone('a');
  tracker.markToolCallDone('c');
  assert.equal(getState().activeToolSummary, '1:100:0:0:0:0');
  tracker.markToolCallDone('b');
  assert.equal(getState().activeToolSummary, null);
  assert.equal(getState().activeTools, null);
});

test('non-surfaced categories and unknown keys never publish', () => {
  const { tracker, patches } = createTracker();
  tracker.markToolCallActive('x', 'read', 1, 1);
  tracker.markToolCallActive('', 'Shell', 1, 1);
  tracker.markToolCallDone('missing');
  assert.equal(patches.length, 0);
});

test('clearActiveToolSummary publishes only when something was surfaced', () => {
  const { tracker, patches, getState } = createTracker();
  tracker.clearActiveToolSummary();
  assert.equal(patches.length, 0);
  tracker.markToolCallActive('w', 'Web Research', 1, 50);
  assert.equal(getState().activeToolSummary, '0:0:1:50:0:0');
  tracker.clearActiveToolSummary();
  assert.equal(getState().activeToolSummary, null);
  // resetActiveToolCalls drops tracking without a publication (bulk swap).
  tracker.markToolCallActive('w', 'Web Research', 1, 50);
  const before = patches.length;
  tracker.resetActiveToolCalls();
  assert.equal(patches.length, before);
  tracker.markToolCallDone('w');
  assert.equal(patches.length, before);
});
