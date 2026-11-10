import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueueOps } from './queue.mjs';

for (const remembered of [false, true]) {
  test(`front requeue preserves notification deduplication and key order (remembered=${remembered})`, () => {
    const pending = [
      { id: 'pending-event', mode: 'task-notification', key: 'pending', text: 'Already queued' },
      { id: 'old-prompt', mode: 'prompt', text: 'Older prompt' },
    ];
    const state = { queued: [pending[1]] };
    const pendingNotificationKeys = new Set(remembered ? ['restored', 'pending'] : ['pending']);
    const queue = createQueueOps(
      {
        pending,
        pendingNotificationKeys,
        getState: () => state,
        set: (patch) => Object.assign(state, patch),
      },
      {
        kickDrain: () => assert.fail('requeue must not start a drain'),
      }
    );
    const duplicate = { id: 'duplicate', mode: 'task-notification', key: 'pending', text: 'Duplicate' };

    assert.equal(
      queue.requeueEntriesFront([
        null,
        { mode: 'task-notification', key: 'empty', text: ' \n ' },
        duplicate,
        {
          id: 'restored-event',
          mode: 'task-notification',
          key: 'restored',
          text: 'Restored notification',
          displayText: 'Existing display text',
        },
        { id: 'new-prompt', mode: 'prompt', text: 'New prompt' },
      ]),
      true
    );
    assert.deepEqual(
      pending.map((entry) => entry.id),
      ['restored-event', 'new-prompt', 'pending-event', 'old-prompt']
    );
    assert.deepEqual(
      state.queued.map((entry) => entry.id),
      ['new-prompt', 'old-prompt']
    );
    assert.equal(pending[0].displayText, 'Existing display text');
    assert.deepEqual([...pendingNotificationKeys], remembered ? ['restored', 'pending'] : ['pending', 'restored']);

    const queued = state.queued;
    assert.equal(queue.requeueEntriesFront([duplicate]), false);
    assert.equal(state.queued, queued);
    assert.equal(pending.length, 4);
    assert.deepEqual([...pendingNotificationKeys], remembered ? ['restored', 'pending'] : ['pending', 'restored']);
  });
}
