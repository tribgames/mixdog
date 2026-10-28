import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const secrets = new Map();
const deleted = [];
let deleteFailure = null;
const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => secrets.set(account, value),
    deleteSecretAsync: async (account) => {
      deleted.push(account);
      if (deleteFailure) throw deleteFailure;
      secrets.delete(account);
    },
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
mock.module('../../runtime/shared/provider-api-key.mjs', {
  namedExports: {
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
    hasAgentApiKey: (id) => secrets.has(`agent.${id}.apiKey`),
    agentApiKeyEnvName: () => null,
  },
});

const created = [];
let behavior = {};
const { canonicalReasoningLevel, assertCustomReasoningPatch } = await import(
  '../../runtime/agent/orchestrator/providers/custom-provider-config.mjs'
);
mock.module('../../runtime/agent/orchestrator/providers/custom-provider.mjs', {
  namedExports: {
    canonicalReasoningLevel,
    assertCustomReasoningPatch,
    // v2 output; a legacy `models` input becomes manual overrides.
    normalizeCustomProviderConfig: (input) => {
      if (!input.name) throw new Error('name required');
      if (input.badOverride) throw new Error('invalid override');
      const legacy = input.schemaVersion === undefined;
      const fromModels = Object.fromEntries(
        (input.models || []).map(({ id, ...rest }) => [id, { manual: true, hidden: false, ...rest }])
      );
      return {
        type: 'custom',
        schemaVersion: 2,
        name: input.name,
        protocol: input.protocol,
        baseURL: input.baseURL,
        enabled: true,
        auth: input.auth === 'none' ? 'none' : 'key',
        ...(input.apiKeyEnv && input.auth !== 'none' ? { apiKeyEnv: input.apiKeyEnv } : {}),
        discovery: {
          newModelsHidden: legacy ? (input.models || []).length > 0 : input.discovery?.newModelsHidden === true,
        },
        modelOverrides: structuredClone(legacy ? fromModels : input.modelOverrides || {}),
      };
    },
    createCustomProvider: async (id, config) => {
      created.push({ id, config });
      return {
        send: async (...args) => behavior.send?.(...args),
        listModels: async () => behavior.listModels?.(),
        get customDiscoveryError() {
          return behavior.discoveryError ?? null;
        },
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

test('Vertex AI stores the service-account JSON as a secret and keeps only routing settings in config', async () => {
  const cfg = makeCfg();
  const secret = JSON.stringify({
    type: 'service_account',
    project_id: 'key-project',
    client_email: 'mixdog@key-project.iam.gserviceaccount.com',
    private_key: 'private-key-material',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  assert.deepEqual(
    await admin.saveProviderApiKey(cfg, 'vertex-ai', secret, {
      location: 'us-east5',
      projectId: 'override-project',
    }),
    { provider: 'vertex-ai', type: 'service-account', authenticated: true }
  );
  assert.equal(secrets.get('agent.vertex-ai.apiKey'), secret);
  assert.deepEqual(cfg.peek().providers['vertex-ai'], {
    enabled: true,
    location: 'us-east5',
    projectId: 'override-project',
  });
  const setup = await admin.providerSetup(cfg.peek());
  const row = setup.api.find((provider) => provider.id === 'vertex-ai');
  assert.equal(row.authKind, 'service-account');
  assert.equal(row.projectId, 'override-project');
  assert.equal(row.location, 'us-east5');
  assert.equal(JSON.stringify(setup).includes(secret), false);
});

test('save generates id, stores key only as secret, and appears in setup without a key', async () => {
  const cfg = makeCfg();
  const row = await admin.saveCustomProvider(cfg, input);
  assert.match(row.id, /^custom-[0-9a-f-]{36}$/);
  assert.equal(cfg.peek().providers[row.id].apiKey, undefined);
  assert.deepEqual(cfg.peek().providers[row.id], {
    type: 'custom',
    schemaVersion: 2,
    name: 'Local',
    protocol: 'openai-chat',
    baseURL: input.baseURL,
    enabled: true,
    auth: 'key',
    discovery: { newModelsHidden: true },
    modelOverrides: { m1: { manual: true, hidden: false, contextWindow: 8000 } },
  });
  assert.equal('models' in cfg.peek().providers[row.id], false);
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
  // Malformed ids fail the transport check (IPC parity); a well-formed id
  // that is not stored fails the lookup.
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id: 'openai' }), /custom provider id is invalid/);
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id: 'custom-nope' }), /custom provider id is invalid/);
  await assert.rejects(
    admin.saveCustomProvider(cfg, { ...input, id: 'custom-00000000-0000-4000-8000-000000000000' }),
    /unknown custom provider/
  );
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, apiKey: '' }), /API key is required/);
});

