#!/usr/bin/env node
// Golden of the media catalog cache key (`catalog.mjs` `providerSource`): the key names the cache
// file on disk (`studio-models-<key>.json`), so a cache a 1.4.5 install wrote must be found by the
// same name. Node's real default source resolves each lane's credentials (environment, config,
// token documents) and the loader asks the cache for the key; the recorder captures what it asked
// for. Rust `media::probe` must ask for the same names for the same credentials.
//
//   node benchmarks/rust-core/recorders/record-media-catalog-keys.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const T0 = 1_700_000_000_000;
Date.now = () => T0;
const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-keys-'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
// No network: the Antigravity client version is pinned.
process.env.MIXDOG_ANTIGRAVITY_VERSION = '1.0.0';
for (const key of Object.keys(process.env)) {
  if (/_OAUTH_CREDENTIALS_PATH$|^(XAI|GROK|GEMINI|OPENROUTER|OPENAI|ANTHROPIC|DEEPSEEK)_API_KEY$|^MIXDOG_AGENT_.*_APIKEY$|^MIXDOG_MODEL_PROXY$/.test(key)) delete process.env[key];
}
const tree = resolveTree(parseArgs());
const { createMediaModelLoader } = await importFrom(tree, 'src/runtime/media/catalog.mjs');
const binding = await importFrom(tree, 'src/runtime/shared/provider-auth-binding.mjs');

const FAR = T0 + 10 * 3_600_000;
const grok = (over) => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: FAR, ...over });
const agy = (over) => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: FAR, project_id: 'proj-1', ...over });
const dev = { agent: { developer: { antigravityOAuth: true } } };
const nano = (key) => ({ agent: { providers: { 'custom-nano': { type: 'custom', baseURL: 'https://nano-gpt.com/api/v1', apiKey: key } } } });
const SCENARIOS = [
  { name: 'gemini-a', lane: 'gemini', env: { GEMINI_API_KEY: 'g-key-a' } },
  { name: 'gemini-b', lane: 'gemini', env: { GEMINI_API_KEY: 'g-key-b' } },
  { name: 'gemini-unicode-key', lane: 'gemini', env: { GEMINI_API_KEY: 'kéy-ü-日本' } },
  { name: 'gemini-missing', lane: 'gemini' },
  { name: 'xai-a', lane: 'xai', env: { XAI_API_KEY: 'x-key-a' } },
  { name: 'xai-alias', lane: 'xai', env: { GROK_API_KEY: 'x-key-a' } },
  { name: 'xai-missing', lane: 'xai' },
  { name: 'openrouter-a', lane: 'openrouter', env: { OPENROUTER_API_KEY: 'or-key-a' } },
  { name: 'nano-gpt-a', lane: 'nano-gpt', config: nano('ng-key-a') },
  { name: 'nano-gpt-b', lane: 'nano-gpt', config: nano('ng-key-b') },
  { name: 'nano-gpt-missing', lane: 'nano-gpt' },
  { name: 'grok-oauth-user-1-token-1', lane: 'grok-oauth', files: { 'g.json': grok({ user_id: 'user-1', access_token: 'token-1' }) }, bound: { 'grok-oauth': '{s}/g.json' } },
  { name: 'grok-oauth-user-1-token-2', lane: 'grok-oauth', files: { 'g.json': grok({ user_id: 'user-1', access_token: 'token-2' }) }, bound: { 'grok-oauth': '{s}/g.json' } },
  { name: 'grok-oauth-user-2', lane: 'grok-oauth', files: { 'g.json': grok({ user_id: 'user-2' }) }, bound: { 'grok-oauth': '{s}/g.json' } },
  { name: 'grok-oauth-no-user-token-1', lane: 'grok-oauth', files: { 'g.json': grok({ access_token: 'token-1' }) }, bound: { 'grok-oauth': '{s}/g.json' } },
  { name: 'grok-oauth-no-user-token-2', lane: 'grok-oauth', files: { 'g.json': grok({ access_token: 'token-2' }) }, bound: { 'grok-oauth': '{s}/g.json' } },
  { name: 'grok-oauth-missing', lane: 'grok-oauth' },
  { name: 'antigravity-project-1-token-1', lane: 'antigravity-oauth', config: dev, files: { 'a.json': agy({ access_token: 'token-1' }) }, bound: { 'antigravity-oauth': '{s}/a.json' } },
  { name: 'antigravity-project-1-token-2', lane: 'antigravity-oauth', config: dev, files: { 'a.json': agy({ access_token: 'token-2' }) }, bound: { 'antigravity-oauth': '{s}/a.json' } },
  { name: 'antigravity-project-2', lane: 'antigravity-oauth', config: dev, files: { 'a.json': agy({ project_id: 'proj-2' }) }, bound: { 'antigravity-oauth': '{s}/a.json' } },
  { name: 'antigravity-missing', lane: 'antigravity-oauth', config: dev },
];

