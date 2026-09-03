import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserCommandQueue } from './command-queue.ts';

test('queued Browser Use commands release immediately when cancelled before dispatch', async () => {
  let releasePrevious;
  const previous = new Promise((resolve) => {
    releasePrevious = resolve;
  });
  const chains = new Map([['foreground', previous]]);
  let dispatches = 0;
  const queue = createBrowserCommandQueue({
    chains,
    pendingReads: new Map(),
    backgroundEntryByPageId: () => null,
    run: async () => {
      dispatches += 1;
      return { text: 'unexpected' };
    },
    bounded: async (operation) => await operation,
    readOnlyActions: new Set(),
    commandTimeoutMs: 45_000,
  });
  const controller = new AbortController();
  const pending = queue.executeSerialized({ action: 'open' }, controller.signal);
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
  assert.equal(dispatches, 0);
  const next = queue.executeSerialized({ action: 'open' });
  await Promise.resolve();
  assert.equal(dispatches, 0);
  releasePrevious();
  await next;
  assert.equal(dispatches, 1);
});