test('saveCustomProviderKey replaces only the key and never writes the provider config', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  // An edit that landed meanwhile is never reverted: the config is not touched at all.
  await admin.saveCustomProvider(cfg, { ...input, id, name: 'Renamed', apiKey: '' });
  const before = JSON.stringify(cfg.peek());
  const saves = mock.fn(cfg.saveConfig);
  cfg.saveConfig = saves;
  const row = await admin.saveCustomProviderKey(cfg, id, '  sk-replacement-9999  ');
  assert.equal(secrets.get(`agent.${id}.apiKey`), 'sk-replacement-9999');
  assert.equal(saves.mock.callCount(), 0);
  assert.equal(JSON.stringify(cfg.peek()), before);
  assert.equal(row.name, 'Renamed');
  assert.equal(JSON.stringify(row).includes('sk-replacement-9999'), false);

  await assert.rejects(admin.saveCustomProviderKey(cfg, id, '   '), /API key is required/);
  await assert.rejects(admin.saveCustomProviderKey(cfg, 'openai', 'sk-x'), /unknown custom provider/);
  await assert.rejects(
    admin.saveCustomProviderKey(cfg, 'custom-00000000-0000-4000-8000-000000000000', 'sk-x'),
    /unknown custom provider/
  );
  const keyless = await admin.saveCustomProvider(cfg, { ...input, auth: 'none', apiKey: undefined });
  await assert.rejects(admin.saveCustomProviderKey(cfg, keyless.id, 'sk-x'), /needs no API key/);
  assert.equal(secrets.has(`agent.${keyless.id}.apiKey`), false);
  const viaEnv = await admin.saveCustomProvider(cfg, { ...input, apiKey: undefined, apiKeyEnv: 'ACME_KEY' });
  await assert.rejects(admin.saveCustomProviderKey(cfg, viaEnv.id, 'sk-x'), /ACME_KEY/);
  assert.equal(secrets.has(`agent.${viaEnv.id}.apiKey`), false);
});

test('remove deletes config and secret, and only custom providers', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  await admin.removeCustomProvider(cfg, id);
  assert.equal(cfg.peek().providers[id], undefined);
  assert.equal(secrets.has(`agent.${id}.apiKey`), false);
  assert.equal(cfg.peek().providers.openai.enabled, true);
  await assert.rejects(() => admin.removeCustomProvider(cfg, 'openai'), /unknown custom provider/);
  await assert.rejects(() => admin.removeCustomProvider(cfg, id), /unknown custom provider/);
});

