import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock, after } from 'node:test';

const secrets = new Map();
const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => secrets.set(account, value),
    deleteSecretAsync: async (account) => secrets.delete(account),
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
mock.module('../../runtime/shared/provider-api-key.mjs', {
  namedExports: { getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null },
});

const admin = await import('./provider-admin.mjs');
const { createCustomProvider } = await import('../../runtime/agent/orchestrator/providers/custom-provider.mjs');
const { createQuickProviderRows } = await import('../quick-model-rows/provider-rows.mjs');

const KEY = 'sk-integration-123456';
const MODEL = 'manual/model-1';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((e) => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join(''));
}

const REPLIES = {
  '/v1/chat/completions': (res) =>
    sse(res, [
      { id: 'c1', model: MODEL, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
      { id: 'c1', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]),
  '/v1/responses': (res) =>
    sse(res, [
      { type: 'response.output_text.delta', delta: 'OK' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: MODEL,
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        },
      },
    ]),
  '/v1/messages': (res) =>
    sse(res, [
      { type: 'message_start', message: { id: 'msg_1', model: MODEL, role: 'assistant', usage: { input_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
};

let modelsStatus = 404;
const requests = [];
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    requests.push({ method: req.method, path, headers: req.headers, body });
    if (path === '/v1/models') {
      res.writeHead(modelsStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `models ${modelsStatus}` } }));
      return;
    }
    const reply = REPLIES[path];
    if (!reply) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    reply(res);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(
  () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    })
);
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

function makeCfg() {
  let config = { providers: {} };
  return {
    loadConfig: () => structuredClone(config),
    saveConfig: (next) => {
      config = structuredClone(next);
    },
    peek: () => config,
  };
}

function rowsFor(config) {
  return createQuickProviderRows({
    getRoute: () => ({}),
    displayConfig: () => config,
    providerModelCacheRow: (provider, model) => ({ ...model, provider }),
    providerModelsFromCacheRows: (models) => models,
    modelMetaByRoute: new Map(),
    modelMetaKey: (provider, model) => `${provider}:${model}`,
  })();
}

const markers = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  anthropic: '/v1/messages',
};

for (const protocol of Object.keys(markers)) {
  test(`${protocol}: manual registration after /models 404 yields rows, works with stored key, and deletes`, async () => {
    modelsStatus = 404;
    requests.length = 0;
    const cfg = makeCfg();
    const input = { name: `Manual ${protocol}`, protocol, baseURL, apiKey: KEY, models: [] };

    const discovery = await admin.discoverCustomProviderModels(cfg, input);
    assert.deepEqual(discovery.models, []);
    assert.equal(discovery.error.kind, 'unavailable');
    assert.equal(discovery.error.status, 404);
    assert.equal(typeof discovery.error.message, 'string');
    assert.equal(discovery.error.message.includes(KEY), false);

    const failed = await admin.testCustomProvider(cfg, input);
    assert.equal(failed.ok, false);
    assert.equal(failed.phase, 'discovery');
    assert.equal(failed.error.kind, 'unavailable');

    // A legacy `models` registration is persisted as full v2 by the real normalizer.
    const saved = await admin.saveCustomProvider(cfg, {
      ...input,
      models: [{ id: MODEL, contextWindow: 8000, maxOutputTokens: 500 }],
    });
    assert.deepEqual(cfg.peek().providers[saved.id], {
      type: 'custom',
      schemaVersion: 2,
      name: input.name,
      protocol,
      baseURL,
      enabled: true,
      auth: 'key',
      discovery: { newModelsHidden: true },
      modelOverrides: { [MODEL]: { manual: true, hidden: false, contextWindow: 8000, maxOutputTokens: 500 } },
    });
    assert.equal(secrets.get(`agent.${saved.id}.apiKey`), KEY);

    const rows = rowsFor(cfg.peek());
    assert.deepEqual(
      rows.map((r) => [r.provider, r.id]),
      [[saved.id, MODEL]]
    );
    assert.equal(rows[0].contextWindow, 8000);

    requests.length = 0;
    const entry = cfg.peek().providers[saved.id];
    const provider = await createCustomProvider(saved.id, {
      ...entry,
      apiKey: secrets.get(`agent.${saved.id}.apiKey`),
      preconnect: false,
    });
    await provider.send([{ role: 'user', content: 'hi' }], MODEL, [], {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, markers[protocol]);
    const auth = protocol === 'anthropic' ? requests[0].headers['x-api-key'] : requests[0].headers.authorization;
    assert.equal(auth, protocol === 'anthropic' ? KEY : `Bearer ${KEY}`);
    assert.equal(JSON.parse(requests[0].body).model, MODEL);

    // An edit-time test without overrides uses the stored first visible manual model, no discovery.
    requests.length = 0;
    const edit = { id: saved.id, schemaVersion: 2, name: input.name, protocol, baseURL, apiKey: '' };
    assert.deepEqual(await admin.testCustomProvider(cfg, edit), { ok: true });
    assert.equal(
      requests.some((r) => r.path === '/v1/models'),
      false
    );
    assert.equal(JSON.parse(requests.at(-1).body).model, MODEL);

    // Keyless: saving without `auth` keeps it, and sends carry no credential header.
    await admin.saveCustomProvider(cfg, { ...edit, auth: 'none' });
    await admin.saveCustomProvider(cfg, { ...edit, name: 'Renamed' });
    const keyless = cfg.peek().providers[saved.id];
    assert.equal(keyless.auth, 'none');
    assert.deepEqual(keyless.modelOverrides, entry.modelOverrides);
    requests.length = 0;
    const local = await createCustomProvider(saved.id, { ...keyless, preconnect: false });
    await local.send([{ role: 'user', content: 'hi' }], MODEL, [], {});
    assert.equal(requests[0].path, markers[protocol]);
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['x-api-key'], undefined);
    // auth 'none' is authoritative: an injected key (stale keychain / hand
    // edit) still sends no credential header.
    requests.length = 0;
    const injected = await createCustomProvider(saved.id, { ...keyless, apiKey: KEY, preconnect: false });
    await injected.send([{ role: 'user', content: 'hi' }], MODEL, [], {});
    assert.equal(requests[0].path, markers[protocol]);
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].headers['x-api-key'], undefined);
    assert.equal(JSON.stringify(requests[0].headers).includes(KEY), false);

    await admin.removeCustomProvider(cfg, saved.id);
    assert.equal(cfg.peek().providers[saved.id], undefined);
    assert.equal(secrets.has(`agent.${saved.id}.apiKey`), false);
    assert.deepEqual(rowsFor(cfg.peek()), []);
  });
}

