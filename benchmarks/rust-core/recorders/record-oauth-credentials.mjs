#!/usr/bin/env node
// Where the ten OAuth providers keep their credentials and which documents they take for a
// sign-in: the real `getOwnTokenPath` / `loadTokens` / `loadCredentials` and `describe*` over files
// seeded in a temp data dir, `Date.now` fixed. Rust
// `mixdog_core_domains::domains::ai_account::oauth_credentials` must find the same file, load the
// same document (cursor and devin do not export their loader: only the description is recorded)
// and describe it the same, key order included.
//
//   node benchmarks/rust-core/recorders/record-oauth-credentials.mjs [--tree <dir>]
//
// Output: native/core/fixtures/oauth-credentials/golden.json. The data dir is recorded as `{dataDir}`.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'oauth-credentials');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-credentials.mjs';
const dataDir = mkdtempSync(join(tmpdir(), 'oauth-credentials-rec-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'oauth-credentials-home-'));
for (const name of ['CURSOR_ACCESS_TOKEN']) delete process.env[name];
const at = (path) => importFrom(tree, path);
const P = 'src/runtime/agent/orchestrator/providers/';
const modules = {
  'openai-oauth': { m: await at(`${P}openai-oauth-tokens.mjs`), describe: 'describeOpenAIOAuthCredentials', load: 'loadTokens', file: 'openai-oauth.json', env: 'OPENAI_OAUTH_CREDENTIALS_PATH' },
  'anthropic-oauth': { m: await at(`${P}anthropic-oauth-credentials.mjs`), describe: 'describeAnthropicOAuthCredentials', load: 'loadCredentials', file: 'anthropic-oauth-credentials.json', env: 'ANTHROPIC_OAUTH_CREDENTIALS_PATH' },
  'grok-oauth': { m: await at(`${P}grok-oauth-tokens.mjs`), describe: 'describeGrokOAuthCredentials', load: 'loadTokens', file: 'grok-oauth.json', env: 'GROK_OAUTH_CREDENTIALS_PATH' },
  'muse-code-oauth': { m: await at(`${P}muse-code-oauth-tokens.mjs`), describe: 'describeMuseCodeOAuthCredentials', load: 'loadTokens', file: 'muse-code-oauth.json', env: 'MUSE_CODE_OAUTH_CREDENTIALS_PATH' },
  'command-code-oauth': { m: await at(`${P}command-code-oauth-tokens.mjs`), describe: 'describeCommandCodeOAuthCredentials', load: 'loadTokens', file: 'command-code-oauth.json', env: 'COMMAND_CODE_OAUTH_CREDENTIALS_PATH' },
  'opencode-go-oauth': { m: await at(`${P}opencode-go-oauth-tokens.mjs`), describe: 'describeOpenCodeGoOAuthCredentials', load: 'loadTokens', file: 'opencode-go-oauth.json', env: 'OPENCODE_GO_OAUTH_CREDENTIALS_PATH' },
  'mimo-oauth': { m: await at(`${P}mimo-oauth-tokens.mjs`), describe: 'describeMimoOAuthCredentials', load: 'loadTokens', file: 'mimo-oauth.json', env: 'MIMO_OAUTH_CREDENTIALS_PATH' },
  'cursor-oauth': { m: await at(`${P}cursor-auth.mjs`), describe: 'describeCursorOAuthCredentials', load: null, file: 'cursor-oauth.json', env: 'CURSOR_OAUTH_CREDENTIALS_PATH' },
  'devin-oauth': { m: await at(`${P}devin-auth.mjs`), describe: 'describeDevinOAuthCredentials', load: null, file: 'devin-oauth.json', env: 'DEVIN_OAUTH_CREDENTIALS_PATH' },
  'antigravity-oauth': { m: await at(`${P}antigravity-oauth-tokens.mjs`), describe: 'describeAntigravityOAuthCredentials', load: 'loadTokens', file: 'antigravity-oauth.json', env: 'ANTIGRAVITY_OAUTH_CREDENTIALS_PATH' },
};

// Only the payload is read; a short header and signature keep the fixture from looking like a real token.
const jwt = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
const secs = (offsetSeconds) => Math.floor(NOW / 1000) + offsetSeconds;
const OPENAI_AUTH = 'https://api.openai.com/auth';
const openaiToken = (offset, extra = {}) => jwt({ exp: secs(offset), sub: 'user-1', email: 'ann@example.com', [OPENAI_AUTH]: { chatgpt_account_id: 'acct_1234567890abcdef', chatgpt_plan_type: 'plus' }, ...extra });
const userToken = (offset, claims = {}) => jwt({ exp: secs(offset), sub: 'sub-9', email: 'u@x.test', ...claims });
const anthropic = (oauth) => ({ claudeAiOauth: oauth });
const SCOPES = ['user:profile', 'user:inference'];

// [provider, name, raw (an object, or a string written as it is), environment]
const SCENARIOS = [
  ['openai-oauth', 'valid, expiry from the access token, identity and account from the claims', { access_token: openaiToken(3600), id_token: openaiToken(3600), refresh_token: 'r' }],
  ['openai-oauth', 'camelCase expiry in milliseconds, account id kept', { access_token: 'opaque', refresh_token: 'r', expiresAt: NOW + 3_600_000, account_id: 'abcdefghijklmnop' }],
  ['openai-oauth', 'identity from the access token only', { access_token: openaiToken(3600, { email: 'only@x.test' }), refresh_token: 'r' }],
  ['openai-oauth', 'access only and expired: not a sign-in', { access_token: openaiToken(-100) }],
  ['openai-oauth', 'access only, expiry unknown: not a sign-in', { access_token: 'opaque' }],
  ['openai-oauth', 'a document that is not an object', '[1,2]'],
  ['openai-oauth', 'text that is not JSON', 'not json'],
  ['anthropic-oauth', 'valid with a subscription and an identity', anthropic({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000, scopes: SCOPES, subscriptionType: 'max', identity: { id: 'acc-1', email: 'c@x.test' } })],
  ['anthropic-oauth', 'about to expire', anthropic({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 60_000, scopes: SCOPES })],
  ['anthropic-oauth', 'expired without a refresh token', anthropic({ accessToken: 'at', expiresAt: NOW - 1000, scopes: SCOPES })],
  ['anthropic-oauth', 'expiry in seconds under expires_at', anthropic({ accessToken: 'at', refreshToken: 'rt', expires_at: secs(7200), scopes: SCOPES })],
  ['anthropic-oauth', 'no inference scope', anthropic({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000, scopes: ['user:profile'] })],
  ['anthropic-oauth', 'scopes missing', anthropic({ accessToken: 'at', refreshToken: 'rt' })],
  ['anthropic-oauth', 'reauth required', anthropic({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000, scopes: SCOPES, reauthRequired: true })],
  ['anthropic-oauth', 'no access token', anthropic({ refreshToken: 'rt', scopes: SCOPES })],
  ['anthropic-oauth', 'no claudeAiOauth', { other: 1 }],
  ['grok-oauth', 'valid, user from the claims, email from the id token', { access_token: userToken(3600, { principal_type: 'user' }), refresh_token: 'r', id_token: jwt({ email: 'g@x.test' }) }],
  ['grok-oauth', 'user from the principal id', { access_token: userToken(3600, { principal_id: 'pid-1', sub: undefined }), refresh_token: 'r', email: 'stored@x.test' }],
  ['grok-oauth', 'stored identity wins over the claims', { access_token: userToken(3600), refresh_token: 'r', user_id: 'stored-user', principalType: 'team', token_endpoint: 'https://t.example/token' }],
  ['grok-oauth', 'refresh token missing', { access_token: userToken(3600) }],
  ['grok-oauth', 'camelCase expiry', { access_token: 'opaque', refresh_token: 'r', expiresAt: NOW + 3_600_000 }],
  ['muse-code-oauth', 'blank api key', { accessToken: 'at', apiKey: '   ' }],
  ['muse-code-oauth', 'valid', { accessToken: 'at', apiKey: 'k', accountId: 'a1', email: 'm@x.test' }],
  ['command-code-oauth', 'blank api key', { apiKey: '  ' }],
  ['command-code-oauth', 'trimmed fields', { apiKey: ' key ', userId: ' u1 ', userName: ' Ann ' }],
  ['opencode-go-oauth', 'blank access token', { access_token: ' ', refresh_token: 'r' }],
  ['opencode-go-oauth', 'expiry as a numeric string', { access_token: 'a', refresh_token: 'r', expires_at: String(NOW + 3_600_000), org_name: ' Acme ' }],
  ['mimo-oauth', 'custom base url, numeric key', { apiKey: 12345, uid: 77, baseUrl: 'https://mimo.example/v1' }],
  ['mimo-oauth', 'no key', { uid: '1' }],
  ['antigravity-oauth', 'camelCase fields', { access_token: 'a', refresh_token: 'r', expiresAt: NOW + 3_600_000, projectId: 'p-1', userId: 'u-1', email: 'ag@x.test', tier_id: 'tier' }],
  ['antigravity-oauth', 'refresh token missing', { access_token: 'a', expires_at: NOW + 3_600_000 }],
  ['cursor-oauth', 'valid with a refresh token, identity from the token', { access_token: userToken(3600), refresh_token: 'r' }],
  ['cursor-oauth', 'stored identity and expiry', { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + 3_600_000, identity: { id: 'c1', email: 'c@x.test' } }],
  ['cursor-oauth', 'expired, refresh token held', { access_token: userToken(-100), refresh_token: 'r' }],
  ['cursor-oauth', 'expired without a refresh token', { access_token: userToken(-100) }],
  ['cursor-oauth', 'about to expire', { access_token: userToken(120), refresh_token: 'r' }],
  ['cursor-oauth', 'access only, valid', { access_token: userToken(3600) }],
  ['cursor-oauth', 'reauth required', { access_token: userToken(3600), refresh_token: 'r', reauth_required: true }],
  ['cursor-oauth', 'no expiry known', { access_token: 'opaque', refresh_token: 'r' }],
  ['cursor-oauth', 'no access token', { refresh_token: 'r' }],
  ['cursor-oauth', 'token from CURSOR_ACCESS_TOKEN', null, { CURSOR_ACCESS_TOKEN: userToken(3600) }],
  ['cursor-oauth', 'CURSOR_ACCESS_TOKEN beside a file: the variable wins', { access_token: userToken(3600), refresh_token: 'r' }, { CURSOR_ACCESS_TOKEN: userToken(-100) }],
  ['devin-oauth', 'valid, identity from the token', { access_token: userToken(3600) }],
  ['devin-oauth', 'expired', { access_token: userToken(-100), identity: { id: 'd1' } }],
  ['devin-oauth', 'opaque token, no expiry', { access_token: 'opaque' }],
  ['devin-oauth', 'no access token', {}],
];

const norm = (value) => JSON.parse(JSON.stringify(value ?? null, (key, v) => (typeof v === 'string' ? v.split(dataDir).join('{dataDir}').replace(/\\/g, '/') : v)));
const strip = (loaded) => {
  if (!loaded || typeof loaded !== 'object') return loaded ?? null;
  const { mtimeMs, _mtimeMs, ...rest } = loaded;
  return rest;
};

const scenarios = [];
for (const [provider, name, raw, env = {}] of SCENARIOS) {
  const { m, describe, load, file } = modules[provider];
  const path = join(dataDir, file);
  mkdirSync(dirname(path), { recursive: true });
  if (raw !== null) writeFileSync(path, typeof raw === 'string' ? raw : JSON.stringify(raw));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const loaded = load ? m[load]() ?? null : undefined;
  const described = m[describe]();
  scenarios.push({
    provider,
    name,
    raw,
    env,
    loadedRecorded: Boolean(load),
    loaded: load ? norm(strip(loaded)) : null,
    described: norm(described),
  });
  for (const key of Object.keys(env)) delete process.env[key];
  rmSync(path, { force: true });
}

// The file each provider reads: its default, a variable naming another file (absolute, and
// relative to the working directory).
const paths = [];
const cwd = process.cwd();
process.chdir(dataDir);
for (const [provider, { m, file, env }] of Object.entries(modules)) {
  if (!m.getOwnTokenPath) continue;
  const row = { provider, default: norm(m.getOwnTokenPath()), expectedDefault: `{dataDir}/${file}` };
  process.env[env] = join(dataDir, 'elsewhere', `${provider}.json`);
  row.absolute = norm(m.getOwnTokenPath());
  process.env[env] = join('relative', `${provider}.json`);
  row.relative = norm(m.getOwnTokenPath());
  delete process.env[env];
  if (row.default !== row.expectedDefault) throw new Error(`${provider}: the default file is ${row.default}, not ${row.expectedDefault}`);
  paths.push(row);
}
process.chdir(cwd);

writeJson(join(stage, 'golden.json'), { now: NOW, scenarios, paths });
writeSetManifest(stage, { set: 'oauth-credentials', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
