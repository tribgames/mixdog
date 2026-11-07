#!/usr/bin/env node
// Whether a stored OAuth document is a sign-in, per provider (WP-AI-SVC): the REAL Node
// `oauthCredentialProbeState` of providers/oauth-credential-probes.mjs over a credential file written
// with each document below. The ten providers each have their own rule (Anthropic: an access token and
// the `user:inference` scope, valid until its expiry unless a refresh token renews it; OpenAI: an access
// token with a refresh token or an unexpired expiry; Grok / Antigravity: all their tokens; MiMo,
// Command Code, Muse, OpenCode Go: their key fields non-blank; Cursor: an access token that is not
// marked for re-login; Devin: an access token not past its expiry). A stored document the rule rejects
// reads `absent`, as a logout does. The Rust `credential_valid` must answer the same for each.
//
//   node benchmarks/rust-core/recorders/record-oauth-credential-validity.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/oauth-credential-validity/golden.json. Dummy tokens only. Expiries are
// far past (2001) or far future (2096), so the answer does not depend on the day it is replayed. The
// four developer-gated providers are switched on through the stored `developer` settings. Every user
// directory is a fresh temp one BEFORE any product module loads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'oauth-validity-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const FILE_ENV = {
  'anthropic-oauth': 'ANTHROPIC_OAUTH_CREDENTIALS_PATH',
  'openai-oauth': 'OPENAI_OAUTH_CREDENTIALS_PATH',
  'grok-oauth': 'GROK_OAUTH_CREDENTIALS_PATH',
  'mimo-oauth': 'MIMO_OAUTH_CREDENTIALS_PATH',
  'command-code-oauth': 'COMMAND_CODE_OAUTH_CREDENTIALS_PATH',
  'muse-code-oauth': 'MUSE_CODE_OAUTH_CREDENTIALS_PATH',
  'opencode-go-oauth': 'OPENCODE_GO_OAUTH_CREDENTIALS_PATH',
  'antigravity-oauth': 'ANTIGRAVITY_OAUTH_CREDENTIALS_PATH',
  'cursor-oauth': 'CURSOR_OAUTH_CREDENTIALS_PATH',
  'devin-oauth': 'DEVIN_OAUTH_CREDENTIALS_PATH',
};
const files = Object.fromEntries(Object.keys(FILE_ENV).map((provider) => [provider, join(dirs.data, `${provider}.json`)]));
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
  ...Object.fromEntries(Object.entries(FILE_ENV).map(([provider, key]) => [key, files[provider]])),
});
delete process.env.CURSOR_ACCESS_TOKEN;
writeFileSync(
  join(dirs.data, 'mixdog-config.json'),
  JSON.stringify({ agent: { developer: { antigravityOAuth: true, cursorOAuth: true, devinOAuth: true, mimoOAuth: true } } })
);
const { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'oauth-credential-validity');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-credential-validity.mjs';
const PROBES = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs')).href;
const { oauthCredentialProbeState } = await import(PROBES);

const PAST_S = 1_000_000_000;
const FUTURE_S = 4_000_000_000;
const PAST_MS = 1_000_000_000_000;
const FUTURE_MS = 4_000_000_000_000;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
// An unsigned three-part token carrying only `exp` (the expiry readers take the claim, never verify).
// The golden keeps the marker `{ $jwt: exp }`, not the token: a JWT-shaped string is what the secret
// scan refuses, and the replay builds the same token itself.
const jwt = (exp) => ({ $jwt: exp });
const expand = (value) => {
  if (value && typeof value === 'object' && '$jwt' in value) return `${b64({ alg: 'none' })}.${b64({ exp: value.$jwt })}.sig`;
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, expand(inner)]));
  return value;
};
const A = 'dummy-access';
const R = 'dummy-refresh';
const anthropic = (fields) => ({ claudeAiOauth: fields });

