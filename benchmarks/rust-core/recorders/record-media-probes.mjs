#!/usr/bin/env node
// Golden twin of the media lanes' credential side: Node's real OAuth credential probes for the
// three OAuth lanes (oauth-credential-probes.mjs, token documents of every shape and expiry, the
// account path / path variable / legacy file order, the Antigravity developer gate), the Image API
// key lookups (`hasImageApiCredentials`, `resolveImageApiAuth`, the NanoGPT custom-provider scan)
// and the API-key lane credentials (`resolveGeminiKey`, `resolveXaiAuth`) over a scratch data
// folder, environment and clock. Rust `media::probe` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-media-probes.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const T0 = 1_700_000_000_000;
Date.now = () => T0;
const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-probes-'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
// The config module snapshots the user's data before it first reads; this run touches no user data.
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const key of Object.keys(process.env)) {
  if (/_OAUTH_CREDENTIALS_PATH$|^(XAI|GROK|GEMINI|OPENROUTER|OPENAI|ANTHROPIC|DEEPSEEK)_API_KEY$|^MIXDOG_AGENT_.*_APIKEY$|^MIXDOG_MODEL_PROXY$/.test(key)) delete process.env[key];
}
const tree = resolveTree(parseArgs());
const probes = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs');
const auth = await importFrom(tree, 'src/runtime/media/auth.mjs');
const binding = await importFrom(tree, 'src/runtime/shared/provider-auth-binding.mjs');

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
// `h.<claims>.s`: the recorders' JWT-shaped placeholder (record-ai-account.mjs); the probes read only the claims, and an `eyJ` header would trip the fixture secret scan.
const jwt = (payload, pad = false) => `h.${pad ? Buffer.from(JSON.stringify(payload)).toString('base64') : b64url(payload)}.s`;
const SEC = Math.floor((T0 + 3_600_000) / 1000);
const PAST = Math.floor((T0 - 3_600_000) / 1000);

const doc = (over) => JSON.stringify({ access_token: 'a', ...over });
const OAUTH_DOCS = {
  'refreshable': doc({ refresh_token: 'r' }),
  'access-only-no-expiry': doc({}),
  'access-only-future-seconds': doc({ expires_at: SEC }),
  'access-only-future-ms': doc({ expires_at: SEC * 1000 }),
  'access-only-past-ms': doc({ expires_at: PAST * 1000 }),
  'access-only-numeric-string': doc({ expires_at: String(SEC) }),
  'access-only-iso-future': doc({ expires_at: new Date(T0 + 3_600_000).toISOString() }),
  'access-only-iso-past': doc({ expires_at: new Date(T0 - 3_600_000).toISOString() }),
  'access-only-camel': doc({ expiresAt: SEC }),
  'jwt-future': JSON.stringify({ access_token: jwt({ exp: SEC }) }),
  'jwt-future-padded': JSON.stringify({ access_token: jwt({ exp: SEC }, true) }),
  'jwt-past': JSON.stringify({ access_token: jwt({ exp: PAST }) }),
  'jwt-string-exp': JSON.stringify({ access_token: jwt({ exp: String(SEC) }) }),
  'jwt-no-exp': JSON.stringify({ access_token: jwt({ sub: 'x' }) }),
  'opaque-token': doc({}),
  'no-access-token': JSON.stringify({ refresh_token: 'r' }),
  'empty-access-token': JSON.stringify({ access_token: '', refresh_token: 'r' }),
  'with-project': doc({ refresh_token: 'r', project_id: 'p' }),
  'with-empty-project': doc({ refresh_token: 'r', project_id: '' }),
  'garbage': '{not json',
  'array': '[]',
  'null': 'null',
};
const PROVIDERS = [['grok-oauth', 'hasGrokOAuthCredentials'], ['openai-oauth', 'hasOpenAIOAuthCredentials'], ['antigravity-oauth', 'hasAntigravityOAuthCredentials']];

