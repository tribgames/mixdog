#!/usr/bin/env node
// What the media lanes take from the provider layer, as Node answers it: the real
// `fetchAvailableModels` (Antigravity catalog: request and rows or failure, `catalog.mjs`'s
// `{ ...row, id }` projection) over a scripted `fetch`, and the Codex client identity the image
// adapter presents (`codexOriginator`, `codexVersionHeader`, `codexUserAgent` overrides) under
// environment overrides. Rust `media::provider_layer` (`ProviderLayer::provider_rows`,
// `CodexProviderSession`) must send the same request, answer the same rows and fail with the
// same message.
//
//   node benchmarks/rust-core/recorders/record-media-provider-layer.mjs [--tree <dir>]
//
// Output: native/core/fixtures/media-provider-layer/golden.json. Token refresh is not recorded
// here: Rust reuses the chat providers' own refresh (GrokCredential, AntigravityAuth, OpenAiOAuth),
// which have their own goldens.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'media-provider-layer');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-media-provider-layer.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'media-provider-layer-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'media-provider-layer-home-'));
for (const name of ['MIXDOG_CODEX_ORIGINATOR', 'MIXDOG_CODEX_VERSION', 'MIXDOG_CODEX_USER_AGENT', 'TERM_PROGRAM']) delete process.env[name];
const at = (path) => importFrom(tree, path);
const P = 'src/runtime/agent/orchestrator/providers/';
const catalog = await at(`${P}antigravity-oauth-catalog.mjs`);
const tokens = await at(`${P}antigravity-oauth-tokens.mjs`);
const meta = await at(`${P}codex-client-meta.mjs`);
const version = tokens.antigravityHeaders()['User-Agent'].match(/hub\/([^ ]+) /)[1];

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const ROWS = {
  models: {
    'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', maxTokens: 1048576, supportsImages: true },
    'gemini-3.8-flash-low': { displayName: 'Gemini 3.8 Flash (Low)', maxTokens: 1048576 },
    'chat_internal': { maxTokens: 10 },
    'plain-string-row': 'not an object',
    'with-own-id': { id: 'other', displayName: 'Own Id' },
  },
};
const SCENARIOS = [
  ['rows with a project', { accessToken: 'tok-1', projectId: 'projects/p1' }, () => reply(200, ROWS)],
  ['rows without a project', { accessToken: 'tok-2' }, () => reply(200, ROWS)],
  ['an empty project is no project', { accessToken: 'tok-3', projectId: '' }, () => reply(200, { models: {} })],
  ['models missing', { accessToken: 'tok-4', projectId: 'p' }, () => reply(200, { other: 1 })],
  ['models is a list', { accessToken: 'tok-5', projectId: 'p' }, () => reply(200, { models: [1] })],
  ['models is null', { accessToken: 'tok-6', projectId: 'p' }, () => reply(200, { models: null })],
  ['401 with a body', { accessToken: 'tok-7', projectId: 'p' }, () => reply(401, 'invalid credentials')],
  ['403 with a long body (cut to 300)', { accessToken: 'tok-8', projectId: 'p' }, () => reply(403, 'x'.repeat(500))],
  ['500 with no body', { accessToken: 'tok-9', projectId: 'p' }, () => reply(500, '')],
  ['200 that is not JSON', { accessToken: 'tok-11', projectId: 'p' }, () => reply(200, 'oops')],
  ['200 with an empty body', { accessToken: 'tok-12', projectId: 'p' }, () => reply(200, '')],
  ['200 with a truncated body', { accessToken: 'tok-13', projectId: 'p' }, () => reply(200, '{"models": {"a"')],
  ['401 whose body carries secrets', { accessToken: 'tok-14', projectId: 'p' }, () => reply(401, '{"error":"invalid_token","access_token":"leaked","detail":"Bearer abc.def"}')],
  ['403 with a form body', { accessToken: 'tok-15', projectId: 'p' }, () => reply(403, 'refresh_token=r-secret&client_secret=cs denied')],
  ['the request itself fails', { accessToken: 'tok-10', projectId: 'p' }, () => { throw new TypeError('fetch failed'); }],
];
const antigravity = [];
for (const [name, opts, answer] of SCENARIOS) {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    return answer();
  };
  let outcome;
  try {
    const models = await catalog.fetchAvailableModels({ ...opts, fetchFn });
    outcome = { rows: Object.entries(models).map(([id, row]) => ({ ...(row && typeof row === 'object' ? row : {}), id })) };
  } catch (error) {
    outcome = { error: error.message };
  }
  antigravity.push({ name, token: opts.accessToken, project: opts.projectId ?? null, requests, outcome });
}

const ENVS = [
  {},
  { MIXDOG_CODEX_ORIGINATOR: ' codex_exec ' },
  { MIXDOG_CODEX_ORIGINATOR: '   ' },
  { MIXDOG_CODEX_VERSION: ' 9.9.9 ' },
  { MIXDOG_CODEX_USER_AGENT: ' pinned-agent/1 ' },
  { MIXDOG_CODEX_USER_AGENT: 'pinned-agent/2', MIXDOG_CODEX_VERSION: '8.8.8', MIXDOG_CODEX_ORIGINATOR: 'o' },
];
const codex = ENVS.map((env) => {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const row = {
    env,
    originator: meta.codexOriginator(),
    version: env.MIXDOG_CODEX_VERSION ? meta.codexVersionHeader() : null,
    userAgent: env.MIXDOG_CODEX_USER_AGENT ? meta.codexUserAgent() : null,
  };
  for (const key of Object.keys(env)) delete process.env[key];
  return row;
});

// The Antigravity image adapter's identity: header, gateway, under the version override.
const antigravitySession = [undefined, ' 9.8.7 ', '3.0.1'].map((override) => {
  if (override) process.env.MIXDOG_ANTIGRAVITY_VERSION = override;
  const row = { override: override ?? null, headers: tokens.antigravityHeaders(), endpoint: tokens.CONTENT_ENDPOINTS[0] };
  delete process.env.MIXDOG_ANTIGRAVITY_VERSION;
  return row;
});

// The ChatGPT login the image adapter asks for, when no login file exists.
const { OpenAIOAuthProvider } = await at(`${P}openai-oauth.mjs`);
let codexMissing;
try {
  await new OpenAIOAuthProvider({}).ensureAuth();
} catch (error) {
  codexMissing = error.message;
}

writeJson(join(stage, 'golden.json'), { antigravityVersion: version, antigravity, codex, antigravitySession, codexMissing });
writeSetManifest(stage, { set: 'media-provider-layer', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