const results = [];
let n = 0;
for (const spec of SCENARIOS) {
  const dir = join(ROOT, `s${++n}`);
  mkdirSync(dir, { recursive: true });
  const sub = (text) => text.replaceAll('{s}', dir);
  for (const [rel, text] of Object.entries(spec.files ?? {})) writeFileSync(join(dir, rel), text);
  writeFileSync(join(DATA, 'mixdog-config.json'), JSON.stringify(spec.config ?? {}));
  utimesSync(join(DATA, 'mixdog-config.json'), new Date(1_600_000_000_000 + n * 10_000), new Date(1_600_000_000_000 + n * 10_000));
  const saved = Object.fromEntries(Object.keys(spec.env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, spec.env ?? {});
  const restore = binding.replaceProviderAuthBindings(Object.fromEntries(Object.entries(spec.bound ?? {}).map(([k, v]) => [k, sub(v)])));
  const asked = [];
  // The cache answers with an empty catalog: the loader never goes on to the network.
  const load = createMediaModelLoader({ cache: (key) => (asked.push(key), { loadSync: () => [], save() {} }) });
  let outcome;
  try {
    await load(spec.lane);
    outcome = { keys: asked };
  } catch (error) {
    outcome = { keys: asked, error: { message: error.message, code: error.code ?? null } };
  }
  restore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  results.push({ name: spec.name, lane: spec.lane, env: spec.env ?? {}, config: spec.config ?? {}, files: spec.files ?? {}, bound: spec.bound ?? {}, ...outcome });
}

// The ChatGPT subscription lane: its catalog is the account's Codex list (its own 24 h cache), so
// the media loader keeps none of its own and asks the provider every time; concurrent loads still
// share one request. The provider's model list is stubbed at its seam (no network).
const { OpenAIOAuthProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-oauth.mjs');
let listScript = [];
let listCalls = 0;
OpenAIOAuthProvider.prototype.listModels = async function listModels() {
  listCalls += 1;
  const next = listScript.shift();
  if (next.error) throw new Error(next.error);
  return structuredClone(next.rows);
};
const openaiSteps = [
  { op: 'script', results: [{ rows: [{ id: 'gpt-5.5' }] }, { rows: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }] }] },
  { op: 'load' },
  { op: 'load' },
  { op: 'script', results: [{ rows: [{ id: 'one' }] }] },
  { op: 'load-many', count: 3 },
  { op: 'script', results: [{ rows: [] }] },
  { op: 'load' },
  { op: 'script', results: [{ error: 'boom' }, { rows: [{ id: 'back' }] }] },
  { op: 'load' },
  { op: 'load' },
];
const askedOpenai = [];
const loadOpenai = createMediaModelLoader({ cache: (key) => (askedOpenai.push(key), { loadSync: () => [{ id: 'never-served' }], save() {} }) });
const outcomeOf = async () => {
  try {
    const rows = await loadOpenai('openai-oauth');
    return { rows: [...rows], warning: rows.catalogWarning ?? null };
  } catch (error) {
    return { error: { message: error.message, code: error.code ?? null } };
  }
};
const openai = [];
for (const step of openaiSteps) {
  let result = null;
  if (step.op === 'script') listScript = structuredClone(step.results);
  else if (step.op === 'load') result = await outcomeOf();
  else result = await Promise.all(Array.from({ length: step.count }, outcomeOf));
  openai.push({ step, result, listCalls, cacheAsked: [...askedOpenai] });
}

writeJson(join(FIXTURES_ROOT, 'services', 'media-catalog-keys-twin.json'), { domain: 'media-catalog-keys-twin', recorder: 'benchmarks/rust-core/recorders/record-media-catalog-keys.mjs', clock: T0, scenarios: results, openai });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
