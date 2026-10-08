import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionIntegrationsApi } from './integrations.mjs';
import { SESSION_CONFIGURE_ACTIONS } from '../../../standalone/session-protocol.mjs';

test('desktop session custom-provider capabilities delegate inputs and results without exposing keys', async () => {
  const id = 'custom-84a2a4a1-30f6-43de-8813-c215de6046b6';
  const input = { name: 'Hive', protocol: 'openai-chat', baseURL: 'https://api-cdn.thehive.ai/api/v3', apiKey: 'private-test-key', models: [{ id: 'vendor/model' }] };
  const replies = {
    saveCustomProvider: { id, name: input.name },
    removeCustomProvider: { provider: id, removed: true },
    testCustomProvider: { ok: true },
    discoverCustomProviderModels: { models: input.models },
  };
  const calls = [];
  const notices = [];
  const states = [];
  let refreshes = 0;
  const runtime = Object.fromEntries(Object.entries(replies).map(([method, result]) => [
    method, async (value) => { calls.push([method, value]); return result; },
  ]));
  const session = createSessionIntegrationsApi({
    runtime,
    getState: () => ({ stats: {} }),
    set: (state) => states.push(state),
    pushNotice: (message) => notices.push(message),
    routeState: () => ({ provider: '', model: '' }),
    resetStatsAndSyncContext: () => { refreshes += 1; },
  }, { oauthFlows: new Map() });
  for (const [method, result] of Object.entries(replies)) {
    assert.ok(SESSION_CONFIGURE_ACTIONS.includes(method));
    const value = method === 'removeCustomProvider' ? id : input;
    assert.equal(await session[method](value), result);
    assert.deepEqual(calls.at(-1), [method, value]);
  }
  assert.equal(refreshes, 1);
  assert.deepEqual(states.at(-1), { provider: '', model: '', stats: {} });
  assert.equal(notices.length, 2);
  assert.equal(JSON.stringify(notices).includes(input.apiKey), false);
  runtime.saveCustomProvider = async () => { throw new Error('save failed'); };
  await assert.rejects(session.saveCustomProvider(input), /save failed/);
  assert.equal(notices.length, 2);
});
