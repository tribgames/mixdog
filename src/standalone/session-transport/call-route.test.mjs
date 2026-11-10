import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallLanes } from './call-lanes.mjs';
import { createCallRoute } from './call-route.mjs';

test('a /call reports its start before dispatch and its settle after the answer, success or failure', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const lanes = createCallLanes();
  const route = createCallRoute({
    handleCall: async (name) => {
      events.push(`run:${name}`);
      if (name === 'fail') throw new Error('boom');
      await gate;
      return 'ok';
    },
    clients: new Map([['tok', { leadPid: 0 }]]),
    lanes,
    callCache: { get: () => null, track() {} },
    nowMs: () => 1,
    onCallStarted: (token) => events.push(`start:${token}`),
    onCallSettled: (token) => events.push(`settle:${token}`),
  });
  const res = () => ({ writeHead() {}, end: (body) => events.push(`sent:${JSON.parse(body).result ?? 'error'}`) });
  const pending = route({ token: 'tok', name: 'slow' }, res());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start:tok', 'run:slow']);
  release();
  await pending;
  await route({ token: 'tok', name: 'fail' }, res());
  assert.deepEqual(events, [
    'start:tok',
    'run:slow',
    'sent:ok',
    'settle:tok',
    'start:tok',
    'run:fail',
    'sent:error',
    'settle:tok',
  ]);
  lanes.close('test end');
});
