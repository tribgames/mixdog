import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisualizeHost } from '../host/visualize.ts';
import { createVisualizePublisher } from './visualize-publish.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a visualize change reaches Node and the core as host/state/set{section:visualize}', async () => {
  const sent = [];
  const connection = {
    handleRequest() {},
    async request(method, params) {
      sent.push([method, params]);
      return {};
    },
  };
  const host = createVisualizeHost(connection, () => ({ execute: async () => ({}), snapshot: () => [] }));
  const toNode = [];
  const publish = createVisualizePublisher({
    node: async (event) => void toNode.push(event),
    host: () => host.publish,
    onFailure: (target, error) => assert.fail(`unexpected ${target} failure: ${error}`),
  });
  const event = { sessionId: 's1', state: { tabs: [{ id: 't1' }] } };
  publish(event);
  await tick();
  assert.deepEqual(toNode, [event]);
  assert.deepEqual(sent, [['host/state/set', { section: 'visualize', value: event }]]);
});

test('a failing consumer does not stop the other, and a missing host role is skipped', async () => {
  const seen = [];
  const failures = [];
  const onFailure = (target, error) => failures.push([target, error.message]);
  const failingNode = createVisualizePublisher({
    node: async () => {
      throw new Error('daemon down');
    },
    host: () => async (event) => void seen.push(event),
    onFailure,
  });
  failingNode({ sessionId: 'a' });
  const noHost = createVisualizePublisher({
    node: async (event) => void seen.push(event),
    host: () => undefined,
    onFailure,
  });
  noHost({ sessionId: 'b' });
  const failingHost = createVisualizePublisher({
    node: async (event) => void seen.push(event),
    host: () => async () => {
      throw new Error('not claimed');
    },
    onFailure,
  });
  failingHost({ sessionId: 'c' });
  await tick();
  assert.deepEqual(seen, [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]);
  // Each failure is reported with the consumer it came from; a missing host role is not a failure.
  assert.deepEqual(failures, [
    ['node', 'daemon down'],
    ['host', 'not claimed'],
  ]);
});
