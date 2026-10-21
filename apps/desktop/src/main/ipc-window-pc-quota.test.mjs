import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerWindowSettingsIpc } from './ipc-window-settings.ts';

function setup(withPc) {
  const handlers = new Map();
  const calls = [];
  const service = (name) => ({
    invokeCapability: async (capability, args, sessionId) => {
      calls.push([name, 'invoke', capability, sessionId]);
      return { value: `${name}:${capability}` };
    },
    readCapabilities: async (requests) =>
      requests.map((request) => {
        calls.push([name, 'read', request.capability]);
        return { ok: true, value: `${name}:${request.capability}` };
      }),
    getSnapshot: () => ({}),
  });
  registerWindowSettingsIpc({
    window: { webContents: { setZoomFactor() {}, send() {} }, setTitleBarOverlay() {} },
    app: {},
    host: service('server'),
    ...(withPc ? { pcHost: service('pc') } : {}),
    handle: (channel, handler) => handlers.set(channel, handler),
    invokeDesktopOperation: async () => undefined,
    readsLocalOnboardingStatus: false,
  });
  return { handlers, calls };
}

test('a server window reads provider quota from this PC, everything else from the server', async () => {
  const { handlers, calls } = setup(true);
  const read = await handlers.get(DESKTOP_IPC.readCapabilities)({}, [
    { capability: 'getLeadStatus' },
    { capability: 'getUsageDashboard', args: [{}] },
    { capability: 'getQuotaHistory' },
    { capability: 'getUsageStats' },
  ]);
  assert.deepEqual(
    read.map((entry) => entry.value),
    ['server:getLeadStatus', 'pc:getUsageDashboard', 'pc:getQuotaHistory', 'server:getUsageStats']
  );
  const invoked = await handlers.get(DESKTOP_IPC.invokeCapability)({}, { capability: 'getUsageDashboard' });
  assert.equal(invoked.value, 'pc:getUsageDashboard');
  // A session-addressed call stays with the session's own server.
  const scoped = await handlers.get(DESKTOP_IPC.invokeCapability)(
    {},
    { capability: 'getUsageDashboard', sessionId: 's1' }
  );
  assert.equal(scoped.value, 'server:getUsageDashboard');
  assert.ok(calls.length >= 6);
});

// Connection kinds: the desktop has `local` (no pcHost: its own sign-ins) and
// `ssh` (daemon in model-proxy client mode: no credentials of its own, every
// model call on this PC's sign-in, filtered by the host's provider list).
// Phones, browsers and another PC's window are not Electron connections here;
// they reach a host's own daemon through remote-methods and its own accounts.
test('a server window shows only the providers its proxy lets the server use', async () => {
  const handlers = new Map();
  const pc = {
    isProviderAllowed: (provider) => provider !== 'xai',
    invokeCapability: async (capability, args) => ({
      value: { rows: [{ id: 'anthropic-oauth' }, { id: 'xai' }], total: {}, capability, args },
    }),
    readCapabilities: async (requests) =>
      requests.map(() => ({ ok: true, value: { rows: [{ id: 'xai' }, { id: 'openai-oauth' }] } })),
  };
  const server = {
    invokeCapability: async (capability) => ({ value: `server:${capability}` }),
    readCapabilities: async (requests) => requests.map((r) => ({ ok: true, value: `server:${r.capability}` })),
    getSnapshot: () => ({}),
  };
  registerWindowSettingsIpc({
    window: { webContents: { setZoomFactor() {}, send() {} }, setTitleBarOverlay() {} },
    app: {},
    host: server,
    pcHost: pc,
    handle: (channel, handler) => handlers.set(channel, handler),
    invokeDesktopOperation: async () => undefined,
    readsLocalOnboardingStatus: false,
  });
  const invoke = handlers.get(DESKTOP_IPC.invokeCapability);
  const read = handlers.get(DESKTOP_IPC.readCapabilities);
  assert.deepEqual((await invoke({}, { capability: 'getUsageDashboard' })).value.rows, [{ id: 'anthropic-oauth' }]);
  assert.deepEqual((await read({}, [{ capability: 'getUsageDashboard' }]))[0].value.rows, [{ id: 'openai-oauth' }]);
  // A history read naming a provider the server cannot use stays on the server.
  assert.equal(
    (await invoke({}, { capability: 'getQuotaHistory', args: [{ provider: 'xai' }] })).value,
    'server:getQuotaHistory'
  );
  assert.notEqual(
    (await invoke({}, { capability: 'getQuotaHistory', args: [{ provider: 'anthropic-oauth' }] })).value,
    'server:getQuotaHistory'
  );
});

