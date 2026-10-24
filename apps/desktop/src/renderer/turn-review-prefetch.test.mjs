import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { TurnReviewBar } from './TurnReview';
import { installReviewDom } from './turn-review-test-support.mjs';
import { prefetchTurnReview } from './turn-review-prefetch';

const prompt = { kind: 'user', id: 'prompt', text: 'Change a file' };
const edit = { kind: 'tool', id: 'edit', name: 'apply_patch', args: {}, result: 'Updated a.txt' };
const items = [prompt, edit];
const reply = {
  value: {
    supported: true,
    authoritative: true,
    snapshotKind: 'worktree',
    patch: '',
    files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
    agents: [],
  },
};

function mount(t) {
  const calls = [];
  const settle = [];
  const { root } = installReviewDom(t, {
    desktop: {
      invokeCapability(request) {
        calls.push(request);
        return new Promise((resolve, reject) => settle.push({ resolve, reject }));
      },
    },
  });
  const entryReads = () => calls.filter((call) => call.args[0].refresh === false);
  return { root, calls, settle, entryReads };
}

test('the island entry read takes the answer of the prefetch in flight: one entry call', async (t) => {
  const { root, calls, settle, entryReads } = mount(t);
  prefetchTurnReview('sess-share', items);
  assert.equal(entryReads().length, 1, 'the open intent asked');
  await act(async () =>
    root.render(React.createElement(TurnReviewBar, { items, sessionId: 'sess-share', active: true, busy: false }))
  );
  assert.equal(entryReads().length, 1, 'the mounted island did not ask a second time');
  await act(async () => settle[0].resolve(reply));
  assert.equal(entryReads().length, 1, 'the answer settled the entry without another entry call');
  assert.ok(document.querySelector('.turn-review-bar'), 'the bar shows the shared answer');
  // The worktree refresh the island always follows with is its own request.
  assert.equal(calls.filter((call) => call.args[0].refresh === true).length, 1);
});

test('a prefetch that failed leaves the island to ask for its own entry read', async (t) => {
  const { root, settle, entryReads } = mount(t);
  prefetchTurnReview('sess-share-failed', items);
  await act(async () =>
    root.render(
      React.createElement(TurnReviewBar, { items, sessionId: 'sess-share-failed', active: true, busy: false })
    )
  );
  assert.equal(entryReads().length, 1);
  await act(async () => settle[0].reject(new Error('offline')));
  assert.equal(entryReads().length, 2, 'the island asked after the prefetch failed');
});
