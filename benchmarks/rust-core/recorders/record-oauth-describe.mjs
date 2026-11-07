#!/usr/bin/env node
// What each OAuth provider says of its own credential (`describe*OAuthCredentials`) and which
// providers the setup lists (`isOAuthProviderAvailable`): the real functions over credential
// files seeded in a temp data dir, with `Date.now` fixed so a status that depends on the clock
// replays. Each scenario records the raw file, the loaded document (`loadTokens`, the input of
// Rust's builders) and the description. Rust
// `mixdog_core_domains::domains::ai_account::oauth_status::describe_oauth` must build the same
// description, key order included, from the loaded document.
//
// Providers recorded: openai, grok, muse-code, command-code, opencode-go, mimo, antigravity.
// (anthropic, cursor and devin read their credentials elsewhere: a later slice.)
//
//   node benchmarks/rust-core/recorders/record-oauth-describe.mjs [--tree <dir>]
//
// Output: native/core/fixtures/oauth-describe/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'oauth-describe');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-oauth-describe.mjs';
const dataDir = mkdtempSync(join(tmpdir(), 'oauth-describe-rec-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'oauth-describe-home-'));
const at = (path) => importFrom(tree, path);
const P = 'src/runtime/agent/orchestrator/providers/';
const modules = {
  'openai-oauth': { m: await at(`${P}openai-oauth-tokens.mjs`), describe: 'describeOpenAIOAuthCredentials' },
  'grok-oauth': { m: await at(`${P}grok-oauth-tokens.mjs`), describe: 'describeGrokOAuthCredentials' },
  'muse-code-oauth': { m: await at(`${P}muse-code-oauth-tokens.mjs`), describe: 'describeMuseCodeOAuthCredentials' },
  'command-code-oauth': { m: await at(`${P}command-code-oauth-tokens.mjs`), describe: 'describeCommandCodeOAuthCredentials' },
  'opencode-go-oauth': { m: await at(`${P}opencode-go-oauth-tokens.mjs`), describe: 'describeOpenCodeGoOAuthCredentials' },
  'mimo-oauth': { m: await at(`${P}mimo-oauth-tokens.mjs`), describe: 'describeMimoOAuthCredentials' },
  'antigravity-oauth': { m: await at(`${P}antigravity-oauth-tokens.mjs`), describe: 'describeAntigravityOAuthCredentials' },
};
const probes = await at(`${P}oauth-credential-probes.mjs`);

// Only the payload is read; a short header and signature keep the fixture from looking like a real token.
const jwt = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
const secs = (offsetSeconds) => Math.floor(NOW / 1000) + offsetSeconds;
const OPENAI_AUTH = 'https://api.openai.com/auth';
const openaiToken = (offset, extra = {}) =>
  jwt({ exp: secs(offset), sub: 'user-1', email: 'ann@example.com', [OPENAI_AUTH]: { chatgpt_account_id: 'acct_1234567890abcdef', chatgpt_plan_type: 'plus' }, ...extra });
const grokToken = (offset) => jwt({ exp: secs(offset), sub: 'grok-user', principal_type: 'user' });

const SCENARIOS = [
  ['openai-oauth', 'no file', null],
  ['openai-oauth', 'valid sign-in with a refresh token', { access_token: openaiToken(3600), id_token: openaiToken(3600), refresh_token: 'r1' }],
  ['openai-oauth', 'access token expired, refresh token held', { access_token: openaiToken(-100), id_token: openaiToken(-100), refresh_token: 'r1' }],
  ['openai-oauth', 'access token about to expire', { access_token: openaiToken(60), id_token: openaiToken(60), refresh_token: 'r1' }],
  ['openai-oauth', 'access only, still valid', { access_token: openaiToken(3600) }],
  ['openai-oauth', 'access only, expired: not a sign-in', { access_token: openaiToken(-100) }],
  ['openai-oauth', 'opaque tokens with a stored identity and expiry', { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + 3_600_000, account_id: 'abcdefghijklmnop', identity: { id: 'u:a', email: 'e@x.test' } }],
  ['openai-oauth', 'plan only on the access token', { access_token: openaiToken(3600), id_token: jwt({ exp: secs(3600) }), refresh_token: 'r' }],
  ['grok-oauth', 'no file', null],
  ['grok-oauth', 'valid sign-in', { access_token: grokToken(3600), refresh_token: 'r', id_token: jwt({ email: 'g@x.test' }) }],
  ['grok-oauth', 'expired, refresh token held', { access_token: grokToken(-100), refresh_token: 'r', user_id: 'u9', email: 'g@x.test' }],
  ['grok-oauth', 'about to expire', { access_token: grokToken(120), refresh_token: 'r' }],
  ['grok-oauth', 'expiry in seconds', { access_token: 'opaque', refresh_token: 'r', expires_at: secs(7200) }],
  ['grok-oauth', 'no refresh token: not a sign-in', { access_token: grokToken(3600) }],
  ['muse-code-oauth', 'no file', null],
  ['muse-code-oauth', 'valid', { accessToken: 'at', apiKey: 'key', accountId: 'acc-1', email: 'm@x.test' }],
  ['muse-code-oauth', 'key without an account', { accessToken: 'at', apiKey: 'key' }],
  ['muse-code-oauth', 'no api key: not valid', { accessToken: 'at' }],
  ['command-code-oauth', 'no file', null],
  ['command-code-oauth', 'key with user and name', { apiKey: 'cc-key', userId: 'u1', userName: 'Ann' }],
  ['command-code-oauth', 'key only', { apiKey: 'cc-key' }],
  ['opencode-go-oauth', 'no file', null],
  ['opencode-go-oauth', 'valid with an organization', { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3_600_000, account_id: 'acc', email: 'o@x.test', org_id: 'org-1', org_name: 'Acme' }],
  ['opencode-go-oauth', 'valid without an organization', { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3_600_000 }],
  ['opencode-go-oauth', 'expired', { access_token: 'a', refresh_token: 'r', expires_at: NOW - 1000 }],
  ['opencode-go-oauth', 'about to expire', { access_token: 'a', refresh_token: 'r', expires_at: NOW + 60_000 }],
  ['opencode-go-oauth', 'no expiry', { access_token: 'a', refresh_token: 'r' }],
  ['opencode-go-oauth', 'expiry in seconds is already past', { access_token: 'a', refresh_token: 'r', expires_at: secs(7200) }],
  ['mimo-oauth', 'no file', null],
  ['mimo-oauth', 'key with a user id', { apiKey: 'k', uid: '7' }],
  ['mimo-oauth', 'key only', { apiKey: 'k' }],
  ['antigravity-oauth', 'no file', null],
  ['antigravity-oauth', 'signed in with a project and tier', { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3_600_000, email: 'ag@x.test', project_id: 'proj-1', tier_id: 'standard-tier', user_id: 'uid-1' }],
  ['antigravity-oauth', 'expired, refresh token held', { access_token: 'a', refresh_token: 'r', expires_at: NOW - 1000, email: 'ag@x.test' }],
  ['antigravity-oauth', 'no email, no project', { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3_600_000 }],
  ['antigravity-oauth', 'expiry in seconds', { access_token: 'a', refresh_token: 'r', expires_at: secs(7200), email: 'ag@x.test' }],
];

const scenarios = [];
for (const [provider, name, raw] of SCENARIOS) {
  const { m, describe } = modules[provider];
  const path = m.getOwnTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  if (raw) writeFileSync(path, JSON.stringify(raw));
  const { mtimeMs, _mtimeMs, ...loaded } = m.loadTokens() ?? {};
  const hasLoaded = Object.keys(loaded).length > 0 || m.loadTokens() != null;
  const described = m[describe]();
  scenarios.push({ provider, name, raw, loaded: hasLoaded ? JSON.parse(JSON.stringify(loaded)) : null, described: JSON.parse(JSON.stringify(described)) });
  rmSync(path, { force: true });
}

// Which providers the setup lists, by the stored `developer` options.
const IDS = ['openai-oauth', 'anthropic-oauth', 'grok-oauth', 'muse-code-oauth', 'command-code-oauth', 'opencode-go-oauth', 'mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'];
const configPath = join(dataDir, 'mixdog-config.json');
const availability = [];
for (const developer of [undefined, {}, { antigravityOAuth: true }, { cursorOAuth: true, devinOAuth: true, mimoOAuth: true }, { cursorOAuth: 'yes', devinOAuth: 1, mimoOAuth: false }, [true]]) {
  writeFileSync(configPath, JSON.stringify({ agent: developer === undefined ? {} : { developer } }));
  availability.push({ developer: developer ?? null, available: IDS.filter((id) => probes.isOAuthProviderAvailable(id)) });
}
rmSync(configPath, { force: true });

writeJson(join(stage, 'golden.json'), { now: NOW, scenarios, availability });
writeSetManifest(stage, { set: 'oauth-describe', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