test('removing a keyless provider succeeds and drops its settings and routes', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, { ...input, auth: 'none', apiKey: undefined });
  assert.equal(secrets.has(`agent.${id}.apiKey`), false);
  cfg.saveConfig({
    ...cfg.loadConfig(),
    modelSettings: { [`${id}/m1`]: { fast: true }, 'openai/gpt': { fast: true } },
    agents: { worker: { provider: id, model: 'm1' }, other: { provider: 'openai', model: 'gpt' } },
    webSearchRoute: { provider: id, model: 'm1' },
    presets: [
      { id: 'mine', provider: id, model: 'm1' },
      { id: 'keep', provider: 'openai', model: 'gpt' },
    ],
    default: 'mine',
  });
  deleted.length = 0;
  await admin.removeCustomProvider(cfg, id);
  assert.deepEqual(deleted, [`agent.${id}.apiKey`]);
  assert.deepEqual(cfg.peek(), {
    providers: { openai: { enabled: true } },
    modelSettings: { 'openai/gpt': { fast: true } },
    agents: { other: { provider: 'openai', model: 'gpt' } },
    presets: [{ id: 'keep', provider: 'openai', model: 'gpt' }],
  });
});

test('removing a keyed provider deletes its secret', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  assert.equal(secrets.has(`agent.${id}.apiKey`), true);
  await admin.removeCustomProvider(cfg, id);
  assert.equal(secrets.has(`agent.${id}.apiKey`), false);
  assert.equal(cfg.peek().providers[id], undefined);
});

test('a keychain failure on removal is reported and keeps the provider for retry', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  deleteFailure = new Error('[keychain] the keyring is locked');
  try {
    await assert.rejects(() => admin.removeCustomProvider(cfg, id), /keyring is locked/);
  } finally {
    deleteFailure = null;
  }
  assert.ok(cfg.peek().providers[id]);
  await admin.removeCustomProvider(cfg, id);
  assert.equal(cfg.peek().providers[id], undefined);
});

test('failed config edits restore the previous API key', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, input);
  cfg.saveConfig = () => {
    throw new Error('save failed');
  };
  await assert.rejects(admin.saveCustomProvider(cfg, { ...input, id, apiKey: 'replacement-secret' }), /save failed/);
  assert.equal(secrets.get(`agent.${id}.apiKey`), input.apiKey);
});

test('registration needs no model IDs and connection tests discover a model automatically', async () => {
  const cfg = makeCfg();
  const automatic = { ...input, models: [] };
  const saved = await admin.saveCustomProvider(cfg, automatic);
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides, {});
  let testedModel;
  behavior = {
    listModels: async () => [{ id: 'discovered-model' }],
    send: async (_messages, model) => {
      testedModel = model;
    },
  };
  assert.deepEqual(await admin.testCustomProvider(cfg, automatic), { ok: true });
  assert.equal(testedModel, 'discovered-model');
  behavior = { listModels: async () => [] };
  assert.deepEqual(await admin.testCustomProvider(cfg, automatic), {
    ok: false,
    phase: 'discovery',
    error: { kind: 'empty', message: 'No models were found for this provider' },
  });
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
    models: [
      { id: 'a', name: 'A', contextWindow: 1000, maxOutputTokens: 50, hidden: false, manual: false },
      { id: 'b', hidden: false, manual: false },
    ],
  });
  behavior = {
    listModels: async () => {
      throw Object.assign(new Error(`404 not found for ${input.apiKey}`), { status: 404 });
    },
  };
  const result = await admin.discoverCustomProviderModels(cfg, { ...input, models: [] });
  assert.deepEqual(result.models, []);
  assert.equal(result.error.kind, 'unavailable');
  assert.equal(result.error.status, 404);
  assert.match(result.error.message, /404/);
  assert.equal(result.error.message.includes(input.apiKey), false);
  assert.deepEqual(await admin.testCustomProvider(cfg, { ...input, models: [] }), {
    ok: false,
    phase: 'discovery',
    error: result.error,
  });
});

test('discovery failure categories use HTTP status, not error text', async () => {
  const cfg = makeCfg();
  for (const [status, kind, code] of [
    [404, 'unavailable'],
    [405, 'unavailable'],
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'request'],
    [500, 'request'],
    [undefined, 'request'],
    [undefined, 'timeout', 'EPROVIDERTIMEOUT'],
  ]) {
    behavior = {
      listModels: async () => {
        throw Object.assign(new Error('404 may appear in a URL or network error'), { status, code });
      },
      send: async () => {
        assert.fail('Discovery failure must not be reported as a successful model call');
      },
    };
    const result = await admin.testCustomProvider(cfg, { ...input, models: [] });
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'discovery');
    assert.equal(result.error.kind, kind);
    assert.equal(result.error.status, status);
  }
});