test('changing levels prunes wire values (clearing the last level included) through the real normalizer', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, {
    schemaVersion: 2,
    name: 'Levels',
    protocol: 'openai-chat',
    baseURL,
    auth: 'none',
    modelOverrides: {
      [MODEL]: {
        manual: true,
        reasoning: { levels: ['low', 'high'], wireValues: { low: 'L', high: 'H' }, replay: true },
      },
    },
  });
  let row = await admin.updateCustomProviderModel(cfg, saved.id, MODEL, { reasoning: { levels: ['ultra', 'low'] } });
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides[MODEL].reasoning, {
    levels: ['low', 'max'],
    wireValues: { low: 'L' },
    replay: true,
  });
  row = await admin.updateCustomProviderModel(cfg, saved.id, MODEL, { reasoning: { levels: [] } });
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides[MODEL], {
    manual: true,
    reasoning: { levels: [], replay: true },
  });
  assert.deepEqual(row.models[0].reasoningLevels, []);
  // Wire values sent with the levels are pruned too; levels left alone keep them.
  await admin.updateCustomProviderModel(cfg, saved.id, MODEL, {
    reasoning: { levels: ['medium'], wireValues: { medium: 'M', high: 'H' } },
  });
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides[MODEL].reasoning.wireValues, { medium: 'M' });
  await admin.updateCustomProviderModel(cfg, saved.id, MODEL, { reasoning: { replay: false } });
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides[MODEL].reasoning.wireValues, { medium: 'M' });
});

