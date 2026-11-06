#!/usr/bin/env node
// Model listings of the OpenAI-compatible family (WP-AI-COMPAT): Node's REAL
// `listModels` of the generic compat provider (xai, deepseek, openrouter), MiMo,
// Muse Code, Command Code and the OpenCode Go OAuth provider, each over a
// scripted `/models` (or the console config) behind a stubbed fetch. No
// network, no real credential; the metadata catalogs stay empty (every
// catalog fetch is a 404), so the rows show the roster, the shared
// enrichment's own tables (seeds, overrides) and each provider's own steps.
//
//   node benchmarks/rust-core/recorders/record-compat-listing.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/compat-listing.json. It lives
// inside `providers/`, so record-providers.mjs calls `recordCompatListing`
// before its manifest write.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const OLD = 1700000000; // a 2023 `created`: stale to the picker sanitizer at any test time

// A generic /models roster: every limit spelling, every mode source, effort ladders.
const GENERIC = [
  { id: 'plain-model' },
  { id: 'limits-a', context_window: 128000, max_output_tokens: 4096 },
  { id: 'limits-zero-first', context_window: 0, max_context_window: 64000 },
  { id: 'limits-string', context_window: '32000', output_tokens: '2048' },
  { id: 'limits-top', top_provider: { context_length: 200000, max_completion_tokens: 8192 } },
  { id: 'limits-camel', contextWindow: 16000, maxOutputTokens: 1000 },
  { id: 'limits-negative', context_length: -5, max_output_tokens: -1 },
  { id: 'mode-chat', type: 'chat' },
  { id: 'mode-code', type: ' CODE ' },
  { id: 'mode-embedding', type: 'embedding' },
  { id: 'mode-image-out', architecture: { output_modalities: ['image'] } },
  { id: 'mode-text-out', architecture: { output_modalities: ['text', 'image'] } },
  { id: 'mode-caps-true', capabilities: { completion_chat: true } },
  { id: 'mode-caps-false', capabilities: { completion_chat: false } },
  { id: 'alias-string', alias_target: 'real/model-1' },
  { id: 'alias-object', alias_target: { slug: 'real/model-2' } },
  { id: 'created-number', created: OLD },
  { id: 'created-string', created: '1700000000' },
  { id: 'effort-list', reasoning_efforts: ['low', 'high', 'ultra', 'bogus'] },
  { id: 'effort-objects', reasoning_levels: [{ value: 'medium' }, { value: 'none' }] },
  { id: 'effort-none-only', reasoningLevels: ['none'] },
  { id: 'effort-empty', reasoning_efforts: [] },
  { id: 'effort-flag', supports_reasoning_effort: true },
  { id: 'effort-caps-flag', capabilities: { reasoning_effort: true } },
  { id: 'name-given', name: 'Given Name', display_name: 'Display Name' },
  { name: 'no-id' },
  { id: '' },
  { id: 'plain-model' },
];

const MIMO = [
  { id: 'mimo-v2.6-pro', display_name: ' MiMo V2.6 Pro ' },
  { id: 'mimo-v2.5-tts' },
  { id: 'mimo-v2.5-asr-large' },
  { id: 'MiMo-V2.6-Flash-0101', context_window: 500000 },
  { id: 'mimo-v2-omni', max_output_tokens: 9000 },
  { id: 'mimo-vX-unseeded', display_name: 'Unseeded' },
  { id: 'mimo-effort', reasoning_efforts: ['low', 'high'] },
];

const MUSE = [
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', context_window: 2000000 },
  { id: 'muse-spark-1.3-contributor', display_name: 'muse spark 1.3 c' },
  { id: 'muse-spark-1.4', max_output_tokens: 99000, created: OLD },
  { id: 'muse-spark-1.4-contributor' },
  { id: 'muse-spark-2.0.1' },
  { id: 'muse-spark-1.3.0' },
  { id: 'muse-image-1' },
  { id: 'Muse-Voice-2' },
  { id: 'muse-other', name: ' Other ', context_length: 4096 },
];