const scenarios = [];
let n = 0;
async function scenario(spec) {
  const dir = join(ROOT, `s${++n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // `{s}` is the scenario's own folder.
  const sub = (text) => text.replaceAll('{s}', dir);
  const written = [];
  for (const [rel, text] of Object.entries(spec.files ?? {})) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    written.push(rel);
  }
  // The config is cached by its size and mtime: every scenario's file gets a mtime of its own.
  // Files of the data folder itself (the legacy credential files).
  for (const [rel, text] of Object.entries(spec.dataFiles ?? {})) writeFileSync(join(DATA, rel), text);
  writeFileSync(join(DATA, 'mixdog-config.json'), JSON.stringify(spec.config ?? {}));
  utimesSync(join(DATA, 'mixdog-config.json'), new Date(1_600_000_000_000 + n * 10_000), new Date(1_600_000_000_000 + n * 10_000));
  const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, sub(v)]));
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const bound = Object.fromEntries(Object.entries(spec.bound ?? {}).map(([k, v]) => [k, sub(v)]));
  const restore = binding.replaceProviderAuthBindings(bound);
  const results = {};
  for (const call of spec.calls) {
    try {
      if (call.startsWith('oauth:')) results[call] = probes[PROVIDERS.find(([p]) => p === call.slice(6))[1]]();
      else if (call.startsWith('imageApiKey:')) results[call] = auth.hasImageApiCredentials(call.slice(12));
      else if (call.startsWith('imageApiAuth:')) results[call] = { value: auth.resolveImageApiAuth(call.slice(13)) };
      else if (call === 'gemini') results[call] = { value: { token: auth.resolveGeminiKey() } };
      else if (call === 'xai') results[call] = { value: await auth.resolveXaiAuth('xai') };
    } catch (error) {
      results[call] = { error: { message: error.message, code: error.code ?? null, status: error.status ?? null } };
    }
  }
  restore();
  for (const rel of Object.keys(spec.dataFiles ?? {})) rmSync(join(DATA, rel), { force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  scenarios.push({ name: spec.name, files: spec.files ?? {}, dataFiles: spec.dataFiles ?? {}, written, env: spec.env ?? {}, bound: spec.bound ?? {}, config: spec.config ?? {}, calls: spec.calls, results });
}

// A token document of every shape, as the selected account's file, for each OAuth lane.
const dev = { agent: { developer: { antigravityOAuth: true } } };
for (const [name, text] of Object.entries(OAUTH_DOCS)) {
  await scenario({ name: `doc-${name}`, files: { 'cred.json': text }, bound: Object.fromEntries(PROVIDERS.map(([p]) => [p, '{s}/cred.json'])), config: dev, calls: PROVIDERS.map(([p]) => `oauth:${p}`) });
}
// Where the credentials are looked for: account, path variable, legacy file, nothing.
await scenario({ name: 'legacy-files', dataFiles: Object.fromEntries(PROVIDERS.map(([p]) => [`${p}.json`, OAUTH_DOCS['with-project']])), config: dev, calls: PROVIDERS.map(([p]) => `oauth:${p}`) });
await scenario({ name: 'path-variables', files: { 'v/g.json': OAUTH_DOCS.refreshable, 'v/o.json': OAUTH_DOCS.refreshable, 'v/a.json': OAUTH_DOCS['with-project'] }, env: { GROK_OAUTH_CREDENTIALS_PATH: '{s}/v/g.json', OPENAI_OAUTH_CREDENTIALS_PATH: '{s}/v/o.json', ANTIGRAVITY_OAUTH_CREDENTIALS_PATH: '{s}/v/a.json' }, config: dev, calls: PROVIDERS.map(([p]) => `oauth:${p}`) });
await scenario({ name: 'account-beats-variable', files: { 'v/g.json': OAUTH_DOCS.refreshable, 'acct.json': OAUTH_DOCS['no-access-token'] }, env: { GROK_OAUTH_CREDENTIALS_PATH: '{s}/v/g.json' }, bound: { 'grok-oauth': '{s}/acct.json' }, config: dev, calls: ['oauth:grok-oauth'] });
await scenario({ name: 'empty-variable-falls-through', env: { OPENAI_OAUTH_CREDENTIALS_PATH: '' }, config: dev, calls: ['oauth:openai-oauth'] });
await scenario({ name: 'nothing-anywhere', config: dev, calls: PROVIDERS.map(([p]) => `oauth:${p}`) });
// The Antigravity developer gate.
for (const [name, config] of [['gate-on', dev], ['gate-off', { agent: { developer: { antigravityOAuth: false } } }], ['gate-unset', {}], ['gate-not-boolean', { agent: { developer: { antigravityOAuth: 'true' } } }]]) {
  await scenario({ name, files: { 'cred.json': OAUTH_DOCS['with-project'] }, bound: { 'antigravity-oauth': '{s}/cred.json' }, config, calls: ['oauth:antigravity-oauth'] });
}
// Remote mode holds no credentials.
await scenario({ name: 'remote-mode', files: { 'cred.json': OAUTH_DOCS.refreshable }, bound: { 'grok-oauth': '{s}/cred.json' }, env: { MIXDOG_MODEL_PROXY: 'client', OPENROUTER_API_KEY: 'k', XAI_API_KEY: 'k' }, config: dev, calls: ['oauth:grok-oauth', 'imageApiKey:openrouter', 'gemini', 'xai'] });
// API keys of the key lanes.
await scenario({ name: 'keys-in-environment', env: { OPENROUTER_API_KEY: 'or-key', XAI_API_KEY: 'x-key', GEMINI_API_KEY: 'g-key' }, calls: ['imageApiKey:openrouter', 'imageApiAuth:openrouter', 'gemini', 'xai'] });
await scenario({ name: 'xai-alias', env: { GROK_API_KEY: 'alias-key' }, calls: ['xai'] });
await scenario({ name: 'xai-mixdog-name', env: { MIXDOG_AGENT_XAI_APIKEY: 'mx-key' }, calls: ['xai'] });
await scenario({ name: 'gemini-mixdog-name', env: { MIXDOG_AGENT_GEMINI_APIKEY: 'mg-key' }, calls: ['gemini'] });
await scenario({ name: 'openrouter-mixdog-name', env: { MIXDOG_AGENT_OPENROUTER_APIKEY: 'mo-key' }, calls: ['imageApiKey:openrouter', 'imageApiAuth:openrouter'] });
// NanoGPT: the first enabled, keyed custom endpoint on a NanoGPT host.
const nano = (entries) => ({ agent: { providers: entries } });
const ep = (over) => ({ type: 'custom', baseURL: 'https://nano-gpt.com/api/v1', ...over });
await scenario({ name: 'nano-inline-key', config: nano({ 'custom-nano': ep({ apiKey: 'inline' }) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-key-env', env: { NANO_KEY: 'from-env' }, config: nano({ 'custom-nano': ep({ apiKeyEnv: 'NANO_KEY' }) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-key-env-unset', config: nano({ 'custom-nano': ep({ apiKeyEnv: 'NANO_KEY_UNSET' }) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-agent-key-env', env: { 'MIXDOG_AGENT_CUSTOM-NANO_APIKEY': 'agent-key' }, config: nano({ 'custom-nano': ep({}) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-disabled', config: nano({ 'custom-nano': ep({ apiKey: 'k', enabled: false }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-no-auth', config: nano({ 'custom-nano': ep({ apiKey: 'k', auth: 'none' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-other-host', config: nano({ 'custom-nano': ep({ apiKey: 'k', baseURL: 'https://example.com/v1' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-lookalike-host', config: nano({ 'custom-nano': ep({ apiKey: 'k', baseURL: 'https://evilnano-gpt.com/v1' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-subdomain-upper', config: nano({ 'custom-nano': ep({ apiKey: 'k', baseURL: 'https://API.NANO-GPT.COM/v1' }) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-bad-url', config: nano({ 'custom-nano': ep({ apiKey: 'k', baseURL: 'not a url' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-not-custom-type', config: nano({ 'custom-nano': ep({ apiKey: 'k', type: 'openai' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-not-custom-id', config: nano({ nano: ep({ apiKey: 'k' }) }), calls: ['imageApiKey:nano-gpt'] });
await scenario({ name: 'nano-first-keyed-wins', config: nano({ 'custom-a': ep({ apiKeyEnv: 'NANO_KEY_UNSET' }), 'custom-b': ep({ apiKey: 'second' }), 'custom-c': ep({ apiKey: 'third' }) }), calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });
await scenario({ name: 'nano-no-providers', config: {}, calls: ['imageApiKey:nano-gpt', 'imageApiAuth:nano-gpt'] });

const slash = (path) => path.replaceAll('\\', '/');
const normalize = (value) =>
  typeof value === 'string' ? value.replaceAll(slash(ROOT), '{root}').replaceAll(ROOT, '{root}') : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;
writeJson(join(FIXTURES_ROOT, 'services', 'media-probes-twin.json'), { domain: 'media-probes-twin', recorder: 'benchmarks/rust-core/recorders/record-media-probes.mjs', clock: T0, scenarios: normalize(scenarios) });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${scenarios.length} scenarios`);
process.exit(0);