// A fake PC ledger mirroring pickSelection: the asked provider when recorded,
// else the most recently moved subscription (series[0]).
function historyWindow(series, allowed) {
  const calls = [];
  const subscriptions = series.map((provider) => ({ provider, account: 'a', windows: ['7D'] }));
  const pc = {
    isProviderAllowed: allowed,
    invokeCapability: async (capability, args) => {
      calls.push([capability, args]);
      if (capability === 'consumeCodexRateLimitResetCredit') {
        return { value: { ok: true, dashboard: { rows: [{ id: 'xai' }, { id: 'openai-oauth' }] } } };
      }
      const question = args?.[0] ?? {};
      const entry = subscriptions.find((row) => row.provider === question.provider) ?? subscriptions[0];
      if (!entry) return { value: { generatedAt: 1, subscriptions: [], selection: null } };
      const selection = { provider: entry.provider, account: entry.account, label: '7D' };
      return question.page != null
        ? { value: { generatedAt: 1, selection, windows: [{ id: 1 }], total: 1 } }
        : { value: { generatedAt: 1, subscriptions, selection } };
    },
    readCapabilities: async (requests) =>
      Promise.all(requests.map((r) => pc.invokeCapability(r.capability, r.args).then((x) => ({ ok: true, ...x })))),
  };
  const handlers = new Map();
  registerWindowSettingsIpc({
    window: { webContents: { setZoomFactor() {}, send() {} }, setTitleBarOverlay() {} },
    app: {},
    host: {
      invokeCapability: async (capability) => ({ value: `server:${capability}` }),
      readCapabilities: async (requests) => requests.map((r) => ({ ok: true, value: `server:${r.capability}` })),
      getSnapshot: () => ({}),
    },
    pcHost: pc,
    handle: (channel, handler) => handlers.set(channel, handler),
    invokeDesktopOperation: async () => undefined,
    readsLocalOnboardingStatus: false,
  });
  return {
    calls,
    invoke: (input) => handlers.get(DESKTOP_IPC.invokeCapability)({}, input),
    read: (input) => handlers.get(DESKTOP_IPC.readCapabilities)({}, input),
  };
}
const notXai = (provider) => provider !== 'xai';
const providersOf = (value) => value.subscriptions.map((row) => row.provider);

test('quota history without a provider opens on an allowed one and lists only allowed subscriptions', async () => {
  const { invoke, read, calls } = historyWindow(['xai', 'anthropic-oauth', 'openai-oauth'], notXai);
  const answer = (await invoke({ capability: 'getQuotaHistory', args: [{}] })).value;
  assert.equal(answer.selection.provider, 'anthropic-oauth');
  assert.deepEqual(providersOf(answer), ['anthropic-oauth', 'openai-oauth']);
  assert.equal(calls.at(-1)[1][0].provider, 'anthropic-oauth');
  // Batched reads take the same path.
  const [batched] = await read([{ capability: 'getQuotaHistory', args: [{}] }]);
  assert.equal(batched.value.selection.provider, 'anthropic-oauth');
  assert.deepEqual(providersOf(batched.value), ['anthropic-oauth', 'openai-oauth']);
});

test('quota history with an allowed provider hides disallowed subscription metadata', async () => {
  const { invoke, calls } = historyWindow(['xai', 'anthropic-oauth'], notXai);
  const answer = (await invoke({ capability: 'getQuotaHistory', args: [{ provider: 'anthropic-oauth' }] })).value;
  assert.equal(answer.selection.provider, 'anthropic-oauth');
  assert.deepEqual(providersOf(answer), ['anthropic-oauth']);
  assert.equal(calls.length, 1);
});

test('an allowed provider with no recorded history never falls back to a disallowed one', async () => {
  const { invoke } = historyWindow(['xai', 'openai-oauth'], notXai);
  const answer = (await invoke({ capability: 'getQuotaHistory', args: [{ provider: 'anthropic-oauth' }] })).value;
  assert.equal(answer.selection.provider, 'openai-oauth');
  assert.deepEqual(providersOf(answer), ['openai-oauth']);
});

test('a paged history read with no allowed default finds one from the subscription list', async () => {
  const { invoke } = historyWindow(['xai', 'openai-oauth'], notXai);
  const answer = (await invoke({ capability: 'getQuotaHistory', args: [{ page: 0 }] })).value;
  assert.equal(answer.selection.provider, 'openai-oauth');
  assert.equal(answer.windows.length, 1);
});

test('quota history is empty when the server may use none of the recorded providers', async () => {
  const { invoke } = historyWindow(['xai'], notXai);
  const answer = (await invoke({ capability: 'getQuotaHistory', args: [{}] })).value;
  assert.equal(answer.selection, null);
  assert.deepEqual(answer.subscriptions, []);
  assert.deepEqual(answer.windows, []);
});

test('a Codex reset returns its nested dashboard filtered, and stays on the server when Codex is disallowed', async () => {
  const allowedCodex = historyWindow([], notXai);
  const reset = (await allowedCodex.invoke({ capability: 'consumeCodexRateLimitResetCredit', args: [{}] })).value;
  assert.deepEqual(reset.dashboard.rows, [{ id: 'openai-oauth' }]);
  const blocked = historyWindow([], (provider) => provider !== 'openai-oauth');
  assert.equal(
    (await blocked.invoke({ capability: 'consumeCodexRateLimitResetCredit', args: [{}] })).value,
    'server:consumeCodexRateLimitResetCredit'
  );
});

test('without a PC host (this PC window) quota reads stay on the window host', async () => {
  const { handlers } = setup(false);
  const read = await handlers.get(DESKTOP_IPC.readCapabilities)({}, [{ capability: 'getUsageDashboard' }]);
  assert.equal(read[0].value, 'server:getUsageDashboard');
});
