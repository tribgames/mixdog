import assert from 'node:assert/strict';
import test from 'node:test';

import { createChannelSessionRouter } from './channel-session-router.mjs';

test('channel inbound submits directly to its pinned session without a UI client', async () => {
  const calls = [];
  const route = createChannelSessionRouter({
    getSessionId: () => 'sess_linked',
    getSessionService: () => ({
      async submitSession(args) {
        calls.push(args);
      },
    }),
  });

  assert.equal(
    route('notifications/claude/channel', {
      content: 'channel inbound',
      meta: { instruction: 'answer channel inbound' },
    }),
    true
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    {
      sessionId: 'sess_linked',
      prompt: 'answer channel inbound',
      options: { source: 'channel', mode: 'task-notification', origin: 'channel' },
    },
  ]);
});

test('channel router consumes only channel inbound notifications', () => {
  let calls = 0;
  const route = createChannelSessionRouter({
    getSessionId: () => 'sess_linked',
    getSessionService: () => ({
      submitSession() {
        calls += 1;
      },
    }),
  });
  assert.equal(route('notifications/mixdog/remote', { state: 'acquired' }), false);
  assert.equal(calls, 0);
});
