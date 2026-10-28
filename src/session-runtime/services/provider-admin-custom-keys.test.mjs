// A custom provider's additional API keys through the real setup service:
// stored as keychain secrets in use order, listed by id only, kept by a blank
// row, replaced, removed, dropped with keyless auth and with the provider.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('custom-provider-keys-admin');
mock.module(new URL('../../runtime/shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const secrets = new Map();
// The next additional-key write waits for `gate.release` (a race probe).
let gate = null;
let deleteFailure = null;
const original = await import('../../runtime/shared/config.mjs');
mock.module('../../runtime/shared/config.mjs', {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => {
      if (gate && account.includes('.apiKey.')) {
        const { reached, release } = gate;
        gate = null;
        reached();
        await release;
      }
      secrets.set(account, value);
    },
    deleteSecretAsync: async (account) => {
      if (deleteFailure) throw deleteFailure;
      secrets.delete(account);
    },
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});

const admin = await import('./provider-admin.mjs');
const { customProviderKeyIds } = await import('../../runtime/shared/provider-accounts.mjs');

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

const input = {
  name: 'Keys',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'sk-primary-1',
  models: [{ id: 'm1' }],
};
const extraValue = (id, keyId) => secrets.get(`agent.${id}.apiKey.${keyId}`);
const extraSecrets = (id) => [...secrets.keys()].filter((account) => account.startsWith(`agent.${id}.apiKey.`));

test('additional keys are saved as secrets in order, listed by id only, and kept by blank rows', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, {
    ...input,
    extraApiKeys: [{ apiKey: ' sk-extra-2 ' }, { apiKey: 'sk-extra-3' }],
  });
  const ids = customProviderKeyIds(saved.id);
  assert.equal(ids.length, 2);
  assert.deepEqual(
    saved.extraApiKeys,
    ids.map((id) => ({ id }))
  );
  assert.deepEqual(
    ids.map((keyId) => extraValue(saved.id, keyId)),
    ['sk-extra-2', 'sk-extra-3']
  );
  // Never a value in the config or the public row.
  for (const text of [JSON.stringify(cfg.peek()), JSON.stringify(saved)]) {
    assert.doesNotMatch(text, /sk-extra|sk-primary|extraApiKeys"?:\s*\[\s*\{\s*"apiKey/);
  }
  assert.equal(Object.hasOwn(cfg.peek().providers[saved.id], 'extraApiKeys'), false);

  // An edit that omits the list keeps it; blank rows keep the saved keys in the new order.
  const edit = { ...input, id: saved.id, apiKey: '' };
  assert.deepEqual((await admin.saveCustomProvider(cfg, edit)).extraApiKeys, saved.extraApiKeys);
  const reordered = await admin.saveCustomProvider(cfg, {
    ...edit,
    extraApiKeys: [{ id: ids[1] }, { id: ids[0], apiKey: '  ' }],
  });
  assert.deepEqual(customProviderKeyIds(saved.id), [ids[1], ids[0]]);
  assert.deepEqual(reordered.extraApiKeys, [{ id: ids[1] }, { id: ids[0] }]);
  assert.equal(extraSecrets(saved.id).length, 2);

  // A typed value replaces a saved key under a new id; a dropped row deletes its secret.
  await admin.saveCustomProvider(cfg, { ...edit, extraApiKeys: [{ id: ids[0], apiKey: 'sk-extra-2b' }] });
  const [replaced] = customProviderKeyIds(saved.id);
  assert.notEqual(replaced, ids[0]);
  assert.deepEqual(extraSecrets(saved.id), [`agent.${saved.id}.apiKey.${replaced}`]);
  assert.equal(extraValue(saved.id, replaced), 'sk-extra-2b');
  // A key removed meanwhile is not silently kept.
  await assert.rejects(admin.saveCustomProvider(cfg, { ...edit, extraApiKeys: [{ id: ids[1] }] }), /no longer saved/);

  // An empty list drops every additional key and the roster with it.
  const single = await admin.saveCustomProvider(cfg, { ...edit, extraApiKeys: [] });
  assert.deepEqual(customProviderKeyIds(saved.id), []);
  assert.deepEqual(extraSecrets(saved.id), []);
  assert.equal(Object.hasOwn(single, 'extraApiKeys'), false);
});

test('keyless auth and removal drop the additional keys', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, { ...input, extraApiKeys: [{ apiKey: 'sk-extra-x' }] });
  await admin.saveCustomProvider(cfg, { ...input, id: saved.id, apiKey: '', auth: 'none' });
  assert.deepEqual(customProviderKeyIds(saved.id), []);
  assert.deepEqual(extraSecrets(saved.id), []);

  const other = await admin.saveCustomProvider(cfg, { ...input, extraApiKeys: [{ apiKey: 'sk-extra-y' }] });
  await admin.removeCustomProvider(cfg, other.id);
  assert.deepEqual(customProviderKeyIds(other.id), []);
  assert.deepEqual(extraSecrets(other.id), []);
  assert.equal(secrets.has(`agent.${other.id}.apiKey`), false);
});

test('a no-auth save racing the first additional key leaves no key behind', async () => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, input);
  let reached;
  const atWrite = new Promise((resolve) => {
    reached = resolve;
  });
  let release;
  gate = { reached, release: new Promise((resolve) => (release = resolve)) };
  const edit = { ...input, id: saved.id, apiKey: '' };
  const adding = admin.saveCustomProvider(cfg, { ...edit, extraApiKeys: [{ apiKey: 'k2' }] });
  await atWrite;
  const keyless = admin.saveCustomProvider(cfg, { ...edit, auth: 'none' });
  release();
  await Promise.all([adding, keyless]);
  assert.equal(cfg.peek().providers[saved.id].auth, 'none');
  assert.deepEqual(customProviderKeyIds(saved.id), []);
  assert.deepEqual(extraSecrets(saved.id), []);
});

test('a removed key whose secret cannot be deleted is reported by ids, never by value', async (t) => {
  const cfg = makeCfg();
  const saved = await admin.saveCustomProvider(cfg, { ...input, extraApiKeys: [{ apiKey: 'sk-stuck-value' }] });
  const [keyId] = customProviderKeyIds(saved.id);
  const lines = [];
  t.mock.method(process.stderr, 'write', (chunk) => lines.push(String(chunk)) > 0);
  deleteFailure = new Error('keyring is locked');
  try {
    await admin.saveCustomProvider(cfg, { ...input, id: saved.id, apiKey: '', extraApiKeys: [] });
  } finally {
    deleteFailure = null;
  }
  assert.deepEqual(customProviderKeyIds(saved.id), []);
  const warning = lines.find((line) => line.includes(keyId));
  assert.ok(warning?.includes(saved.id) && warning.includes('keyring is locked'));
  assert.ok(!lines.join('').includes('sk-stuck-value'));
});

test('malformed additional keys are refused before the keychain', async () => {
  const cfg = makeCfg();
  const before = secrets.size;
  for (const extraApiKeys of [
    'sk',
    [{ apiKey: '' }],
    [{ apiKey: 5 }],
    [{ id: 'not-a-key-id' }],
    [{ apiKey: 'k', label: 'x' }],
    Array.from({ length: 20 }, (_, i) => ({ apiKey: `k${i}` })),
  ]) {
    await assert.rejects(admin.saveCustomProvider(cfg, { ...input, extraApiKeys }), TypeError);
  }
  assert.equal(secrets.size, before);
  assert.deepEqual(cfg.peek().providers, {});
});
