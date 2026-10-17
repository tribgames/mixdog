import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-desktop-proxy-usage-'));
process.env.MIXDOG_DATA_DIR = dir;
delete process.env.MIXDOG_MODEL_PROXY;
const { createModelProxyHost, createModelProxyRuntime } = await import('./model-proxy-host.ts');
const { createModelProxyUsage } = await import('../../../../src/runtime/agent/orchestrator/providers/model-proxy-usage-host.mjs');
const { ModelProxyChannel, MODEL_PROXY_REQUEST_EVENT } = await import(
  '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs'
);
const { createAccountPoolProvider } = await import('../../../../src/runtime/agent/orchestrator/providers/account-pool.mjs');
const { registerProviderAccount, changeProviderAccounts, readProviderAccountPool } = await import(
  '../../../../src/runtime/shared/provider-accounts.mjs'
);
const { currentProviderAccountId } = await import('../../../../src/runtime/shared/provider-auth-binding.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

function connect(t, runtime, options = {}) {
  const channel = new ModelProxyChannel();
  const host = createModelProxyHost({
    invoke: async (operation, args) =>
      JSON.parse(JSON.stringify((await channel.handleOperation(operation, JSON.parse(JSON.stringify(args)))) ?? null)),
    loadRuntime: async () => runtime,
    ...options,
  });
  const detach = channel.attachPublisher((value) => {
    const snapshot = JSON.parse(JSON.stringify(value));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, snapshot));
  });
  t.after(() => {
    detach();
    host.dispose();
  });
  return channel;
}
function runtime(providers = {}, extra = {}) {
  return {
    provider: async (name) => providers[name],
    providerConfig: async () => ({ providers: { 'anthropic-oauth': { enabled: true } }, ready: true }),
    finalizeTools: (tools) => tools,
    ...extra,
  };
}
const account = `proxy-${'a'.repeat(64)}`;
const other = `proxy-${'b'.repeat(64)}`;
const name = 'anthropic-oauth';
const slot = 'cab7f9f6-5de5-44ef-a036-42a18f7da280';
const otherSlot = 'cab7f9f6-5de5-44ef-a036-42a18f7da281';
const thirdSlot = 'cab7f9f6-5de5-44ef-a036-42a18f7da282';
const scope = (id) =>
  `proxy-${createHash('sha256').update(JSON.stringify(['desktop-fixture', name, id, { id: `person-${id}` }])).digest('hex')}`;

test('oauthUsage crosses a real JSON RPC hop with only safe fields and exact force semantics', async (t) => {
  const instance = { send: async () => ({ content: 'ok' }) };
  const at = Date.now() - 200_000;
  const calls = [];
  const channel = connect(t, runtime({ [name]: instance }, {
    oauthUsage: async (...args) => {
      calls.push(args);
      return {
        status: 'ready',
        accounts: [account, other],
        account,
        email: 'private@example.com',
        snapshot: {
          provider: name,
          accountId: account,
          source: 'desktop-oauth',
          cachedAt: at,
          quotaWindows: [{ label: '5H', usedPct: 13, resetAt: at + 300_000, token: 'private-token' }],
          raw: { authorization: 'Bearer private-token' },
          resetCredits: { available: 3 },
        },
      };
    },
  }));
  const result = await channel.request({ method: 'oauthUsage', provider: name, force: true });
  assert.deepEqual(result, {
    status: 'ready',
    accounts: [account, other],
    account,
    snapshot: {
      provider: name,
      accountId: account,
      source: 'desktop-oauth',
      cachedAt: at,
      quotaWindows: [{ label: '5H', usedPct: 13, resetAt: at + 300_000 }],
    },
  });
  assert.deepEqual(calls, [[name, instance, true]]);
  await channel.request({ method: 'oauthUsage', provider: name, force: 'true' });
  assert.equal(calls[1][2], false);
  assert.doesNotMatch(JSON.stringify(result), /private|raw|resetCredits|authorization/);
});

test('a provider allowlist is checked before provider loading, identity reads, and measurement', async (t) => {
  let touched = 0;
  const channel = connect(t, runtime({}, {
    provider: async () => { touched += 1; },
    oauthUsage: async () => { touched += 1; },
    captureUsageAccount: () => { touched += 1; },
  }), { isProviderAllowed: () => false });
  await assert.rejects(channel.request({ method: 'oauthUsage', provider: name }), {
    code: 'MODEL_PROXY_PROVIDER_NOT_ALLOWED',
  });
  assert.equal(touched, 0);
});