const CASES = {
  'anthropic-oauth': [
    ['signed in, no expiry', anthropic({ accessToken: A, scopes: ['user:inference'] })],
    ['expiry zero', anthropic({ accessToken: A, scopes: ['user:inference'], expiresAt: 0 })],
    ['expired without a refresh token', anthropic({ accessToken: A, scopes: ['user:inference'], expiresAt: PAST_MS })],
    ['expired with a refresh token', anthropic({ accessToken: A, refreshToken: R, scopes: ['user:inference'], expiresAt: PAST_MS })],
    ['future expiry', anthropic({ accessToken: A, scopes: ['user:inference'], expiresAt: FUTURE_MS })],
    ['snake case expiry, expired', anthropic({ accessToken: A, scopes: ['user:inference'], expires_at: PAST_MS })],
    ['null camel expiry falls to the snake one', anthropic({ accessToken: A, scopes: ['user:inference'], expiresAt: null, expires_at: PAST_MS })],
    ['no inference scope', anthropic({ accessToken: A, scopes: ['user:profile'] })],
    ['scopes not an array', anthropic({ accessToken: A, scopes: 'user:inference' })],
    ['empty access token', anthropic({ accessToken: '', scopes: ['user:inference'] })],
    ['no oauth key', {}],
    ['oauth not an object', { claudeAiOauth: 'x' }],
  ],
  'openai-oauth': [
    ['access and refresh token', { access_token: A, refresh_token: R }],
    ['access only, future seconds', { access_token: A, expires_at: FUTURE_S }],
    ['access only, past seconds', { access_token: A, expires_at: PAST_S }],
    ['access only, future milliseconds', { access_token: A, expires_at: FUTURE_MS }],
    ['access only, camel case expiry', { access_token: A, expiresAt: FUTURE_S }],
    ['numeric string expiry', { access_token: A, expires_at: String(FUTURE_S) }],
    ['iso string expiry, future', { access_token: A, expires_at: '2096-01-01T00:00:00Z' }],
    ['iso string expiry, past', { access_token: A, expires_at: '2001-01-01T00:00:00Z' }],
    ['unparseable string expiry', { access_token: A, expires_at: 'soon' }],
    ['opaque access token, no expiry', { access_token: A }],
    ['jwt access token, future exp', { access_token: jwt(FUTURE_S) }],
    ['jwt access token, past exp', { access_token: jwt(PAST_S) }],
    ['refresh token without access token', { refresh_token: R }],
  ],
  'grok-oauth': [
    ['both tokens', { access_token: A, refresh_token: R }],
    ['access only', { access_token: A }],
    ['refresh only', { refresh_token: R }],
    ['empty tokens', { access_token: '', refresh_token: '' }],
  ],
  'mimo-oauth': [
    ['api key', { apiKey: 'dummy-key' }],
    ['empty api key', { apiKey: '' }],
    ['no api key', {}],
  ],
  'command-code-oauth': [
    ['api key', { apiKey: 'dummy-key' }],
    ['blank api key', { apiKey: '   ' }],
    ['api key not a string', { apiKey: 5 }],
  ],
  'muse-code-oauth': [
    ['access token and api key', { accessToken: A, apiKey: 'dummy-key' }],
    ['access token only', { accessToken: A }],
    ['blank api key', { accessToken: A, apiKey: '  ' }],
  ],
  'opencode-go-oauth': [
    ['both tokens', { access_token: A, refresh_token: R }],
    ['blank refresh token', { access_token: A, refresh_token: '  ' }],
    ['access only', { access_token: A }],
  ],
  'antigravity-oauth': [
    ['tokens and project', { access_token: A, refresh_token: R, project_id: 'dummy-project' }],
    ['no project', { access_token: A, refresh_token: R }],
    ['empty project', { access_token: A, refresh_token: R, project_id: '' }],
  ],
  'cursor-oauth': [
    ['access token only', { access_token: A }],
    ['marked for re-login', { access_token: A, reauth_required: true }],
    ['marked for re-login, with a refresh token', { access_token: A, refresh_token: R, reauth_required: true }],
    ['expired without a refresh token', { access_token: A, expires_at: PAST_MS }],
    ['expired with a refresh token', { access_token: A, refresh_token: R, expires_at: PAST_MS }],
    ['future expiry', { access_token: A, expires_at: FUTURE_MS }],
    ['empty access token', { access_token: '' }],
  ],
  'devin-oauth': [
    ['access token only', { access_token: A }],
    ['expired', { access_token: A, expires_at: PAST_MS }],
    ['future expiry', { access_token: A, expires_at: FUTURE_MS }],
    ['expiry zero, jwt past exp', { access_token: jwt(PAST_S), expires_at: 0 }],
    ['no expiry field, jwt future exp', { access_token: jwt(FUTURE_S) }],
    ['no access token', { refresh_token: R }],
  ],
};

const recorded = [];
for (const [provider, cases] of Object.entries(CASES)) {
  for (const [name, document] of cases) {
    rmSync(files[provider], { force: true });
    writeFileSync(files[provider], JSON.stringify(expand(document)));
    const state = oauthCredentialProbeState(provider);
    if (state !== 'present' && state !== 'absent') throw new Error(`${provider} ${name}: ${state}`);
    recorded.push({ provider, name, document, state });
  }
}
writeJson(join(stage, 'golden.json'), { cases: recorded });
writeSetManifest(stage, { set: 'oauth-credential-validity', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);