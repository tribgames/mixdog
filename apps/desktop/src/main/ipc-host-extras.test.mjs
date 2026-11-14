import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_EXTRAS_IPC, registerHostExtrasIpc } from './ipc-host-extras.ts';

function setup({ confirm = true, pc = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const observed = [];
  const service = (name) => ({
    invokeCapability: async (capability, args, sessionId) => {
      calls.push([name, capability, args, sessionId]);
      return { value: { rows: [{ id: 'anthropic-oauth' }, { id: 'xai' }] } };
    },
    readCapabilities: async (requests) => requests.map((r) => ({ ok: true, value: { rows: [{ id: 'xai' }, { id: 'openai-oauth' }], c: r.capability } })),
  });
  const off = registerHostExtrasIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    host: service('main'),
    pcHost: pc ? { ...service('pc'), isProviderAllowed: (p) => p !== 'xai' } : undefined,
    confirmAllowAllActions: async () => confirm,
    signInFocus: { observe: (...a) => observed.push(a) },
  });
  return { handlers, calls, observed, off };
}

test('confirm_no_keeps_off', async () => {
  const t = setup({ confirm: false });
  await t.handlers.get(HOST_EXTRAS_IPC.enableAllowAllActions)({});
  assert.deepEqual(t.calls.map((c) => c[1]), ['getDeveloperSettings']);
});

test('confirm_yes_writes_on_main_connection', async () => {
  const t = setup({ confirm: true });
  await t.handlers.get(HOST_EXTRAS_IPC.enableAllowAllActions)({});
  assert.deepEqual(t.calls.map((c) => [c[0], c[1], c[2]]), [
    ['main', 'setDeveloperOption', ['allowAllActions', true]],
    ['main', 'getDeveloperSettings', []],
  ]);
  t.off();
  assert.equal(t.handlers.size, 0);
});

test('pc_quota_constrained', async () => {
  const t = setup();
  const invoked = await t.handlers.get(HOST_EXTRAS_IPC.pcQuotaInvoke)({}, { capability: 'getUsageDashboard' });
  assert.deepEqual(invoked.value.rows, [{ id: 'anthropic-oauth' }]);
  assert.equal(await t.handlers.get(HOST_EXTRAS_IPC.pcQuotaInvoke)({}, { capability: 'getUsageDashboard', sessionId: 's1' }), null);
  const read = await t.handlers.get(HOST_EXTRAS_IPC.pcQuotaRead)({}, [{ capability: 'getLeadStatus' }, { capability: 'getUsageDashboard' }]);
  assert.equal(read[0], null);
  assert.deepEqual(read[1].value.rows, [{ id: 'openai-oauth' }]);
  const none = setup({ pc: false });
  assert.equal(await none.handlers.get(HOST_EXTRAS_IPC.pcQuotaInvoke)({}, { capability: 'getUsageDashboard' }), null);
});

test('observe_sign_in_feeds_focus', async () => {
  const t = setup();
  await t.handlers.get(HOST_EXTRAS_IPC.observeSignIn)({}, { capability: 'getMcpOAuthLoginStatus', args: ['f1'] }, { state: 'done' });
  assert.deepEqual(t.observed, [['getMcpOAuthLoginStatus', ['f1'], { state: 'done' }]]);
});
