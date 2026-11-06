#!/usr/bin/env node
// Node's custom-provider admin (saveCustomProvider, saveCustomProviderKey,
// updateCustomProviderModel, removeCustomProvider in provider-admin.mjs) over one scripted
// world: a config document, an in-memory keychain and the additional-key roster. Each step
// records its result or refusal, the config after it and every secret; generated ids are
// replaced by the names bound in the steps.
//   node benchmarks/rust-core/recorders/record-custom-admin.mjs [--tree <dir>]
//
// Output: native/core/fixtures/custom-admin/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// mock.module needs the flag; run again with it when started without.
if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  const run = spawnSync(process.execPath, ['--experimental-test-module-mocks', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'custom-admin');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-custom-admin.mjs';
const href = (path) => pathToFileURL(join(tree, path)).href;
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'custom-admin-'));
process.env.CP_TEST_KEY = 'env-key-value';
mock.module(href('src/runtime/shared/file-permissions.mjs'), {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});
const secrets = new Map();
const original = await import(href('src/runtime/shared/config.mjs'));
mock.module(href('src/runtime/shared/config.mjs'), {
  namedExports: {
    ...original,
    saveSecret: (account, value) => secrets.set(account, value),
    saveSecretAsync: async (account, value) => {
      secrets.set(account, value);
    },
    deleteSecretAsync: async (account) => {
      secrets.delete(account);
    },
    hasStoredSecret: (account) => secrets.has(account),
    getAgentApiKey: (id) => secrets.get(`agent.${id}.apiKey`) || null,
  },
});
const admin = await import(href('src/session-runtime/services/provider-admin.mjs'));
const { customProviderKeyIds } = await import(href('src/runtime/shared/provider-accounts.mjs'));

const URL1 = 'http://localhost:1234/v1';
const GHOST = 'custom-00000000-0000-0000-0000-000000000000';
const base = (name, protocol = 'openai-chat', baseURL = URL1) => ({ name, protocol, baseURL });
const STEPS = [
  { op: 'save', note: 'a new provider with a key and a legacy model list', args: [{ ...base('Alpha'), apiKey: ' sk-primary-1 ', models: [{ id: 'm1' }] }], bind: { p1: 'id' } },
  { op: 'save', note: 'an edit that omits the key keeps it', args: [{ id: '$p1', ...base('Alpha'), apiKey: '' }] },
  { op: 'save', note: 'additional keys are stored in order', args: [{ id: '$p1', schemaVersion: 2, ...base('Alpha'), extraApiKeys: [{ apiKey: ' sk-extra-2 ' }, { apiKey: 'sk-extra-3' }] }], bind: { k1: 'extraApiKeys.0.id', k2: 'extraApiKeys.1.id' } },
  { op: 'save', note: 'blank rows keep a key, a typed one replaces it under a new id', args: [{ id: '$p1', schemaVersion: 2, ...base('Alpha'), extraApiKeys: [{ id: '$k2' }, { id: '$k1', apiKey: 'sk-extra-1b' }] }], bind: { k3: 'extraApiKeys.1.id' } },
  { op: 'save', note: 'an edit that omits the list keeps it', args: [{ id: '$p1', schemaVersion: 2, ...base('Alpha') }] },
  { op: 'saveKey', note: 'a replacement key', args: ['$p1', ' sk-new-key '] },
  { op: 'saveKey', note: 'a blank key', args: ['$p1', '  '] },
  { op: 'saveKey', note: 'a key that is not a string', args: ['$p1', 5] },
  { op: 'save', note: 'a keyless provider', args: [{ ...base('Keyless', 'anthropic', 'https://api.example.com/v1/'), auth: 'none' }], bind: { p2: 'id' } },
  { op: 'saveKey', note: 'a key for a keyless provider', args: ['$p2', 'sk-x'] },
  { op: 'save', note: 'switching to keyless drops the additional keys', args: [{ id: '$p1', schemaVersion: 2, ...base('Alpha'), auth: 'none' }] },
  { op: 'save', note: 'a provider reading its key from the environment', args: [{ ...base('Env', 'openai-responses', 'https://api.example.com/v1'), apiKeyEnv: 'CP_TEST_KEY' }], bind: { p3: 'id' } },
  { op: 'saveKey', note: 'a key for an environment provider', args: ['$p3', 'sk-x'] },
  { op: 'save', note: 'no key at all', args: [base('NoKey', 'openai-chat', 'https://x.example.com/v1')] },
  { op: 'save', note: 'an id that is not a generated one', args: [{ id: 'nope', ...base('X'), apiKey: 'k' }] },
  { op: 'save', note: 'an id that is not saved', args: [{ id: GHOST, ...base('X'), apiKey: 'k' }] },
  { op: 'save', note: 'a key and an environment variable', args: [{ ...base('Both'), apiKey: 'k', apiKeyEnv: 'CP_TEST_KEY' }] },
  { op: 'save', note: 'additional keys that are not a list', args: [{ ...base('Odd'), apiKey: 'k', extraApiKeys: 'x' }] },
  { op: 'save', note: 'an additional key that is no longer saved', args: [{ id: '$p3', schemaVersion: 2, ...base('Env', 'openai-responses', 'https://api.example.com/v1'), apiKeyEnv: 'CP_TEST_KEY', extraApiKeys: [{ id: '11111111-1111-1111-1111-111111111111' }] }] },
  { op: 'save', note: 'a config the normalizer refuses', args: [{ ...base('Bad', 'grpc'), apiKey: 'k' }] },
  { op: 'save', note: 'a failed save puts the saved key back', args: [{ id: '$p3', schemaVersion: 2, ...base('Env', 'grpc') }] },
  { op: 'updateModel', note: 'a manual model', args: ['$p1', 'm1', { manual: true, name: 'M One', contextWindow: 8000 }] },
  { op: 'updateModel', note: 'reasoning levels and wire values', args: ['$p1', 'm1', { reasoning: { levels: ['low', 'high'], wireValues: { low: 'lo' }, wireFormat: 'vllm' } }] },
  { op: 'updateModel', note: 'new levels retire the wire values of the levels they drop', args: ['$p1', 'm1', { reasoning: { levels: ['high'] } }] },
  { op: 'updateModel', note: 'clearing the last level', args: ['$p1', 'm1', { reasoning: { levels: [] } }] },
  { op: 'updateModel', note: 'reasoning null clears it', args: ['$p1', 'm1', { reasoning: null }] },
  { op: 'updateModel', note: 'null deletes a property', args: ['$p1', 'm1', { name: null, contextWindow: null }] },
  { op: 'updateModel', note: 'an unsupported field', args: ['$p1', 'm1', { bogus: 1 }] },
  { op: 'updateModel', note: 'a bad reasoning level', args: ['$p1', 'm1', { reasoning: { levels: ['loud'] } }] },
  { op: 'updateModel', note: 'a bad value', args: ['$p1', 'm1', { hidden: 'x' }] },
  { op: 'updateModel', note: 'a patch that is not an object', args: ['$p1', 'm1', [1]] },
  { op: 'updateModel', note: 'an absent patch', args: ['$p1', 'm1'] },
  { op: 'updateModel', note: 'a blank model id', args: ['$p1', '  ', {}] },
  { op: 'updateModel', note: 'an unknown provider', args: [GHOST, 'm1', {}] },
  { op: 'updateModel', note: 'request fields', args: ['$p1', 'm2', { manual: true, requestBody: { top_k: 3 }, requestHeaders: { 'X-M': 'v' } }] },
  { op: 'updateModel', note: 'null removes the override', args: ['$p1', 'm1', null] },
  { op: 'config', note: 'references to the provider', patch: { modelSettings: { '$p1/m1': { favorite: true }, 'openai/x': { favorite: true } }, agents: { a1: { provider: '$p1', model: 'm' }, a2: { provider: 'openai', model: 'x' } }, webSearchRoute: { provider: '$p1', model: 'm' }, presets: [{ id: 'pr1', provider: '$p1', model: 'm' }, { id: 'pr2', provider: 'openai', model: 'y' }], default: 'pr1' } },
  { op: 'remove', note: 'a provider with references and keys', args: ['$p1'] },
  { op: 'remove', note: 'the same provider again', args: ['$p1'] },
  { op: 'remove', note: 'an id that is not a provider', args: ['bad id'] },
  { op: 'remove', note: 'a keyless provider', args: ['$p2'] },
];

