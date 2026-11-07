#!/usr/bin/env node
// `getAgentApiKey(provider)` and `hasAgentApiKey(provider)` (runtime/shared/provider-api-key.mjs):
// the real functions over environment variables and a stubbed keychain (`getSecret` / `hasSecret`
// of lib/keychain-cjs.cjs, replaced before the module is imported), with and without the
// model-proxy client mode. Rust `mixdog_services::media::provider_layer::StoreKeys` (the media
// lanes' `AgentKeys`, over `ApiKeyStore`) must answer the same.
//
//   node benchmarks/rust-core/recorders/record-agent-keys.mjs [--tree <dir>]
//
// Output: native/core/fixtures/agent-keys/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'agent-keys');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-keys.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'agent-keys-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'agent-keys-home-'));
let stored = {};
const keychain = createRequire(join(tree, 'src/runtime/shared/provider-api-key.mjs'))('../../lib/keychain-cjs.cjs');
keychain.getSecret = (account) => stored[account] ?? null;
keychain.hasSecret = (account) => Boolean(stored[account]);
const keys = await importFrom(tree, 'src/runtime/shared/provider-api-key.mjs');

const ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY', 'MIXDOG_AGENT_XAI_APIKEY', 'MIXDOG_AGENT_GEMINI_APIKEY', 'MIXDOG_AGENT_NANO_GPT_APIKEY', 'MIXDOG_MODEL_PROXY'];
const SCENARIOS = [
  { name: 'nothing set', providers: ['gemini', 'xai', 'openrouter'] },
  { name: 'the standard variable', env: { GEMINI_API_KEY: 'g-env' }, providers: ['gemini', 'xai'] },
  { name: 'the Mixdog variable', env: { MIXDOG_AGENT_GEMINI_APIKEY: 'g-mixdog' }, providers: ['gemini'] },
  { name: 'the standard variable beats the Mixdog one', env: { GEMINI_API_KEY: 'std', MIXDOG_AGENT_GEMINI_APIKEY: 'mixdog' }, providers: ['gemini'] },
  { name: 'an alias', env: { GROK_API_KEY: 'alias' }, providers: ['xai'] },
  { name: 'the standard variable beats the alias', env: { XAI_API_KEY: 'std', GROK_API_KEY: 'alias' }, providers: ['xai'] },
  { name: 'an empty variable is unset', env: { GEMINI_API_KEY: '' }, providers: ['gemini'] },
  { name: 'a stored key', stored: { 'agent.gemini.apiKey': 'g-stored' }, providers: ['gemini', 'xai'] },
  { name: 'an empty stored key', stored: { 'agent.gemini.apiKey': '' }, providers: ['gemini'] },
  { name: 'the environment beats a stored key', env: { GEMINI_API_KEY: 'g-env' }, stored: { 'agent.gemini.apiKey': 'g-stored' }, providers: ['gemini'] },
  { name: 'a provider with a space or dot', env: { MIXDOG_AGENT_NANO_GPT_APIKEY: 'n' }, stored: { 'agent.nano gpt.apiKey': 's' }, providers: ['nano gpt', 'nano.gpt'] },
  { name: 'a blank or padded id', env: { GEMINI_API_KEY: 'g-env' }, providers: ['', '  ', ' gemini '] },
  { name: 'model proxy client mode holds no credentials', env: { MIXDOG_MODEL_PROXY: 'client', GEMINI_API_KEY: 'g-env' }, stored: { 'agent.gemini.apiKey': 'g-stored' }, providers: ['gemini', 'xai'] },
];
const scenarios = SCENARIOS.map((scenario) => {
  for (const name of ENV) delete process.env[name];
  for (const [name, value] of Object.entries(scenario.env ?? {})) process.env[name] = value;
  stored = scenario.stored ?? {};
  return {
    name: scenario.name,
    env: scenario.env ?? {},
    stored: scenario.stored ?? {},
    answers: scenario.providers.map((provider) => ({ provider, has: keys.hasAgentApiKey(provider), get: keys.getAgentApiKey(provider) })),
  };
});
writeJson(join(stage, 'golden.json'), { scenarios });
writeSetManifest(stage, { set: 'agent-keys', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
