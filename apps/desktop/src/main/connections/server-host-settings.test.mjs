import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerHostSettings } from './server-host-settings.ts';

const core = (list) => ({ call: async (method) => (method === 'connections/ssh/list' ? list() : undefined) });

test('a server with no saved limits may use every provider and runs on this PC sign-ins', async () => {
  const settings = createServerHostSettings(core(() => [{ id: 'a', name: 'A', target: 'a', lastConnectedAt: null, open: false }]));
  await settings.refresh();
  assert.deepEqual(settings.modelAccess('a'), { serverLogin: false, allowedProviders: null });
  assert.deepEqual(settings.modelAccess('unknown'), { serverLogin: false, allowedProviders: null });
});

test('the saved model login and provider list are what the window reads', async () => {
  const hosts = [
    { id: 'a', name: 'A', target: 'a', lastConnectedAt: 1, open: true, settings: { modelLogin: 'server', allowedProviders: ['openai-oauth'] } },
    { id: 'b', name: 'B', target: 'b', lastConnectedAt: null, open: false, settings: { allowedProviders: [] } },
  ];
  const settings = createServerHostSettings(core(() => hosts));
  await settings.refresh();
  assert.deepEqual(settings.modelAccess('a'), { serverLogin: true, allowedProviders: ['openai-oauth'] });
  assert.deepEqual(settings.modelAccess('b'), { serverLogin: false, allowedProviders: [] });
});

test('an answer that is no list keeps the last list read, and a failed read is the error of the refresh', async () => {
  let answer = [{ id: 'a', name: 'A', target: 'a', lastConnectedAt: null, open: false, settings: { modelLogin: 'server' } }];
  const settings = createServerHostSettings(core(() => answer));
  await settings.refresh();
  answer = null;
  await settings.refresh();
  assert.equal(settings.modelAccess('a').serverLogin, true);
  const failing = createServerHostSettings({
    call: async () => {
      throw new Error('gone');
    },
  });
  await assert.rejects(failing.refresh(), /gone/);
});