test('a runtime cannot export a raw identity as an account scope', async (t) => {
  const channel = connect(t, runtime({}, {
    oauthUsage: async () => ({ status: 'unavailable', accounts: [account, 'private@example.com'], account }),
  }));
  assert.deepEqual(await channel.request({ method: 'oauthUsage', provider: name }), {
    status: 'unavailable', accounts: [],
  });
});

test('revoking the allowlist while measuring does not disclose the old scopes', async (t) => {
  let allowed = true;
  const channel = connect(t, runtime({}, {
    oauthUsage: async () => {
      allowed = false;
      return { status: 'unavailable', accounts: [account], account };
    },
  }), { isProviderAllowed: () => allowed });
  await assert.rejects(channel.request({ method: 'oauthUsage', provider: name }), {
    code: 'MODEL_PROXY_PROVIDER_NOT_ALLOWED',
  });
});

test('capability is absent for an old runtime and present for supported RPC even when quota is unsupported', async (t) => {
  const advertised = async () => ({
    providers: {
      [name]: {
        enabled: true,
        modelProxy: { oauthUsage: true, consumesReadWindows: true, firstResponseBudget: { transportMs: 100, semanticMs: 200 } },
      },
      custom: { enabled: true, type: 'custom', models: [{ id: 'hidden', hidden: true }] },
    },
  });
  let loaded = false;
  const old = connect(t, runtime({}, {
    providerConfig: advertised,
    provider: async () => { loaded = true; },
  }));
  const oldConfig = await old.request({ method: 'providerConfig' });
  assert.equal(oldConfig.providers[name].modelProxy.oauthUsage, undefined, 'stored traits cannot invent RPC support');
  assert.equal(oldConfig.providers[name].modelProxy.consumesReadWindows, true);
  assert.deepEqual(oldConfig.providers[name].modelProxy.firstResponseBudget, { transportMs: 100, semanticMs: 200 });
  assert.deepEqual(oldConfig.providers.custom.hiddenModels, ['hidden']);
  assert.deepEqual(await old.request({ method: 'oauthUsage', provider: name }), { status: 'unsupported', accounts: [] });
  assert.equal(loaded, false);
  const current = connect(t, runtime({}, {
    providerConfig: advertised,
    oauthUsage: async () => ({ status: 'unsupported', accounts: [account], account }),
  }));
  assert.equal((await current.request({ method: 'providerConfig' })).providers[name].modelProxy.oauthUsage, true);
  assert.deepEqual(await current.request({ method: 'oauthUsage', provider: name }), {
    status: 'unsupported', accounts: [account], account,
  });
});

test('disabled providers disclose no scopes; a registry load failure preserves independent scopes', async (t) => {
  let enabled = false;
  let identities = 0;
  const usage = createModelProxyUsage({
    accounts: () => {
      identities += 1;
      return { selectedId: 'default', accounts: [{ id: 'default', authenticated: true, identity: { id: 'private-id' }, version: 'v1' }] };
    },
    owner: () => 'fixture-owner',
  });
  const modules = {
    usage,
    loadConfig: () => ({ providers: { [name]: { enabled } } }),
    initProviders: async () => { throw new Error('transient adapter failure private-token'); },
    getAllProviders: () => new Map(),
    getProvider: () => undefined,
    probeAuth: () => 'present',
    readApiKey: async () => null,
    finalizeProviderRequestTools: (tools) => tools,
  };
  const channel = connect(t, createModelProxyRuntime(modules));
  assert.deepEqual(await channel.request({ method: 'oauthUsage', provider: name }), { status: 'unavailable', accounts: [] });
  assert.equal(identities, 0);
  enabled = true;
  const result = await channel.request({ method: 'oauthUsage', provider: name });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.accounts.length, 1);
  assert.equal(result.account, result.accounts[0]);
  assert.doesNotMatch(JSON.stringify(result), /private|failure|token/);
  modules.usage = {
    ...usage,
    snapshot: async () => {
      enabled = false;
      return result;
    },
  };
  assert.deepEqual(await channel.request({ method: 'oauthUsage', provider: name }), {
    status: 'unavailable', accounts: [],
  }, 'disabling a provider during measurement retires all scopes');
});

