import assert from 'node:assert/strict';
import http from 'node:http';
import test, { mock, after } from 'node:test';

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
after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
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

const markers = { 'openai-chat': '/v1/chat/completions', 'openai-responses': '/v1/responses', anthropic: '/v1/messages' };

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

    const saved = await admin.saveCustomProvider(cfg, { ...input, models: [{ id: MODEL, contextWindow: 8000, maxOutputTokens: 500 }] });
    assert.deepEqual(cfg.peek().providers[saved.id].models, [{ id: MODEL, contextWindow: 8000, maxOutputTokens: 500 }]);
    assert.equal(secrets.get(`agent.${saved.id}.apiKey`), KEY);

    const rows = rowsFor(cfg.peek());
    assert.deepEqual(rows.map((r) => [r.provider, r.id]), [[saved.id, MODEL]]);
    assert.equal(rows[0].contextWindow, 8000);

    requests.length = 0;
    const entry = cfg.peek().providers[saved.id];
    const provider = await createCustomProvider(saved.id, { ...entry, apiKey: secrets.get(`agent.${saved.id}.apiKey`), preconnect: false });
    await provider.send([{ role: 'user', content: 'hi' }], entry.models[0].id, [], {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, markers[protocol]);
    const auth = protocol === 'anthropic' ? requests[0].headers['x-api-key'] : requests[0].headers.authorization;
    assert.equal(auth, protocol === 'anthropic' ? KEY : `Bearer ${KEY}`);
    assert.equal(JSON.parse(requests[0].body).model, MODEL);

    requests.length = 0;
    assert.deepEqual(await admin.testCustomProvider(cfg, { ...input, id: saved.id, apiKey: '', models: entry.models }), { ok: true });
    assert.equal(requests.some((r) => r.path === '/v1/models'), false);

    admin.removeCustomProvider(cfg, saved.id);
    assert.equal(cfg.peek().providers[saved.id], undefined);
    assert.equal(secrets.has(`agent.${saved.id}.apiKey`), false);
    assert.deepEqual(rowsFor(cfg.peek()), []);
  });
}

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
