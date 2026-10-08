import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const secrets = new Map();
const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    deleteSecret: (account) => secrets.delete(account),
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
mock.module('../../runtime/shared/provider-api-key.mjs', {
  namedExports: { getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null },
});

const created = [];
let behavior = {};
mock.module('../../runtime/agent/orchestrator/providers/custom-provider.mjs', {
  namedExports: {
    normalizeCustomProviderConfig: (input, { requireModels = true } = {}) => {
      if (!input.name) throw new Error('name required');
      const models = input.models || [];
      if (requireModels && !models.length) throw new Error('model required');
      return { name: input.name, protocol: input.protocol, baseURL: input.baseURL, models };
    },
    createCustomProvider: async (id, config) => {
      created.push({ id, config });
      return {
        send: async (...args) => behavior.send?.(...args),
        listModels: async () => behavior.listModels?.(),
      };
    },
  },
});

const admin = await import('./provider-admin.mjs');

function makeCfg() {
  let config = { providers: { openai: { enabled: true } } };
  return {
    loadConfig: () => structuredClone(config),
    saveConfig: (next) => {
      config = structuredClone(next);
    },
    peek: () => config,
  };
}

const input = {
  name: 'Local',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'sk-secret-123456',
  models: [{ id: 'm1', contextWindow: 8000 }],
};

test('save generates id, stores key only as secret, and appears in setup without a key', async () => {
  const cfg = makeCfg();
  const row = await admin.saveCustomProvider(cfg, input);
  assert.match(row.id, /^custom-[0-9a-f-]{36}$/);
  assert.equal(cfg.peek().providers[row.id].apiKey, undefined);
  assert.deepEqual(cfg.peek().providers[row.id], {
    type: 'custom',
    name: 'Local',
    protocol: 'openai-chat',
    baseURL: input.baseURL,
    models: input.models,
    enabled: true,
  });
  assert.equal(secrets.get(`agent.${row.id}.apiKey`), input.apiKey);
  const setup = await admin.providerSetup(cfg.peek());
  const custom = setup.api.find((r) => r.id === row.id);
  assert.equal(custom.custom, true);
  assert.equal(custom.authenticated, true);
  assert.equal(custom.enabled, true);
  assert.equal(admin.isKnownProvider(row.id, cfg.peek()), true);
  assert.equal(admin.isKnownProvider(row.id, { providers: {} }), false);
  assert.equal(JSON.stringify([row, setup, admin.providerStatus(cfg.peek())]).includes(input.apiKey), false);
});

test('edit with blank key preserves secret; unknown or built-in id is rejected', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  const edited = await admin.saveCustomProvider(cfg, { ...input, id, name: 'Renamed', apiKey: '' });
  assert.equal(edited.id, id);
  assert.equal(cfg.peek().providers[id].name, 'Renamed');
  assert.equal(secrets.get(`agent.${id}.apiKey`), input.apiKey);
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id: 'openai' }), /unknown custom provider/);
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id: 'custom-nope' }), /unknown custom provider/);
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, apiKey: '' }), /API key is required/);
});

test('remove deletes config and secret, and only custom providers', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  admin.removeCustomProvider(cfg, id);
  assert.equal(cfg.peek().providers[id], undefined);
  assert.equal(secrets.has(`agent.${id}.apiKey`), false);
  assert.equal(cfg.peek().providers.openai.enabled, true);
  assert.throws(() => admin.removeCustomProvider(cfg, 'openai'), /unknown custom provider/);
  assert.throws(() => admin.removeCustomProvider(cfg, id), /unknown custom provider/);
});

test('failed config edits restore the previous API key', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  cfg.saveConfig = () => { throw new Error('save failed'); };
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id, apiKey: 'replacement-secret' }), /save failed/);
  assert.equal(secrets.get(`agent.${id}.apiKey`), input.apiKey);
});

test('registration needs no model IDs and connection tests discover a model automatically', async () => {
  const cfg = makeCfg();
  const automatic = { ...input, models: [] };
  const saved = await admin.saveCustomProvider(cfg, automatic);
  assert.deepEqual(cfg.peek().providers[saved.id].models, []);
  let testedModel;
  behavior = {
    listModels: async () => [{ id: 'discovered-model' }],
    send: async (_messages, model) => { testedModel = model; },
  };
  assert.deepEqual(await admin.testCustomProvider(cfg, automatic), { ok: true });
  assert.equal(testedModel, 'discovered-model');
  behavior = { listModels: async () => [] };
  await assert.rejects(admin.testCustomProvider(cfg, automatic), /No models were found/);
});

test('test connection exercises the model and sanitizes failures', async () => {
  const cfg = makeCfg();
  created.length = 0;
  behavior = { send: async (_m, model) => ({ content: model }) };
  assert.deepEqual(await admin.testCustomProvider(cfg, input), { ok: true });
  assert.equal(created.at(-1).config.apiKey, input.apiKey);

  let seenModel;
  behavior = { send: async (_m, model) => (seenModel = model) };
  await admin.testCustomProvider(cfg, input);
  assert.equal(seenModel, 'm1');

  behavior = {
    send: async () => {
      throw new Error(`401 Bearer ${input.apiKey} bad key ${input.apiKey}`);
    },
  };
  await assert.rejects(admin.testCustomProvider(cfg, input), (error) => {
    assert.equal(error.message.includes(input.apiKey), false);
    assert.match(error.message, /401/);
    return true;
  });
});

test('test uses the stored key when editing with a blank key', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  behavior = { send: async () => ({}) };
  await admin.testCustomProvider(cfg, { ...input, id, apiKey: '' });
  assert.equal(created.at(-1).config.apiKey, input.apiKey);
});

test('discovery returns normalized models and errors truthfully', async () => {
  const cfg = makeCfg();
  behavior = {
    listModels: async () => [
      { id: 'a', name: 'A', contextWindow: 1000, outputTokens: 50 },
      { id: 'a' },
      { id: 'b' },
      {},
    ],
  };
  assert.deepEqual(await admin.discoverCustomProviderModels(cfg, input), {
    models: [{ id: 'a', name: 'A', contextWindow: 1000, maxOutputTokens: 50 }, { id: 'b' }],
  });
  assert.deepEqual(created.at(-1).config.models, []);
  behavior = {
    listModels: async () => {
      throw new Error(`404 not found for ${input.apiKey}`);
    },
  };
  await assert.rejects(admin.discoverCustomProviderModels(cfg, { ...input, models: [] }), (error) => {
    assert.match(error.message, /404/);
    assert.equal(error.message.includes(input.apiKey), false);
    return true;
  });
});
