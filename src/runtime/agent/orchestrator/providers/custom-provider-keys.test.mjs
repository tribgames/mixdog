import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

// Roster writes lock the file to its owner (icacls on Windows); ACLs have their own suite.
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
// Additional keys come from the keychain; here from this map (key id -> value).
const storedKeys = new Map();
mock.module(new URL('../../../shared/custom-provider-keys.mjs', import.meta.url).href, {
  namedExports: {
    customProviderKeyAccount: (providerId, keyId) => `agent.${providerId}.apiKey.${keyId}`,
    readCustomProviderKey: (_providerId, keyId) => storedKeys.get(keyId) || '',
  },
});

// Every state-file read, to prove a single-key send never reads the key roster.
const stateReads = [];
const atomicFile = await import('../../../shared/atomic-file.mjs');
mock.module(new URL('../../../shared/atomic-file.mjs', import.meta.url).href, {
  namedExports: {
    ...atomicFile,
    readJsonStateSync: (path, ...rest) => {
      stateReads.push(String(path));
      return atomicFile.readJsonStateSync(path, ...rest);
    },
  },
});

const dataDir = makeTempDirSync('custom-provider-keys');
process.env.MIXDOG_DATA_DIR = dataDir;
// Hermetic model catalogs: remote fetches 404 below and fall back to these.
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));

// Every request of the endpoint, by the key it carried. The SDK clients bind
// fetch when they are built, so the stub is in place before any provider.
const served = [];
const teams = [];
let respond = () => new Response('{}', { status: 500 });
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://keys.example.com')) return new Response('{}', { status: 404 });
  const key = String(new Headers(init.headers).get('authorization') || '').replace(/^Bearer /, '');
  served.push(key);
  teams.push(new Headers(init.headers).get('x-team'));
  return respond(key);
};

const { newProviderAccountId, readProviderAccountPool, setCustomProviderKeyIds, providerAccountBlockedUntil } =
  await import('../../../shared/provider-accounts.mjs');
const { createCustomKeyPoolProvider } = await import('./account-pool.mjs');
const { initProviders, getProvider } = await import('./registry.mjs');

const prompt = [{ role: 'user', content: 'hello' }];
const custom = (apiKey) => ({
  type: 'custom',
  name: 'Keys',
  protocol: 'openai-chat',
  baseURL: 'https://keys.example.com/v1',
  enabled: true,
  apiKey,
  preconnect: false,
  models: [{ id: 'm1' }],
});

