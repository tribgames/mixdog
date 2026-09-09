import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserCommandQueue } from './command-queue.ts';

test('a human picker keeps foreground automation paused beyond the idle interval without locking other pages', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const queue = createBrowserCommandQueue({
    chains: new Map(), pendingReads: new Map(), sessionId: command => command.session_id,
    backgroundEntryByPageId: () => null, readOnlyActions: new Set(),
    commandTimeoutMs: 1000, bounded: async work => work, run: async () => ({ text: 'ran' }),
  });
  const command = { session_id: 'owner', action: 'click' };
  const release = queue.holdLocal(command);
  now = 120_000;
  await assert.rejects(queue.executeSerialized(command), /local user input/);
  assert.equal((await queue.executeSerialized({ ...command, session_id: 'other' })).text, 'ran');
  release();
  release();
  now += 1001;
  assert.equal((await queue.executeSerialized(command)).text, 'ran');
});
