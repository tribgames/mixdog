import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRemoteTabSubscribers } from './remote-browser-tabs.ts';

function fixture() {
  const live = new Set(['one', 'two']);
  const sent = [];
  const requests = [];
  const subscribers = createBrowserRemoteTabSubscribers({
    isLive: (clientId) => live.has(clientId),
    send: async (clientId, payload) => {
      sent.push([clientId, payload]);
    },
    request: async (on) => {
      requests.push(on);
      return [{ id: 'main-browser-a', title: 'A', url: 'https://a.test/', loading: false }];
    },
  });
  return { live, sent, requests, subscribers };
}

test('pushes each change to every live watcher and stops the host watch after the last one leaves', async () => {
  const { live, sent, requests, subscribers } = fixture();
  const list = await subscribers.watch('one', true);
  assert.equal(list[0].id, 'main-browser-a');
  await subscribers.watch('two', true);
  subscribers.publish([]);
  assert.deepEqual(
    sent.map(([clientId, payload]) => [clientId, payload.event]),
    [
      ['one', 'browserRemoteTabs'],
      ['two', 'browserRemoteTabs'],
    ]
  );

  live.delete('two');
  subscribers.publish([]);
  assert.equal(sent.length, 3, 'a departed client is dropped, not sent to');
  assert.deepEqual(requests, [true, true]);

  await subscribers.watch('one', false);
  assert.deepEqual(requests, [true, true, false]);
  subscribers.publish([]);
  assert.equal(sent.length, 3);
});

test('a failed start leaves no watcher behind', async () => {
  const requests = [];
  const subscribers = createBrowserRemoteTabSubscribers({
    isLive: () => true,
    send: async () => {},
    request: async (on) => {
      requests.push(on);
      if (on) throw new Error('window unavailable');
      return [];
    },
  });
  await assert.rejects(subscribers.watch('one', true), /window unavailable/);
  assert.deepEqual(requests, [true, false]);
});
