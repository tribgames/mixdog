import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisualizeHost } from '../host/visualize.ts';
import { createVisualizePublisher } from './visualize-publish.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a visualize change reaches the core only through the host role, as host/state/set{key:visualize}', async () => {
  const sent = [];
  const connection = {
    handleRequest() {},
    async request(method, params) {
      sent.push([method, params]);
      return {};
    },
  };
  const host = createVisualizeHost(
    connection,
    () => ({ execute: async () => ({}), snapshot: () => [] }),
    (error) => assert.fail(`unexpected snapshot failure: ${error}`)
  );
  const publish = createVisualizePublisher({
    host: () => host.publish,
    onFailure: (target, error) => assert.fail(`unexpected ${target} failure: ${error}`),
  });
  const event = { sessionId: 's1', state: { active: 't1', tabs: [{ id: 't1', panes: [] }] } };
  publish(event);
  await tick();
  assert.equal(sent.length, 1, 'one path, one request');
  assert.equal(sent[0][0], 'host/state/set');
  assert.deepEqual(sent[0][1], { key: 'visualize', value: event });
});

test('a failing host publish is reported, and a missing host role is skipped', async () => {
  const failures = [];
  const onFailure = (target, error) => failures.push([target, error.message]);
  createVisualizePublisher({ host: () => undefined, onFailure })({ sessionId: 'b' });
  createVisualizePublisher({
    host: () => async () => {
      throw new Error('not claimed');
    },
    onFailure,
  })({ sessionId: 'c' });
  await tick();
  // A missing host role is not a failure.
  assert.deepEqual(failures, [['host', 'not claimed']]);
});