function answer(text) {
  const chunk = { id: 'c1', model: 'm1', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function quotaRefusal() {
  const error = { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' };
  return new Response(JSON.stringify({ error }), { status: 429, headers: { 'content-type': 'application/json' } });
}

const quotaError = () => Object.assign(new Error('Quota exhausted'), { code: 'usage_limit_reached', status: 429 });

// A registered custom provider whose primary key is `primary` and whose
// additional keys are `extra`, in order.
async function keyedProvider(id, primary, extra = []) {
  const ids = extra.map((value) => {
    const keyId = newProviderAccountId();
    storedKeys.set(keyId, value);
    return keyId;
  });
  await setCustomProviderKeyIds(id, ids);
  const { models: _legacy, ...settings } = custom(primary);
  const v2 = { ...settings, schemaVersion: 2, modelOverrides: { m1: { manual: true } }, headers: { 'X-Team': 'blue' } };
  await initProviders({ [id]: v2 });
  return { provider: getProvider(id), ids };
}

test('two keys on one endpoint: the first key refuses on quota and the second answers', async () => {
  const id = 'custom-keys-switch';
  const { provider, ids } = await keyedProvider(id, 'sk-first', ['sk-second']);
  respond = (key) => (key === 'sk-first' ? quotaRefusal() : answer('from second'));
  served.length = 0;
  teams.length = 0;
  const result = await provider.send(prompt, 'm1', [], {});
  assert.equal(result.content, 'from second');
  assert.deepEqual(served, ['sk-first', 'sk-second']);
  // Every key carries the provider's HTTP headers.
  assert.deepEqual(teams, ['blue', 'blue']);
  const pool = readProviderAccountPool(id);
  // The refused key cools down; the serving key becomes the provider's key of record.
  assert.equal(pool.selectedId, ids[0]);
  const first = pool.accounts.find((row) => row.id === 'default');
  assert.ok(providerAccountBlockedUntil(first, 'm1') > Date.now());
  assert.equal(first.blockedQuota, true);
  served.length = 0;
  assert.equal((await provider.send(prompt, 'm1', [], {})).content, 'from second');
  assert.deepEqual(served, ['sk-second']);
});

test('every key exhausted: the send ends with the quota error after one try per key', async () => {
  const id = 'custom-keys-exhausted';
  const { provider } = await keyedProvider(id, 'sk-a', ['sk-b', 'sk-c']);
  respond = () => quotaRefusal();
  served.length = 0;
  await assert.rejects(provider.send(prompt, 'm1', [], {}), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.quotaExhausted.provider, id);
    return true;
  });
  assert.deepEqual(served, ['sk-a', 'sk-b', 'sk-c']);
  // With every key cooling down, the next send refuses without a request.
  served.length = 0;
  await assert.rejects(provider.send(prompt, 'm1', [], {}), (error) => Boolean(error.quotaExhausted));
  assert.deepEqual(served, []);
});

test('a single-key provider sends as before and stores no roster', async () => {
  const id = 'custom-keys-single';
  await initProviders({ [id]: custom('sk-solo') });
  respond = () => answer('solo');
  served.length = 0;
  stateReads.length = 0;
  assert.equal((await getProvider(id).send(prompt, 'm1', [], {})).content, 'solo');
  assert.deepEqual(
    stateReads.filter((path) => path.endsWith('provider-accounts.json')),
    [],
    'a single-key send reads no key roster'
  );
  respond = () => quotaRefusal();
  await assert.rejects(getProvider(id).send(prompt, 'm1', [], {}), (error) => error.status === 429);
  assert.deepEqual(served, ['sk-solo', 'sk-solo']);
  assert.deepEqual(readProviderAccountPool(id).accounts, []);
  // A key added while live: the next init of the same config rebuilds it with the key pool.
  const keyId = newProviderAccountId();
  storedKeys.set(keyId, 'sk-added');
  await setCustomProviderKeyIds(id, [keyId]);
  await initProviders({ [id]: custom('sk-solo') });
  respond = (key) => (key === 'sk-solo' ? quotaRefusal() : answer('added'));
  served.length = 0;
  assert.equal((await getProvider(id).send(prompt, 'm1', [], {})).content, 'added');
  assert.deepEqual(served, ['sk-solo', 'sk-added']);
  // And removed again: back to the primary alone.
  await setCustomProviderKeyIds(id, []);
  await initProviders({ [id]: custom('sk-solo') });
  served.length = 0;
  await assert.rejects(getProvider(id).send(prompt, 'm1', [], {}), (error) => error.status === 429);
  assert.deepEqual(served, ['sk-solo']);
});

test('a single-key pool hands the primary the very request', async () => {
  const seen = [];
  const primary = {
    async send(...args) {
      seen.push(args);
      return { content: 'ok' };
    },
  };
  const pooled = createCustomKeyPoolProvider('custom-keys-plain', primary, () => assert.fail('no additional key'));
  const messages = [{ role: 'assistant', content: 'x', reasoning: 'r' }];
  const options = { sessionId: 's1' };
  await pooled.send(messages, 'm1', [], options);
  assert.equal(seen[0][0], messages);
  assert.equal(seen[0][3], options);
  // Everything but send is the primary's own.
  pooled.marker = 1;
  assert.equal(primary.marker, 1);
});

test('output already emitted on a refused key is never replayed on the next key', async () => {
  const id = 'custom-keys-partial';
  const keyId = newProviderAccountId();
  await setCustomProviderKeyIds(id, [keyId]);
  const calls = [];
  const primary = {
    async send(_messages, _model, _tools, options) {
      calls.push('primary');
      options.onTextDelta('partial');
      throw quotaError();
    },
  };
  const pooled = createCustomKeyPoolProvider(id, primary, () => ({
    async send() {
      calls.push('additional');
      return { content: 'replayed' };
    },
  }));
  await assert.rejects(pooled.send(prompt, 'm1', [], { onTextDelta() {} }), /Quota exhausted/);
  assert.deepEqual(calls, ['primary']);
});

test("a key's history keeps its reasoning; another key gets it without", async () => {
  const id = 'custom-keys-history';
  const keyId = newProviderAccountId();
  await setCustomProviderKeyIds(id, [keyId]);
  const histories = [];
  const engine = (refuse) => ({
    async send(messages) {
      histories.push(messages);
      if (refuse) throw quotaError();
      return { content: 'ok' };
    },
  });
  const pooled = createCustomKeyPoolProvider(id, engine(true), () => engine(false));
  const messages = [{ role: 'assistant', content: 'x', reasoning: 'r' }];
  await pooled.send(messages, 'm1', [], {});
  assert.equal(histories[0][0].reasoning, 'r');
  assert.equal(histories[1][0].reasoning, undefined);
});
