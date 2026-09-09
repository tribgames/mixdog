import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageClient } from './browser-page-client.ts';

test('a failed press survives its release and older queued successes until a new deliberate input succeeds', async () => {
  const failures = [];
  const recoveries = [];
  const sent = [];
  const client = createBrowserPageClient({
    sessionId: 's', update() {},
    failure: error => failures.push(error),
    recovered: () => recoveries.push('recovered'),
    api: {
      browserPageFrame: async () => ({ documentId: 'p1:1', frameId: 'f1' }),
      browserPageControl: async (_session, action) => {
        sent.push(action);
        if (action.phase === 'mousePressed') throw new Error('click rejected');
      },
    },
  });
  await client.poll();
  const pointer = { type: 'pointer', button: 'left', buttons: 1, x: 10, y: 10 };
  const press = client.control({ ...pointer, phase: 'mousePressed' });
  const queued = client.control({ type: 'text', text: 'already queued' });
  await assert.rejects(press, /click rejected/);
  await queued;
  await client.control({ ...pointer, phase: 'mouseReleased', buttons: 0 });
  assert.deepEqual(failures, ['click rejected']);
  assert.deepEqual(recoveries, []);
  await client.control({ type: 'text', text: 'fresh input' });
  assert.deepEqual(recoveries, ['recovered']);
  assert.equal(sent.filter(action => action.phase === 'mousePressed').length, 1);
  client.dispose();
});
