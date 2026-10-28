// Custom provider HTTP headers through the real setup service, normalizer and
// engines against a local server: saved, kept on edit, cleared with {}, and
// sent by discovery, connection tests and inference for every protocol.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

// Hermetic model catalog: discovery enrichment reads this disk copy, not the network.
const dataDir = makeTempDirSync('custom-provider-headers');
process.env.MIXDOG_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

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
  namedExports: {
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
    hasAgentApiKey: (id) => secrets.has(`agent.${id}.apiKey`),
    agentApiKeyEnvName: () => null,
    resolveProviderApiKey: (id, config) => config?.apiKey || secrets.get(`agent.${id}.apiKey`) || '',
    reloadProviderApiKey: (id, config) => secrets.get(`agent.${id}.apiKey`) || config?.apiKey || '',
  },
});

const admin = await import('./provider-admin.mjs');
const { createCustomProvider } = await import('../../runtime/agent/orchestrator/providers/custom-provider.mjs');

const KEY = 'sk-headers-123456';
const MODEL = 'found/model-a';

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

const requests = [];
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  req.resume();
  req.on('end', () => {
    requests.push({ path, headers: req.headers });
    if (path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }] }));
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

const HEADERS = { originator: 'codex_cli_rs', 'X-Team': 'blue' };
const markers = {
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  anthropic: '/v1/messages',
};

for (const protocol of Object.keys(markers)) {
  test(`${protocol}: headers are saved, kept on edit, cleared with {}, and sent on every request`, async () => {
    const cfg = makeCfg();
    const input = { schemaVersion: 2, name: `Headers ${protocol}`, protocol, baseURL, apiKey: KEY, headers: HEADERS };
    // Only the model list and the protocol's inference path; a preconnect probe may add others.
    const sent = () => requests.filter((r) => r.path === '/v1/models' || r.path === markers[protocol]);
    const assertSent = (paths, expected) => {
      assert.deepEqual(
        sent().map((r) => r.path),
        paths
      );
      for (const request of sent()) {
        assert.equal(request.headers.originator, expected ? 'codex_cli_rs' : undefined, request.path);
        assert.equal(request.headers['x-team'], expected ? 'blue' : undefined, request.path);
      }
    };

    // Discovery carries them.
    requests.length = 0;
    const discovery = await admin.discoverCustomProviderModels(cfg, input);
    assert.deepEqual(
      discovery.models.map((m) => m.id),
      [MODEL]
    );
    assertSent(['/v1/models'], true);

    // Test connection: discovery of the model, then the inference request.
    requests.length = 0;
    assert.deepEqual(await admin.testCustomProvider(cfg, input), { ok: true });
    assertSent(['/v1/models', markers[protocol]], true);

    // Saving keeps them, in the stored entry and in the setup row.
    const saved = await admin.saveCustomProvider(cfg, input);
    assert.deepEqual(cfg.peek().providers[saved.id].headers, HEADERS);
    assert.deepEqual(saved.headers, HEADERS);
    assert.equal(secrets.get(`agent.${saved.id}.apiKey`), KEY);
    const [row] = (await admin.providerSetup(cfg.peek(), { checkSecrets: false })).api.filter((r) => r.custom);
    assert.deepEqual(row.headers, HEADERS);

    // The stored provider sends them on inference.
    requests.length = 0;
    const entry = cfg.peek().providers[saved.id];
    const provider = await createCustomProvider(saved.id, { ...entry, apiKey: KEY, preconnect: false });
    await provider.send([{ role: 'user', content: 'hi' }], MODEL, [], {});
    assertSent([markers[protocol]], true);

    // An edit that omits `headers` keeps them, also for its connection test.
    const edit = { id: saved.id, schemaVersion: 2, name: 'Renamed', protocol, baseURL, apiKey: '' };
    requests.length = 0;
    assert.deepEqual(await admin.testCustomProvider(cfg, edit), { ok: true });
    assertSent(['/v1/models', markers[protocol]], true);
    await admin.saveCustomProvider(cfg, edit);
    assert.equal(cfg.peek().providers[saved.id].name, 'Renamed');
    assert.deepEqual(cfg.peek().providers[saved.id].headers, HEADERS);

    // A stated object replaces them.
    await admin.saveCustomProvider(cfg, { ...edit, headers: { 'X-Other': '1' } });
    assert.deepEqual(cfg.peek().providers[saved.id].headers, { 'X-Other': '1' });

    // An empty object clears them: nothing stored, nothing sent.
    const cleared = await admin.saveCustomProvider(cfg, { ...edit, headers: {} });
    assert.equal(Object.hasOwn(cfg.peek().providers[saved.id], 'headers'), false);
    assert.equal(Object.hasOwn(cleared, 'headers'), false);
    requests.length = 0;
    assert.deepEqual(await admin.testCustomProvider(cfg, edit), { ok: true });
    assertSent(['/v1/models', markers[protocol]], false);
  });
}

test('credential headers are refused before anything is stored or sent', async () => {
  const cfg = makeCfg();
  const input = {
    schemaVersion: 2,
    name: 'Auth header',
    protocol: 'openai-chat',
    baseURL,
    apiKey: KEY,
  };
  const storedSecrets = secrets.size;
  requests.length = 0;
  for (const name of ['Authorization', 'authorization', 'X-API-Key', 'api-key']) {
    const refused = { ...input, headers: { originator: 'codex_cli_rs', [name]: 'Bearer other' } };
    const pattern = /authentication belongs to the API key field/;
    await assert.rejects(admin.saveCustomProvider(cfg, refused), pattern, name);
    await assert.rejects(admin.testCustomProvider(cfg, refused), pattern, name);
    await assert.rejects(admin.discoverCustomProviderModels(cfg, refused), pattern, name);
  }
  assert.deepEqual(cfg.peek().providers, {});
  assert.equal(secrets.size, storedSecrets);
  assert.equal(requests.length, 0);
});