const v2Input = {
  schemaVersion: 2,
  name: 'Full',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'sk-secret-123456',
  auth: 'key',
  discovery: { newModelsHidden: true },
  modelOverrides: {
    'vendor/m': {
      manual: true,
      hidden: false,
      name: 'M',
      contextWindow: 8000,
      maxOutputTokens: 512,
      reasoning: { levels: ['low', 'high'], wireFormat: 'deepseek', wireValues: { low: 'l' }, replay: true },
    },
  },
};

test('v2 save round-trips every contract field and rewrites legacy entries as v2', async () => {
  const cfg = makeCfg();
  const row = await admin.saveCustomProvider(cfg, v2Input);
  const { apiKey: _k, ...expected } = v2Input;
  assert.deepEqual(cfg.peek().providers[row.id], { ...expected, type: 'custom', enabled: true });
  assert.deepEqual(row.modelOverrides, v2Input.modelOverrides);
  assert.equal(row.discovery.newModelsHidden, true);

  const legacyId = 'custom-11111111-2222-3333-4444-555555555555';
  const full = cfg.loadConfig();
  cfg.saveConfig({
    ...full,
    providers: {
      ...full.providers,
      [legacyId]: {
        type: 'custom',
        name: 'Old',
        protocol: 'openai-chat',
        baseURL: input.baseURL,
        models: [],
        enabled: true,
      },
    },
  });
  secrets.set(`agent.${legacyId}.apiKey`, 'legacy-key-value');
  assert.equal(cfg.peek().providers[legacyId].schemaVersion, undefined);
  await admin.saveCustomProvider(cfg, { ...v2Input, id: legacyId, apiKey: '' });
  assert.equal(cfg.peek().providers[legacyId].schemaVersion, 2);
});

test('updateCustomProviderModel is tri-state per property', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, v2Input);
  const ov = () => cfg.peek().providers[id].modelOverrides['vendor/m'];
  await admin.updateCustomProviderModel(cfg, id, 'vendor/m', { hidden: true, name: null });
  assert.equal(ov().hidden, true);
  assert.equal('name' in ov(), false);
  assert.equal(ov().contextWindow, 8000);
  await admin.updateCustomProviderModel(cfg, id, 'vendor/m', { reasoning: { replay: null, levels: [] } });
  // Clearing the levels retires their wire values.
  assert.deepEqual(ov().reasoning, { levels: [], wireFormat: 'deepseek' });
  await admin.updateCustomProviderModel(cfg, id, 'vendor/m', { reasoning: null });
  assert.equal('reasoning' in ov(), false);
  await admin.updateCustomProviderModel(cfg, id, 'new-model', { hidden: false });
  assert.deepEqual(cfg.peek().providers[id].modelOverrides['new-model'], { hidden: false });
  await admin.updateCustomProviderModel(cfg, id, 'new-model', { hidden: null });
  assert.equal('new-model' in cfg.peek().providers[id].modelOverrides, false);
  await admin.updateCustomProviderModel(cfg, id, 'vendor/m', null);
  assert.deepEqual(cfg.peek().providers[id].modelOverrides, {});
  assert.equal(cfg.peek().providers[id].discovery.newModelsHidden, true);
  await assert.rejects(admin.updateCustomProviderModel(cfg, id, 'm', { bogus: 1 }), /unsupported/);
  await assert.rejects(admin.updateCustomProviderModel(cfg, 'openai', 'm', {}), /unknown custom provider/);
});

