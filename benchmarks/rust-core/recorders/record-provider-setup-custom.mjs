#!/usr/bin/env node
// The custom-provider rows of the provider setup snapshot (provider-admin.mjs `customProviderRows`
// inside `providerSetup`): the real function over stored custom-provider configs, with the
// keychain, the private-file fallback, the environment and the additional-key roster seeded for
// each scenario, with and without secret checks. Each scenario records the facts the rows were
// built from (read through the same real modules) and the custom rows of the result. Rust
// `mixdog_core_domains::domains::ai_account::custom_admin::custom_provider_rows` must build the
// same rows, key order included.
//
//   node benchmarks/rust-core/recorders/record-provider-setup-custom.mjs [--tree <dir>]
//
// Output: native/core/fixtures/provider-setup-custom/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
globalThis.fetch = async () => {
  throw new Error('offline');
};
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-setup-custom');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-setup-custom.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'setup-custom-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'setup-custom-home-'));
const at = (path) => importFrom(tree, path);
// A private-file fallback is named by the scenario; the keychain itself answers as it does.
const keychainCjs = createRequire(join(tree, 'src/runtime/shared/config.mjs'))('../../lib/keychain-cjs.cjs');
const realHasFallbackSecret = keychainCjs.hasFallbackSecret;
let stubbedFallback = new Set();
keychainCjs.hasFallbackSecret = (account) => stubbedFallback.has(account) || realHasFallbackSecret(account);
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const cfg = await at('src/runtime/shared/config.mjs');
const accounts = await at('src/runtime/shared/provider-accounts.mjs');

