// A custom provider save racing other edits of the same provider: the settings
// an edit omits come from the config it commits over, and one provider's key
// transactions never overlap, so a failed save cannot roll back a newer key.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';

// Event-loop turns enough for an unblocked save to finish (no real I/O here).
async function settle() {
  for (let i = 0; i < 20; i += 1) await setImmediate();
}

const secrets = new Map();
// account -> { reached, release }: the next write of that account waits.
const gates = new Map();
const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => {
      const gate = gates.get(account);
      if (gate) {
        gates.delete(account);
        gate.reached.resolve();
        await gate.release.promise;
      }
      secrets.set(account, value);
    },
    deleteSecretAsync: async (account) => secrets.delete(account),
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
const originalApiKey = await import('../../runtime/shared/provider-api-key.mjs');
mock.module('../../runtime/shared/provider-api-key.mjs', {
  namedExports: {
    ...originalApiKey,
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
    hasAgentApiKey: (id) => secrets.has(`agent.${id}.apiKey`),
  },
});

const admin = await import('./provider-admin.mjs');

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

// The same store, refusing every config write.
const refusing = (cfg) => ({
  ...cfg,
  saveConfig() {
    throw new Error('config write refused');
  },
});

const baseURL = 'http://localhost:1234/v1';
const keyOf = (id) => secrets.get(`agent.${id}.apiKey`);

async function register(cfg, extra = {}) {
  const row = await admin.saveCustomProvider(cfg, {
    schemaVersion: 2,
    name: 'Before',
    protocol: 'openai-chat',
    baseURL,
    apiKey: 'key-initial',
    modelOverrides: { m: { manual: true, hidden: false } },
    ...extra,
  });
  return row.id;
}

const edit = (id, extra = {}) => ({ id, schemaVersion: 2, name: 'After', protocol: 'openai-chat', baseURL, ...extra });

// Holds the next key write of `id` until the returned release runs.
function holdKeyWrite(id) {
  const gate = { reached: Promise.withResolvers(), release: Promise.withResolvers() };
  gates.set(`agent.${id}.apiKey`, gate);
  return { reached: gate.reached.promise, release: () => gate.release.resolve() };
}

test('an edit omitting model overrides keeps a model change made during its key write', async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const saving = admin.saveCustomProvider(cfg, edit(id, { apiKey: 'key-new' }));
  await hold.reached;
  await admin.updateCustomProviderModel(cfg, id, 'm', { hidden: true });
  await admin.updateCustomProviderModel(cfg, id, 'added', { manual: true, hidden: false });
  hold.release();
  const row = await saving;
  const expected = { m: { manual: true, hidden: true }, added: { manual: true, hidden: false } };
  assert.equal(cfg.peek().providers[id].name, 'After');
  assert.deepEqual(cfg.peek().providers[id].modelOverrides, expected);
  assert.deepEqual(row.modelOverrides, expected);
  assert.equal(keyOf(id), 'key-new');
});

test('an explicit empty override map still replaces a change made during the key write', async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const saving = admin.saveCustomProvider(cfg, edit(id, { apiKey: 'key-new', modelOverrides: {} }));
  await hold.reached;
  await admin.updateCustomProviderModel(cfg, id, 'm', { hidden: true });
  hold.release();
  await saving;
  assert.deepEqual(cfg.peek().providers[id].modelOverrides, {});
});

test('a save never recreates a provider removed during its key write, and restores the key', async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const saving = admin.saveCustomProvider(cfg, edit(id, { apiKey: 'key-new' }));
  await hold.reached;
  const current = cfg.loadConfig();
  delete current.providers[id];
  cfg.saveConfig(current);
  hold.release();
  await assert.rejects(saving, /unknown custom provider/);
  assert.equal(cfg.peek().providers[id], undefined);
  assert.equal(keyOf(id), 'key-initial');
});

test('a keyless edit is checked against an auth mode changed to key meanwhile', async () => {
  const cfg = makeCfg();
  const id = await register(cfg, { auth: 'none', apiKey: undefined });
  const saving = admin.saveCustomProvider(cfg, edit(id));
  // Lands while the save resolves its input.
  const current = cfg.loadConfig();
  current.providers[id].auth = 'key';
  cfg.saveConfig(current);
  await assert.rejects(saving, /API key is required/);
  assert.equal(cfg.peek().providers[id].name, 'Before');
});

test("a failed save cannot roll back a later save's key", async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const failing = admin.saveCustomProvider(refusing(cfg), edit(id, { apiKey: 'key-failed' }));
  await hold.reached;
  const later = admin.saveCustomProvider(cfg, edit(id, { name: 'Later', apiKey: 'key-later' }));
  // Unserialized, the later save would write its key and commit right here.
  await settle();
  hold.release();
  await assert.rejects(failing, /config write refused/);
  await later;
  assert.equal(cfg.peek().providers[id].name, 'Later');
  assert.equal(keyOf(id), 'key-later');
});

test('a failed save restores the key the preceding save committed', async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const committed = admin.saveCustomProvider(cfg, edit(id, { apiKey: 'key-committed' }));
  await hold.reached;
  const failing = admin.saveCustomProvider(refusing(cfg), edit(id, { apiKey: 'key-failed' }));
  await settle();
  hold.release();
  await committed;
  await assert.rejects(failing, /config write refused/);
  assert.equal(keyOf(id), 'key-committed');
});

test("a pending key write never holds up another provider's save", async () => {
  const cfg = makeCfg();
  const id = await register(cfg);
  const hold = holdKeyWrite(id);
  const saving = admin.saveCustomProvider(cfg, edit(id, { apiKey: 'key-new' }));
  await hold.reached;
  const other = await register(cfg, { name: 'Other', apiKey: 'key-other' });
  assert.equal(cfg.peek().providers[other].name, 'Other');
  assert.equal(keyOf(other), 'key-other');
  hold.release();
  await saving;
  assert.equal(keyOf(id), 'key-new');
});