test('actual fallback serving proof wins over both the original and a concurrently selected account', async (t) => {
  for (const id of [slot, otherSlot, thirdSlot]) await registerProviderAccount(name, id);
  await changeProviderAccounts(name, { selectedId: slot });
  const attempts = [];
  const accounts = () => {
    const pool = readProviderAccountPool(name);
    return {
      selectedId: pool.selectedId,
      accounts: pool.accounts.map(({ id }) => ({ id, authenticated: true, identity: { id: `person-${id}` }, version: 'v1' })),
    };
  };
  const usage = createModelProxyUsage({ accounts, owner: () => 'desktop-fixture' });
  const provider = createAccountPoolProvider(name, () => {
    const id = currentProviderAccountId(name);
    return {
      credentials: { identity: { id: `person-${id}` } },
      async send(_messages, _model, _tools, options) {
        attempts.push(id);
        assert.equal(options.toolExecutionSessionId, '');
        if (id === slot) throw Object.assign(new Error('fixture reauth refusal'), { reauthRequired: true });
        await changeProviderAccounts(name, { selectedId: thirdSlot });
        return { content: 'served', usage: { inputTokens: 3 } };
      },
    };
  });
  const channel = connect(t, runtime({ [name]: provider }, { captureUsageAccount: usage.captureAccount }));
  const result = await channel.request({ method: 'send', provider: name, messages: [], model: 'fixture', options: {} });
  assert.deepEqual(attempts, [slot, otherSlot]);
  assert.equal(readProviderAccountPool(name).selectedId, thirdSlot);
  assert.equal(result.providerMetadata.accountRouting.provider, name);
  assert.equal(result.providerMetadata.accountRouting.accountId, otherSlot);
  assert.equal(result.modelProxyUsageAccount, scope(otherSlot));
  assert.notEqual(result.modelProxyUsageAccount, scope(slot));
  assert.notEqual(result.modelProxyUsageAccount, scope(thirdSlot));
  assert.doesNotMatch(JSON.stringify(result), /person-/);
});

for (const reason of ['wrong-provider', 'unqualified-state', 'missing-proof', 'revision-race', 'adapter-identity-race']) {
  test(`${reason}: a successful response without complete serving proof stays unattributed`, async (t) => {
    const pool = { selectedId: slot, accounts: [{ id: slot, authenticated: true, identity: { id: `person-${slot}` }, version: 'v1' }] };
    const usage = createModelProxyUsage({ accounts: () => pool, owner: () => 'desktop-fixture' });
    const instance = {
      credentials: { identity: { id: `person-${slot}` } },
      async send(_messages, _model, _tools, options) {
        const finish = options._captureModelProxyUsageAccount?.(name, slot, instance);
        if (reason === 'revision-race') pool.accounts[0].version = 'v3-after-A-B-A';
        if (reason === 'adapter-identity-race') instance.credentials.identity.id = 'replacement';
        const result = {
          content: 'served',
          modelProxyUsageAccount: account, // An adapter cannot invent the reserved proof field.
          ...(reason === 'unqualified-state'
            ? { providerState: { providerAccountId: slot } }
            : { providerMetadata: { accountRouting: { provider: reason === 'wrong-provider' ? 'openai-oauth' : name, accountId: slot } } }),
        };
        if (reason !== 'missing-proof') finish?.(result);
        return result;
      },
    };
    const channel = connect(t, runtime({ [name]: instance }, { captureUsageAccount: usage.captureAccount }));
    const result = await channel.request({ method: 'send', provider: name, messages: [], model: 'fixture' });
    assert.equal(result.modelProxyUsageAccount, undefined);
  });
}

test('failed partial attempts never assign a successful account retroactively', async (t) => {
  const instance = {
    async send(_messages, _model, _tools, options) {
      const finish = options._captureModelProxyUsageAccount(name, slot, instance);
      const partial = { providerMetadata: { accountRouting: { provider: name, accountId: slot } } };
      finish(partial);
      throw Object.assign(new Error('fixture partial response'), { partialContent: 'partial', liveTextEmitted: true });
    },
  };
  const channel = connect(t, runtime({ [name]: instance }, { captureUsageAccount: () => () => account }));
  await assert.rejects(channel.request({ method: 'send', provider: name, messages: [] }), (error) => {
    assert.equal(error.partialContent, 'partial');
    assert.equal(error.modelProxyUsageAccount, undefined);
    return true;
  });
});

test('identity evidence failing must not turn a successful send into a model failure', async (t) => {
  const instance = {
    async send(_messages, _model, _tools, options) {
      const finish = options._captureModelProxyUsageAccount?.(name, slot, instance);
      const result = { content: 'served', providerMetadata: { accountRouting: { provider: name, accountId: slot } } };
      finish?.(result);
      return result;
    },
  };
  for (const captureUsageAccount of [
    () => { throw new Error('roster unreadable'); },
    () => () => { throw new Error('credential replaced'); },
  ]) {
    const channel = connect(t, runtime({ [name]: instance }, { captureUsageAccount }));
    const result = await channel.request({ method: 'send', provider: name, messages: [] });
    assert.equal(result.content, 'served');
    assert.equal(result.modelProxyUsageAccount, undefined);
  }
});