const COMMAND = [
  { id: 'deepseek/deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', context_window: 128000 },
  { id: 'claude-sonnet-5', supported_endpoints: ['/messages'], max_output_tokens: 64000 },
  { id: 'gpt-5.5', supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'responses-only', supported_endpoints: ['v1/responses'] },
  { id: 'embedding-only', supported_endpoints: ['/embeddings'] },
  { id: 'no-endpoints', supported_endpoints: [] },
  { id: 'name-only', name: 'Name Only' },
];

// The console config: configured models (some disabled, one with its own route) …
const GO_CONFIG = {
  providers: {
    'opencode-go': {
      package: '@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://gateway.example/go/openai/v1' },
      headers: { 'x-tenant': 'fixture', 'x-bad': 7 },
      models: {
        'go-chat': { name: ' Go Chat ', limit: { context: 200000, output: 8000 }, cost: { input: 1, output: 2, cache: { read: 0.1, write: 0 } } },
        'go-responses': { package: '@ai-sdk/openai', limit: { context: 400000 }, capabilities: { reasoning: { supported: true, effort: ['low', 'high'] } } },
        'go-messages': { package: '@ai-sdk/anthropic', capabilities: { reasoning: { supported: false } } },
        'go-own-route': { settings: { baseURL: 'https://other.example/v1' }, headers: { 'x-own': 'y' } },
        'go-other-package': { package: '@x/y' },
        'go-disabled': { disabled: true },
        'go-reasoning-bare': { capabilities: { reasoning: { supported: true } } },
      },
    },
  },
};
// … and the same provider with no models, so the models.dev catalog is the roster.
const GO_EMPTY = { providers: { 'opencode-go': { settings: { baseURL: 'https://gateway.example/go/openai/v1' }, models: {} } } };
const GO_MODELS_DEV = {
  'md-chat': { id: 'md-chat', name: 'MD Chat', limit: { context: 128000, output: 4096 }, cost: { input: 3, output: 6, cache_read: 0.3 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
  'md-messages': { id: 'md-messages', name: 'MD Messages', provider: { npm: '@ai-sdk/anthropic' }, npm: '@ai-sdk/anthropic', limit: { context: 200000 }, reasoning: false },
  'md-responses': { id: 'md-responses', npm: '@ai-sdk/openai', limit: { context: 50000, output: 2000 } },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function recordCompatListing(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'compat-listing-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const creds = {
    MIMO_OAUTH_CREDENTIALS_PATH: ['mimo-oauth.json', { apiKey: 'fixture-mimo-key', uid: 'u1', baseUrl: 'https://api.xiaomimimo.com/v1' }],
    MUSE_CODE_OAUTH_CREDENTIALS_PATH: ['muse-code-oauth.json', { accessToken: 'fixture-muse-access', apiKey: 'fixture-muse-key' }],
    COMMAND_CODE_OAUTH_CREDENTIALS_PATH: ['command-code-oauth.json', { apiKey: 'fixture-command-key', userId: 'u2' }],
    OPENCODE_GO_OAUTH_CREDENTIALS_PATH: [
      'opencode-go-oauth.json',
      { access_token: 'fixture-go-access', refresh_token: 'fixture-go-refresh', expires_at: Date.now() + 3650 * 86400000, org_id: 'org-1', account_id: 'acct-1' },
    ],
  };
  for (const [env, [file, body]] of Object.entries(creds)) {
    writeFileSync(join(dataDir, file), JSON.stringify(body));
    process.env[env] = join(dataDir, file);
  }
  // models.dev warmed from a disk copy: the Go catalog the empty console config falls back to.
  writeFileSync(
    join(dataDir, 'modelsdev-catalog.json'),
    `{"fetchedAt":${Date.now()},"data":${JSON.stringify({ 'opencode-go': { models: GO_MODELS_DEV } })}}\n`
  );

  let script = () => new Response('not found', { status: 404 });
  let sent = [];
  const stub = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const answer = script(url, headers);
    if (answer === undefined) return new Response('not found', { status: 404 });
    sent.push({ method: init.method ?? 'GET', url, headers: pick(headers) });
    return answer;
  };
  const pick = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => ['authorization', 'x-org-id', 'x-mimo-source', 'accept', 'x-api-version'].includes(k)));
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;

  const catalog = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
  await catalog.warmCatalogFromDisk();
  const compat = await importFrom(tree, `${P}/openai-compat.mjs`);
  const mimo = await importFrom(tree, `${P}/mimo-oauth.mjs`);
  const muse = await importFrom(tree, `${P}/muse-code-oauth.mjs`);
  const command = await importFrom(tree, `${P}/command-code-oauth.mjs`);
  const go = await importFrom(tree, `${P}/opencode-go-oauth.mjs`);

  const cases = [];
  const run = async (provider, scenario, make, answer, { list = (p) => p.listModels() } = {}) => {
    // A listing publishes its roster to disk and the shared lookup reads it back:
    // every scenario starts from no published roster.
    for (const file of readdirSync(dataDir)) if (/-models\.json$/.test(file)) rmSync(join(dataDir, file));
    script = (url, headers) => (/\/models(\?|$)|api\/v2\/config/.test(url) ? answer(url, headers) : undefined);
    sent = [];
    let out;
    try {
      out = { rows: await list(make()) };
    } catch (error) {
      out = { error: String(error?.message ?? error), status: error?.status ?? null };
    }
    cases.push({ provider, scenario, requests: sent, ...out });
  };

  for (const name of ['xai', 'deepseek', 'openrouter']) {
    const make = () => new compat.OpenAICompatProvider(name, { apiKey: 'fixture-list-key', baseURL: 'https://gateway.example/v1' });
    await run(name, 'roster', make, () => json({ data: GENERIC }));
  }
  await run('deepseek', 'bare-array', () => new compat.OpenAICompatProvider('deepseek', { apiKey: 'fixture-list-key', baseURL: 'https://gateway.example/v1' }), () => json(GENERIC.slice(0, 4)));
  await run('deepseek', 'refused', () => new compat.OpenAICompatProvider('deepseek', { apiKey: 'fixture-list-key', baseURL: 'https://gateway.example/v1' }), () => json({ error: { message: 'bad key fixture-list-key', code: 'invalid_api_key' } }, 403));

  const mimoMake = () => new mimo.MimoOAuthProvider({});
  await run('mimo-oauth', 'roster', mimoMake, () => json({ data: MIMO }));
  await run('mimo-oauth', 'empty-roster', mimoMake, () => json({ data: [] }));
  await run('mimo-oauth', 'server-error', mimoMake, () => json({ error: 'boom' }, 500));
  await run('mimo-oauth', 'unauthorized', mimoMake, () => json({ error: { message: 'no' } }, 401));

  const museMake = () => new muse.MuseCodeOAuthProvider({});
  await run('muse-code-oauth', 'roster', museMake, () => json({ data: MUSE }));
  await run('muse-code-oauth', 'empty-roster', museMake, () => json({ data: [] }));

  const commandMake = () => new command.CommandCodeOAuthProvider({ fetchImpl: stub });
  await run('command-code-oauth', 'roster', commandMake, () => json({ data: COMMAND }));
  await run('command-code-oauth', 'unauthorized', commandMake, () => json({ error: 'no' }, 401));

  const goMake = () => new go.OpenCodeGoOAuthProvider({ fetchImpl: stub });
  await run('opencode-go-oauth', 'config', goMake, () => json(GO_CONFIG));
  await run('opencode-go-oauth', 'config-empty-models-dev', goMake, () => json(GO_EMPTY));
  await run('opencode-go-oauth', 'config-without-provider', goMake, () => json({ providers: {} }));

  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
  writeJson(outFile, {
    _doc: 'Recorded from the REAL listModels of each Node provider over a scripted /models (or console config) behind a stubbed fetch; the metadata catalogs are empty except the opencode-go models.dev rows the empty console config falls back to. `rows` are the Node rows verbatim; `requests` the calls made.',
    recorder: 'benchmarks/rust-core/recorders/record-compat-listing.mjs',
    rosters: { generic: GENERIC, mimo: MIMO, muse: MUSE, command: COMMAND, goConfig: GO_CONFIG, goEmpty: GO_EMPTY, goModelsDev: GO_MODELS_DEV },
    cases,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordCompatListing(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'compat-listing.json'));
  console.log('recorded compat-listing; providers/MANIFEST.json is regenerated by record-providers.mjs');
}