test('concurrent updateCustomProviderModel calls on different models both persist', async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, v2Input);
  await Promise.all([
    admin.updateCustomProviderModel(cfg, id, 'a', { hidden: true }),
    admin.updateCustomProviderModel(cfg, id, 'b', { hidden: false }),
  ]);
  const overrides = cfg.peek().providers[id].modelOverrides;
  assert.deepEqual(overrides.a, { hidden: true });
  assert.deepEqual(overrides.b, { hidden: false });
});

test('keyless providers save, test and report authenticated without a key', async () => {
  const cfg = makeCfg();
  const keyless = { ...v2Input, auth: 'none', apiKey: '' };
  const before = secrets.size;
  const row = await admin.saveCustomProvider(cfg, keyless);
  assert.equal(secrets.size, before);
  assert.equal(row.authenticated, true);
  assert.equal(cfg.peek().providers[row.id].auth, 'none');
  const ignored = await admin.saveCustomProvider(cfg, { ...keyless, id: row.id, apiKey: 'typed-but-ignored-key' });
  assert.equal(secrets.has(`agent.${ignored.id}.apiKey`), false);
  behavior = { listModels: async () => [{ id: 'k' }], send: async () => ({}) };
  assert.deepEqual(await admin.testCustomProvider(cfg, keyless), { ok: true });
  assert.equal(created.at(-1).config.apiKey, '');
  const setup = await admin.providerSetup(cfg.peek());
  assert.equal(setup.api.find((r) => r.id === row.id).authenticated, true);
});

test('apiKeyEnv: save without key, keep/clear on edit, env-only key, status and check', async () => {
  const cfg = makeCfg();
  const NAME = 'MIXDOG_TEST_CUSTOM_KEY';
  delete process.env[NAME];
  const envInput = { ...v2Input, apiKey: '', apiKeyEnv: NAME };
  const secretsBefore = secrets.size;
  const row = await admin.saveCustomProvider(cfg, envInput);
  assert.equal(secrets.size, secretsBefore);
  assert.equal(cfg.peek().providers[row.id].apiKeyEnv, NAME);
  assert.equal(row.apiKeyEnv, NAME);
  assert.equal(row.authenticated, false);
  process.env[NAME] = 'env-key-value';
  try {
    const setup = await admin.providerSetup(cfg.peek());
    const listed = setup.api.find((r) => r.id === row.id);
    assert.equal(listed.authenticated, true);
    assert.equal(listed.apiKeyEnv, NAME);
    // Omitted keeps the stored name; a keychain key is never used in env mode.
    secrets.set(`agent.${row.id}.apiKey`, 'keychain-key');
    const { apiKeyEnv: _e, ...omitted } = envInput;
    await admin.saveCustomProvider(cfg, { ...omitted, id: row.id, name: 'Renamed' });
    assert.equal(cfg.peek().providers[row.id].apiKeyEnv, NAME);
    behavior = { listModels: async () => [{ id: 'k' }], send: async () => ({}) };
    await admin.testCustomProvider(cfg, { ...omitted, id: row.id });
    assert.equal(created.at(-1).config.apiKey, 'env-key-value');
    // A key rotated during the operation (auth retry) is redacted too.
    behavior = {
      listModels: async () => {
        process.env[NAME] = 'rotatedvalue4821';
        throw new Error('rejected rotatedvalue4821');
      },
      send: async () => {
        process.env[NAME] = 'rotatedvalue4821';
        throw new Error('rejected rotatedvalue4821');
      },
    };
    await assert.rejects(admin.testCustomProvider(cfg, { ...omitted, id: row.id }), (error) => {
      assert.equal(error.message.includes('rotatedvalue4821'), false);
      return true;
    });
    process.env[NAME] = 'env-key-value';
    const discovered = await admin.discoverCustomProviderModels(cfg, { ...omitted, id: row.id });
    assert.equal(discovered.error.message.includes('rotatedvalue4821'), false);
    process.env[NAME] = 'env-key-value';
    // Both a typed key and a name is rejected.
    await assert.rejects(admin.saveCustomProvider(cfg, { ...envInput, apiKey: 'x' }), /mutually exclusive/);
    await assert.rejects(admin.saveCustomProvider(cfg, { ...envInput, apiKeyEnv: 'bad name' }), /apiKeyEnv is invalid/);
    await assert.rejects(admin.saveCustomProvider(cfg, { ...envInput, apiKey: '   ' }), /mutually exclusive/);
    await assert.rejects(admin.saveCustomProvider(cfg, { ...envInput, auth: 'none' }), /requires key auth/);
    await assert.rejects(admin.testCustomProvider(cfg, { ...envInput, auth: 'none' }), /requires key auth/);
    await assert.rejects(admin.discoverCustomProviderModels(cfg, { ...envInput, apiKey: ' ' }), /mutually exclusive/);
    // null clears back to the direct key.
    await admin.saveCustomProvider(cfg, { ...omitted, id: row.id, apiKeyEnv: null });
    assert.equal('apiKeyEnv' in cfg.peek().providers[row.id], false);
    assert.deepEqual(admin.checkCustomProviderKeyEnv(NAME), { found: true });
    process.env[NAME] = '';
    assert.deepEqual(admin.checkCustomProviderKeyEnv(NAME), { found: false });
    assert.throws(() => admin.checkCustomProviderKeyEnv('1bad'), TypeError);
  } finally {
    delete process.env[NAME];
  }
});