test('malformed supplied wire values are rejected before pruning (real service + normalizer)', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, {
    schemaVersion: 2,
    name: 'Strict patch',
    protocol: 'openai-chat',
    baseURL,
    auth: 'none',
    modelOverrides: { [MODEL]: { manual: true, reasoning: { levels: ['low', 'high'], wireValues: { low: 'L' } } } },
  });
  const before = structuredClone(cfg.peek().providers[saved.id]);
  for (const reasoning of [
    { levels: ['low'], wireValues: [] },
    { levels: ['low'], wireValues: 'low=L' },
    { levels: ['low'], wireValues: { bogus: 'x' } },
    { levels: ['low'], wireValues: { high: 1 } },
    { levels: ['low'], wireValues: { high: '  ' } },
    { levels: ['low'], wireValues: { high: 'h'.repeat(65) } },
    { levels: ['low'], wireValues: { max: 'a', ultra: 'b' } },
    { levels: ['turbo'], wireValues: { low: 'L' } },
    { levels: 'low' },
    { wireFormat: 7 },
    { replay: 'yes' },
    { extra: 1 },
  ]) {
    await assert.rejects(
      admin.updateCustomProviderModel(cfg, saved.id, MODEL, { reasoning }),
      undefined,
      JSON.stringify(reasoning)
    );
  }
  assert.deepEqual(cfg.peek().providers[saved.id], before);
  // A well-formed mapping for a valid level that the new levels no longer list is pruned.
  await admin.updateCustomProviderModel(cfg, saved.id, MODEL, {
    reasoning: { levels: ['low'], wireValues: { low: 'L2', high: 'H' } },
  });
  assert.deepEqual(cfg.peek().providers[saved.id].modelOverrides[MODEL].reasoning, {
    levels: ['low'],
    wireValues: { low: 'L2' },
  });
});

test('a stored custom provider that does not normalize reports an explicit configuration error', async () => {
  const id = 'custom-6f1c2b7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
  const config = {
    providers: {
      [id]: {
        type: 'custom',
        schemaVersion: 2,
        name: 'Broken',
        protocol: 'openai-chat',
        baseURL,
        enabled: true,
        auth: 'none',
        modelOverrides: { ok: { manual: true }, broken: { contextWindow: '4096' } },
      },
    },
  };
  const setup = await admin.providerSetup(config, { checkSecrets: false });
  const row = setup.api.find((r) => r.id === id);
  assert.match(row.configError, /modelOverrides\[broken\]\.contextWindow/);
  assert.equal(row.status, 'Invalid config');
  assert.equal(row.detail, row.configError);
  // Overrides are shown as stored (nothing silently dropped), and no runnable models.
  assert.deepEqual(row.modelOverrides, config.providers[id].modelOverrides);
  assert.deepEqual(row.models, []);
  assert.equal(row.auth, 'none');
});

test('setup rows and discovery rows share the maxOutputTokens field name', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, {
    schemaVersion: 2,
    name: 'Fields',
    protocol: 'openai-chat',
    baseURL,
    auth: 'none',
    modelOverrides: { [MODEL]: { manual: true, contextWindow: 9000, maxOutputTokens: 700 } },
  });
  assert.equal(saved.models[0].maxOutputTokens, 700);
  assert.equal('outputTokens' in saved.models[0], false);
  modelsStatus = 404;
  const discovered = await admin.discoverCustomProviderModels(cfg, {
    id: saved.id,
    schemaVersion: 2,
    name: 'Fields',
    protocol: 'openai-chat',
    baseURL,
  });
  assert.equal(discovered.models[0].maxOutputTokens, 700);
  assert.equal('outputTokens' in discovered.models[0], false);
});

test('discovery failure kinds: 401/403 are authentication, server/network are request', async () => {
  const cfg = makeCfg();
  const input = { name: 'Kinds', protocol: 'openai-chat', baseURL, apiKey: KEY, models: [] };
  for (const status of [401, 403]) {
    modelsStatus = status;
    const result = await admin.discoverCustomProviderModels(cfg, input);
    assert.deepEqual(result.models, []);
    assert.equal(result.error.kind, 'authentication');
    assert.equal(result.error.status, status);
    const tested = await admin.testCustomProvider(cfg, input);
    assert.equal(tested.ok, false);
    assert.equal(tested.phase, 'discovery');
    assert.equal(tested.error.kind, 'authentication');
  }
  modelsStatus = 500;
  const server500 = await admin.discoverCustomProviderModels(cfg, input);
  assert.equal(server500.error.kind, 'request');
  assert.notEqual(server500.error.kind, 'unavailable');

  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const deadURL = `http://127.0.0.1:${dead.address().port}/v1`;
  await new Promise((resolve) => dead.close(resolve));
  const network = await admin.discoverCustomProviderModels(cfg, { ...input, baseURL: deadURL });
  assert.deepEqual(network.models, []);
  assert.equal(network.error.kind, 'request');
  const networkTest = await admin.testCustomProvider(cfg, { ...input, baseURL: deadURL });
  assert.equal(networkTest.ok, false);
  assert.equal(networkTest.phase, 'discovery');
  assert.equal(networkTest.error.kind, 'request');
});