const id = (n) => `custom-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const account = (providerId) => `agent.${providerId}.apiKey`;
const base = (over = {}) => ({
  type: 'custom',
  name: 'Alpha',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  schemaVersion: 2,
  auth: 'key',
  enabled: true,
  discovery: { newModelsHidden: false },
  modelOverrides: { m1: { hidden: false, manual: true } },
  ...over,
});
const ENV_NAMES = ['CP_SETUP_KEY', 'CP_SETUP_EMPTY'];

// stored: ids with a primary key; fallback: ids whose key is in the private file; env: variables set;
// keyIds: additional key ids per provider.
const SCENARIOS = [
  { name: 'no providers', providers: {} },
  { name: 'a keyed provider with a stored key', providers: { [id(1)]: base() }, stored: [id(1)] },
  { name: 'a stored key in the private file', providers: { [id(1)]: base() }, stored: [id(1)], fallback: [id(1)] },
  { name: 'a keyed provider with no key', providers: { [id(1)]: base() } },
  { name: 'a disabled provider with no key', providers: { [id(1)]: base({ enabled: false }) } },
  { name: 'a disabled provider with a stored key', providers: { [id(1)]: base({ enabled: false }) }, stored: [id(1)] },
  { name: 'a key from an environment variable that is set', providers: { [id(1)]: base({ apiKeyEnv: 'CP_SETUP_KEY' }) }, env: { CP_SETUP_KEY: 'v' } },
  { name: 'a key from an environment variable that is unset', providers: { [id(1)]: base({ apiKeyEnv: 'CP_SETUP_KEY' }) } },
  { name: 'an environment variable that is empty', providers: { [id(1)]: base({ apiKeyEnv: 'CP_SETUP_EMPTY' }) }, env: { CP_SETUP_EMPTY: '' } },
  { name: 'a variable and a stored key', providers: { [id(1)]: base({ apiKeyEnv: 'CP_SETUP_KEY' }) }, stored: [id(1)], env: { CP_SETUP_KEY: 'v' } },
  { name: 'a keyless provider', providers: { [id(1)]: base({ auth: 'none' }) } },
  { name: 'a disabled keyless provider', providers: { [id(1)]: base({ auth: 'none', enabled: false }) } },
  { name: 'a legacy entry with a model list', providers: { [id(1)]: { type: 'custom', name: 'Old', protocol: 'openai-chat', baseURL: 'http://localhost:1/v1', models: [{ id: 'a' }, { id: 'b', name: 'Bee', contextWindow: 8000 }] } }, stored: [id(1)] },
  { name: 'an entry that does not normalize', providers: { [id(1)]: base({ protocol: 'bogus' }) }, stored: [id(1)] },
  { name: 'an entry without a base URL', providers: { [id(1)]: { type: 'custom', name: 'NoUrl', protocol: 'openai-chat' } } },
  { name: 'additional keys', providers: { [id(1)]: base() }, stored: [id(1)], keyIds: { [id(1)]: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] } },
  { name: 'additional keys on a keyless provider', providers: { [id(1)]: base({ auth: 'none' }) }, keyIds: { [id(1)]: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } },
  { name: 'headers, request body and wires', providers: { [id(1)]: base({ headers: { 'X-A': '1' }, requestBody: { temperature: 0.2 }, wires: ['chat', 'responses'], modelWires: { m1: 'chat' } }) } },
  {
    name: 'manual models with overrides',
    providers: {
      [id(1)]: base({
        modelOverrides: {
          m1: { hidden: false, manual: true, name: 'One', contextWindow: 32000, maxOutputTokens: 4096, supportsVision: true },
          m2: { hidden: true, manual: true, reasoning: { levels: ['low', 'high'] }, requestBody: { top_p: 0.5 }, requestHeaders: { 'X-M': '2' } },
          m3: { manual: false, hidden: true },
        },
        discovery: { newModelsHidden: true },
      }),
    },
  },
  { name: 'several providers keep their order', providers: { [id(2)]: base({ name: 'Two' }), [id(1)]: base({ name: 'One' }), [id(3)]: base({ name: 'Three', auth: 'none' }) }, stored: [id(1)] },
  {
    name: 'entries that are not custom providers',
    providers: { 'custom-bad-id': base(), [id(1)]: base({ type: 'openai' }), [id(2)]: null, [id(3)]: 'text', openai: { enabled: true }, [id(4)]: base({ name: 'Real' }) },
  },
];

const results = [];
for (const scenario of SCENARIOS) {
  for (const name of ENV_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(scenario.env ?? {})) process.env[name] = value;
  stubbedFallback = new Set((scenario.fallback ?? []).map(account));
  for (const providerId of scenario.stored ?? []) await cfg.saveSecretAsync(account(providerId), 'secret-value');
  for (const [providerId, ids] of Object.entries(scenario.keyIds ?? {})) await accounts.setCustomProviderKeyIds(providerId, ids);
  const customIds = Object.keys(scenario.providers).filter((key) => /^custom-[0-9a-f]{8}-/.test(key));
  const world = {
    stored: customIds.filter((key) => cfg.hasStoredSecret(account(key))),
    fallback: customIds.filter((key) => cfg.isFallbackSecret(account(key))),
    env: Object.fromEntries(ENV_NAMES.filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
    emptyEnv: ENV_NAMES.filter((name) => name in process.env && !process.env[name]),
    keyIds: Object.fromEntries(customIds.map((key) => [key, accounts.customProviderKeyIds(key)])),
  };
  const rows = {};
  for (const checkSecrets of [true, false]) {
    const result = await admin.providerSetup({ providers: scenario.providers }, { checkSecrets });
    rows[String(checkSecrets)] = JSON.parse(JSON.stringify(result.api.filter((row) => row.custom === true)));
  }
  results.push({ name: scenario.name, providers: scenario.providers, world, rows });
  for (const providerId of scenario.stored ?? []) await cfg.deleteSecretAsync(account(providerId));
  for (const providerId of Object.keys(scenario.keyIds ?? {})) await accounts.setCustomProviderKeyIds(providerId, []);
}
writeJson(join(stage, 'golden.json'), { scenarios: results });
writeSetManifest(stage, { set: 'provider-setup-custom', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