test('edits that omit auth or v2 settings keep the stored ones; stated values replace them', async () => {
  const cfg = makeCfg();
  const row = await admin.saveCustomProvider(cfg, { ...v2Input, auth: 'none', apiKey: '' });
  const { auth: _a, discovery: _d, modelOverrides: _o, apiKey: _k, schemaVersion: _v, ...bare } = v2Input;
  await admin.saveCustomProvider(cfg, { ...bare, schemaVersion: 2, id: row.id, name: 'Renamed' });
  const stored = () => cfg.peek().providers[row.id];
  assert.equal(stored().name, 'Renamed');
  assert.equal(stored().auth, 'none');
  assert.deepEqual(stored().discovery, v2Input.discovery);
  assert.deepEqual(stored().modelOverrides, v2Input.modelOverrides);
  // A legacy-shaped edit restates its models but still keeps the stored auth.
  await admin.saveCustomProvider(cfg, { ...bare, id: row.id, models: [] });
  assert.equal(stored().auth, 'none');
  await admin.saveCustomProvider(cfg, { ...bare, schemaVersion: 2, id: row.id, auth: 'key', apiKey: 'sk-new-123456' });
  assert.equal(stored().auth, 'key');
  assert.equal(secrets.get(`agent.${row.id}.apiKey`), 'sk-new-123456');
});

test('the setup row is the v2 view: auth, discovery, overrides and offline effective rows', async () => {
  const cfg = makeCfg();
  const legacyId = 'custom-22222222-2222-3333-4444-555555555555';
  cfg.saveConfig({
    providers: {
      [legacyId]: {
        type: 'custom',
        name: 'Old',
        protocol: 'openai-chat',
        baseURL: input.baseURL,
        models: [{ id: 'm1', contextWindow: 8000 }],
      },
    },
  });
  const [row] = (await admin.providerSetup(cfg.peek(), { checkSecrets: false })).api.filter((r) => r.custom);
  assert.equal(row.schemaVersion, 2);
  assert.equal(row.auth, 'key');
  assert.deepEqual(row.discovery, { newModelsHidden: true });
  assert.deepEqual(row.modelOverrides, { m1: { manual: true, hidden: false, contextWindow: 8000 } });
  assert.deepEqual(
    row.models.map((m) => [m.id, m.manual, m.hidden, m.contextWindow]),
    [['m1', true, false, 8000]]
  );
});