let config = { providers: {}, modelSettings: {} };
const cfg = {
  loadConfig: () => structuredClone(config),
  saveConfig: (next) => {
    config = structuredClone(next);
  },
};
const names = {};
const fill = (value, direction) => {
  let text = JSON.stringify(value);
  for (const [name, real] of Object.entries(names)) text = text.split(direction === 'in' ? `$${name}` : real).join(direction === 'in' ? real : `$${name}`);
  return JSON.parse(text);
};
const pick = (value, path) => path.split('.').reduce((at, key) => at?.[key], value);

const out = [];
for (const step of STEPS) {
  const args = fill(step.args ?? step.patch, 'in');
  let result = null;
  let error = null;
  if (step.op === 'config') config = { ...config, ...args };
  else {
    try {
      result = await (
        { save: admin.saveCustomProvider, saveKey: admin.saveCustomProviderKey, updateModel: admin.updateCustomProviderModel, remove: admin.removeCustomProvider }[step.op]
      )(cfg, ...args);
    } catch (thrown) {
      error = thrown.message;
    }
  }
  for (const [name, path] of Object.entries(step.bind ?? {})) names[name] = pick(result, path);
  const ids = Object.keys(config.providers);
  out.push({
    op: step.op,
    note: step.note,
    args: step.args ?? step.patch,
    bind: step.bind ?? null,
    result: result === null ? null : fill(result, 'out'),
    error: error === null ? null : fill(error, 'out'),
    config: fill(config, 'out'),
    secrets: fill(Object.fromEntries([...secrets.entries()].sort(([a], [b]) => a.localeCompare(b))), 'out'),
    roster: Object.fromEntries(ids.map((id) => [id, customProviderKeyIds(id)]).map(([id, keys]) => [fill(id, 'out'), fill(keys, 'out')])),
  });
}
writeJson(join(stage, 'golden.json'), { env: { CP_TEST_KEY: process.env.CP_TEST_KEY }, steps: out });
writeSetManifest(stage, { set: 'custom-admin', recorder, command: 'node benchmarks/rust-core/recorders/record-custom-admin.mjs --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
