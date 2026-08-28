import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgePendingDeferredToolDelta,
  mergePendingDeferredToolDelta,
  snapshotPendingDeferredToolDelta,
} from './deferred-tool-delta.mjs';

test('deferred tool delta coalesces inverse changes before delivery', () => {
  const session = {};
  mergePendingDeferredToolDelta(session, {
    added: [{ name: 'mcp__demo__one', description: ' First <tool>  ' }],
  });
  mergePendingDeferredToolDelta(session, {
    added: [{ name: 'mcp__demo__two', description: 'Second tool' }],
    removed: ['mcp__demo__one'],
  });

  const snapshot = snapshotPendingDeferredToolDelta(session);
  assert.deepEqual(snapshot.added, [{
    name: 'mcp__demo__two',
    description: 'Second tool',
  }]);
  assert.deepEqual(snapshot.removed, []);
  assert.match(snapshot.content, /<deferred_tools_delta>/);
  assert.match(snapshot.content, /mcp__demo__two: Second tool/);
  assert.doesNotMatch(snapshot.content, /mcp__demo__one/);
});

test('deferred tool delta clears only after matching provider-accepted revision', () => {
  const session = {};
  mergePendingDeferredToolDelta(session, { removed: ['mcp__demo__gone'] });
  const snapshot = snapshotPendingDeferredToolDelta(session);

  assert.equal(acknowledgePendingDeferredToolDelta(session, snapshot.revision + 1), false);
  assert.ok(session.pendingDeferredToolDelta);
  assert.equal(acknowledgePendingDeferredToolDelta(session, snapshot.revision), true);
  assert.equal(snapshotPendingDeferredToolDelta(session), null);
});