test('discovery that fails but keeps manual rows reports both', async () => {
  const cfg = makeCfg();
  behavior = { listModels: async () => [{ id: 'man', manual: true }] };
  assert.equal((await admin.discoverCustomProviderModels(cfg, v2Input)).error, undefined);
  behavior = {
    listModels: async () => [{ id: 'man', manual: true }],
    discoveryError: Object.assign(new Error(`models 503 ${v2Input.apiKey}`), { status: 503 }),
  };
  const result = await admin.discoverCustomProviderModels(cfg, v2Input);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['man']
  );
  assert.equal(result.error.kind, 'request');
  assert.equal(result.error.status, 503);
  assert.equal(result.error.message.includes(v2Input.apiKey), false);
});

test('discovery returns hidden rows with reasoning fields and a sanitized error on failure', async () => {
  const cfg = makeCfg();
  const reasoning = {
    supportsReasoning: true,
    reasoningOptions: ['low'],
    reasoningLevels: ['low'],
    customReasoning: { wireFormat: 'deepseek', wireValues: { low: 'l' }, replay: true },
    reasoningContentField: 'reasoning_content',
  };
  behavior = { listModels: async () => [{ id: 'h', hidden: true, manual: true, ...reasoning }] };
  assert.deepEqual((await admin.discoverCustomProviderModels(cfg, v2Input)).models, [
    { id: 'h', hidden: true, manual: true, ...reasoning },
  ]);
  behavior = {
    listModels: async () => {
      throw Object.assign(new Error(`401 ${v2Input.apiKey}`), { status: 401 });
    },
  };
  const failed = await admin.discoverCustomProviderModels(cfg, v2Input);
  assert.deepEqual(failed.models, []);
  assert.equal(failed.error.kind, 'authentication');
  assert.equal(failed.error.message.includes(v2Input.apiKey), false);
});

test('model preferences: built-in visibility and favorites land in modelSettings beside saved tuning', async () => {
  const cfg = makeCfg();
  const full = cfg.loadConfig();
  cfg.saveConfig({ ...full, modelSettings: { 'openai/gpt-5.4': { effort: 'high' } } });
  admin.saveModelPreferences(cfg, 'openai', [
    { model: 'gpt-5.4', hidden: true, favorite: true },
    { model: 'gpt-4o', hidden: false },
  ]);
  assert.deepEqual(cfg.peek().modelSettings, {
    'openai/gpt-5.4': { effort: 'high', hidden: true, favorite: true },
    'openai/gpt-4o': { hidden: false },
  });
  admin.saveModelPreferences(cfg, 'openai', [{ model: 'gpt-5.4', favorite: false }]);
  assert.deepEqual(cfg.peek().modelSettings['openai/gpt-5.4'], { effort: 'high', hidden: true });
  assert.throws(() => admin.saveModelPreferences(cfg, 'nope', []), /unknown provider/);
  assert.throws(() => admin.saveModelPreferences(cfg, 'openai', [{ model: 'm', bogus: 1 }]), /unsupported/);
  assert.throws(() => admin.saveModelPreferences(cfg, 'openai', [{ model: 'm', hidden: 'yes' }]), /hidden/);
});

test("model preferences: a custom provider's visibility stays in its own hidden overrides", async () => {
  const cfg = makeCfg();
  const { id } = await admin.saveCustomProvider(cfg, v2Input);
  const before = structuredClone(cfg.peek().providers[id].modelOverrides);
  const result = admin.saveModelPreferences(cfg, id, [
    { model: 'vendor/m', hidden: true, favorite: true },
    { model: 'found', hidden: false },
  ]);
  assert.equal(result.customCatalogChanged, true);
  const overrides = cfg.peek().providers[id].modelOverrides;
  assert.deepEqual(overrides['vendor/m'], { ...before['vendor/m'], hidden: true });
  assert.deepEqual(overrides.found, { hidden: false });
  // The favorite is shared per-model state; visibility is not duplicated there.
  assert.deepEqual(cfg.peek().modelSettings, { [`${id}/vendor/m`]: { favorite: true } });
});
