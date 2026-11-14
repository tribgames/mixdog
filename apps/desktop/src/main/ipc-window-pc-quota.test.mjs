import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_EXTRAS_IPC, registerHostExtrasIpc } from './ipc-host-extras.ts';

// A quota answer of null means "not this PC's quota": the caller sends the call to the window's own host.
function extras({ pcHost } = {}) {
  const handlers = new Map();
  registerHostExtrasIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    host: { invokeCapability: async () => ({}) },
    pcHost,
    confirmAllowAllActions: async () => false,
    signInFocus: null,
  });
  return {
    invoke: (input) => handlers.get(HOST_EXTRAS_IPC.pcQuotaInvoke)({}, input),
    read: (input) => handlers.get(HOST_EXTRAS_IPC.pcQuotaRead)({}, input),
  };
}

const pcService = (extra = {}) => ({
  invokeCapability: async (capability) => ({ value: `pc:${capability}` }),
  readCapabilities: async (requests) => requests.map((request) => ({ ok: true, value: `pc:${request.capability}` })),
  ...extra,
});

test('a server window reads provider quota from this PC, everything else from the server', async () => {
  const { invoke, read } = extras({ pcHost: pcService() });
  const answers = await read([
    { capability: 'getLeadStatus' },
    { capability: 'getUsageDashboard', args: [{}] },
    { capability: 'getQuotaHistory' },
    { capability: 'getUsageStats' },
  ]);
  assert.deepEqual(
    answers.map((entry) => entry?.value ?? null),
    [null, 'pc:getUsageDashboard', 'pc:getQuotaHistory', null]
  );
  assert.equal((await invoke({ capability: 'getUsageDashboard' })).value, 'pc:getUsageDashboard');
  // A session-addressed call stays with the session's own server.
  assert.equal(await invoke({ capability: 'getUsageDashboard', sessionId: 's1' }), null);
  // A server that runs models with its own logins keeps its own quota.
  const own = extras({ pcHost: pcService({ inUse: () => false }) });
  assert.equal(await own.invoke({ capability: 'getUsageDashboard' }), null);
});

// Connection kinds: the desktop has `local` (no pcHost: its own sign-ins) and
// `ssh` (daemon in model-proxy client mode: no credentials of its own, every
// model call on this PC's sign-in, filtered by the host's provider list).
// Phones, browsers and another PC's window are not Electron connections here;
// they reach a host's own daemon through remote-methods and its own accounts.
test('a server window shows only the providers its proxy lets the server use', async () => {
  const pc = pcService({
    isProviderAllowed: (provider) => provider !== 'xai',
    invokeCapability: async (capability, args) => ({
      value: { rows: [{ id: 'anthropic-oauth' }, { id: 'xai' }], total: {}, capability, args },
    }),
    readCapabilities: async (requests) =>
      requests.map(() => ({ ok: true, value: { rows: [{ id: 'xai' }, { id: 'openai-oauth' }] } })),
  });
  const { invoke, read } = extras({ pcHost: pc });
  assert.deepEqual((await invoke({ capability: 'getUsageDashboard' })).value.rows, [{ id: 'anthropic-oauth' }]);
  assert.deepEqual((await read([{ capability: 'getUsageDashboard' }]))[0].value.rows, [{ id: 'openai-oauth' }]);
  // A history read naming a provider the server cannot use stays on the server.
  assert.equal(await invoke({ capability: 'getQuotaHistory', args: [{ provider: 'xai' }] }), null);
  assert.notEqual(await invoke({ capability: 'getQuotaHistory', args: [{ provider: 'anthropic-oauth' }] }), null);
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
  return { calls, ...extras({ pcHost: pc }) };
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
  assert.equal(await blocked.invoke({ capability: 'consumeCodexRateLimitResetCredit', args: [{}] }), null);
});

test('without a PC host (this PC window) quota reads stay on the window host', async () => {
  const { invoke, read } = extras();
  assert.equal(await invoke({ capability: 'getUsageDashboard' }), null);
  assert.equal((await read([{ capability: 'getUsageDashboard' }]))[0], null);
});
