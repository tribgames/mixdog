// createCapabilitiesApi over a fake client: the requests equal what main's lane sent for the same call, and the host
// intercepts (allow-all, sign-in, PC quota) fire where the IPC handler had them.
import assert from 'node:assert/strict';
import test from 'node:test';

import { routeCapability } from '../../shared/core-lanes/capability-route.ts';
import { createCapabilitiesApi } from './api-capabilities.ts';
import { createDirectContext } from './context.ts';
import { createRendererConnection } from './renderer-connection.ts';

function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    status: { state: 'ready' },
    store: { sections: () => [], section: () => undefined, appFeed: () => ({ epoch: 'e1' }), subscribe: () => () => undefined },
    async call(method, params) {
      calls.push({ method, params });
      return answer(method, params);
    },
    notify: () => undefined,
    subscribeApp: async () => undefined,
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: () => () => undefined,
    close: async () => undefined,
  };
}

async function setup({ role, answer = async (method) => (method === 'thread/read' ? { thread: { id: 's1' }, items: [] } : { ok: true }), hostOverrides = {} } = {}) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  // A server window's primary socket is `main` on the server's core; this PC's core names its other socket `server:<id>`.
  const ctx = {
    ...createDirectContext(connection),
    window: () => ({ role: 'main' }),
    pcClient: () => ({ server: { connection: { window: { role: role ?? 'main' } } } }),
  };
  const hostCalls = [];
  const host = {
    enableAllowAllActions: async () => (hostCalls.push(['enableAllowAllActions']), { value: 'settings' }),
    observeSignIn: (...a) => void hostCalls.push(['observeSignIn', ...a]),
    invokePcQuotaCapability: async (request) => (hostCalls.push(['pcInvoke', request.capability]), null),
    readPcQuotaCapabilities: async (requests) => requests.map(() => null),
    ...hostOverrides,
  };
  return { client, hostCalls, api: createCapabilitiesApi(ctx, { host }) };
}

test('invoke_sends_the_route_main_sent', async () => {
  const { client, api } = await setup();
  await api.invokeCapability({ capability: 'setModel', args: ['openai', 'gpt-x'], sessionId: 's1' });
  const expected = routeCapability('setModel', ['openai', 'gpt-x'], 's1');
  assert.deepEqual(client.calls[0], { method: expected.method, params: expected.params });
});

test('allow_all_actions_enable_goes_to_the_host_only', async () => {
  const { client, hostCalls, api } = await setup();
  const result = await api.invokeCapability({ capability: 'setDeveloperOption', args: ['allowAllActions', true] });
  assert.deepEqual(result, { value: 'settings' });
  assert.deepEqual(hostCalls, [['enableAllowAllActions']]);
  assert.equal(client.calls.length, 0, 'nothing is written by the window itself');
});

test('allow_all_actions_off_is_an_ordinary_call', async () => {
  const { client, hostCalls, api } = await setup();
  await api.invokeCapability({ capability: 'setDeveloperOption', args: ['allowAllActions', false], sessionId: 's1' });
  assert.deepEqual(hostCalls, []);
  assert.ok(client.calls.length > 0);
});

test('sign_in_capability_is_observed_by_the_host', async () => {
  const { hostCalls, api } = await setup();
  await api.invokeCapability({ capability: 'getMcpOAuthLoginStatus', args: ['flow1'], sessionId: 's1' });
  assert.equal(hostCalls[0][0], 'observeSignIn');
  assert.equal(hostCalls[0][1], 'getMcpOAuthLoginStatus');
  assert.deepEqual(hostCalls[0][2], ['flow1']);
});

test('lead_face_change_is_announced', async () => {
  const { client, api } = await setup();
  await api.invokeCapability({ capability: 'setBotOrder', args: [['a']], sessionId: 's1' });
  await new Promise((r) => setImmediate(r));
  assert.ok(client.calls.some((c) => c.method === 'ui/settings/announce' && c.params.scope === 'desktop'));
});

test('server_window_quota_is_answered_by_the_pc', async () => {
  const { client, api } = await setup({
    role: 'server:c1',
    hostOverrides: { invokePcQuotaCapability: async () => ({ value: { rows: [] } }) },
  });
  const result = await api.invokeCapability({ capability: 'getUsageDashboard', args: [] });
  assert.deepEqual(result, { value: { rows: [] } });
  assert.equal(client.calls.length, 0);
});

test('server_window_other_call_falls_through_to_the_core', async () => {
  const { client, hostCalls, api } = await setup({ role: 'server:c1' });
  await api.invokeCapability({ capability: 'setModel', args: ['openai', 'gpt-x'], sessionId: 's1' });
  assert.deepEqual(hostCalls, [['pcInvoke', 'setModel']]);
  assert.ok(client.calls.length > 0);
});

test('server_window_read_merges_positionally', async () => {
  const { client, api } = await setup({
    role: 'server:c1',
    answer: async () => ({ ok: true, value: 'core' }),
    hostOverrides: { readPcQuotaCapabilities: async (requests) => requests.map((r) => (r.capability === 'getUsageDashboard' ? { ok: true, value: 'pc' } : null)) },
  });
  const out = await api.readCapabilities([{ capability: 'getUsageDashboard' }, { capability: 'contextStatus', sessionId: 's1' }, { capability: 'getUsageDashboard' }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].value, 'pc');
  assert.equal(out[2].value, 'pc');
  assert.ok(client.calls.length > 0);
});

test('main_window_read_does_not_ask_the_host', async () => {
  const { hostCalls, api } = await setup({
    hostOverrides: { readPcQuotaCapabilities: async () => assert.fail('asked the host') },
  });
  await api.readCapabilities([{ capability: 'contextStatus', sessionId: 's1' }]).catch(() => undefined);
  assert.deepEqual(hostCalls, []);
});

test('failure_is_mapped_as_the_ipc_path_returned_it', async () => {
  const rpc = Object.assign(new Error('x'), { detail: { kind: 'rpc', code: -32602, data: { reason: 'invalidParams', path: 'p', expected: 'path must be a string' } } });
  const { api } = await setup({ answer: async () => { throw rpc; } });
  await assert.rejects(api.invokeCapability({ capability: 'setModel', args: ['a', 'b'], sessionId: 's1' }), TypeError);
});
