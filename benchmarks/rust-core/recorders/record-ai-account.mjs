#!/usr/bin/env node
// Golden twin of the `account` domain service's Node cores:
//   account-change.json   a roster driven through register / change / remove / clearQuotaState,
//                         with the pool after each step or the thrown error (name + message)
//   oauth-describe.json   every OAuth provider's describe over stored credential documents (clock pinned)
//                         and forget over a signed-in file, twice
//   account-admin.json    provider-admin refusals that throw before any keychain, network or
//                         config write: unknown providers, empty keys, Vertex option checks,
//                         login-option checks, forget of an unconnected account, key-env names,
//                         and the OAuth flow-id check
//
//   node benchmarks/rust-core/recorders/record-ai-account.mjs --tree <dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'ai-account');
const stage = stageSet(finalDir);
const out = (name) => join(stage, name);
const recorder = 'benchmarks/rust-core/recorders/record-ai-account.mjs';
const failure = (error) => ({ error: { name: error?.name, message: error?.message, code: error?.code ?? null } });

const dataDir = mkdtempSync(join(tmpdir(), 'ai-account-'));
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.MIXDOG_MODEL_PROXY;
const accounts = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');
const admin = await importFrom(tree, 'src/session-runtime/services/provider-admin.mjs');
const { createSessionOAuthFlowRegistry } = await importFrom(tree, 'src/tui/session/oauth-flows.mjs');

// ---- roster
const P = 'openai-oauth';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const steps = [
  { op: 'register', id: ID(1), label: 'Work', includeDefault: true },
  { op: 'register', id: ID(2), label: '' },
  { op: 'register', id: ID(3), label: '  Spare  ' },
  { op: 'register', id: 'not-an-id' },
  { op: 'change', change: { selectedId: ID(2) } },
  { op: 'change', change: { selectedId: ID(9) } },
  { op: 'change', change: { selectedId: 'x' } },
  { op: 'change', change: { rename: { id: ID(3), label: ' Renamed ' } } },
  { op: 'change', change: { rename: { id: ID(3), label: '' } } },
  { op: 'change', change: { rename: { id: ID(3), label: 'x'.repeat(81) } } },
  { op: 'change', change: { rename: { id: ID(9), label: 'Ghost' } } },
  { op: 'change', change: { order: [ID(3), 'default', ID(1), ID(2)] } },
  { op: 'change', change: { order: [ID(3), 'default'] } },
  { op: 'change', change: { order: [ID(3), ID(3), ID(1), ID(2)] } },
  { op: 'change', change: { auto: false } },
  { op: 'change', change: { auto: true } },
  { op: 'change', change: { auto: 'yes' } },
  { op: 'change', change: { policy: 'headroom' } },
  { op: 'change', change: { policy: 'manual' } },
  { op: 'change', change: { policy: 'nope' } },
  { op: 'change', change: { useCredits: true } },
  { op: 'change', change: { useCredits: 1 } },
  { op: 'change', change: { surprise: 1 } },
  { op: 'change', change: [] },
  { op: 'change', change: { selectedId: ID(1), auto: true, policy: 'limit', useCredits: false } },
  { op: 'clearQuota', id: ID(1) },
  { op: 'remove', id: ID(1) },
  { op: 'remove', id: ID(1) },
  { op: 'remove', id: 'bad' },
  { op: 'remove', id: ID(2) },
  { op: 'remove', id: ID(3) },
  { op: 'remove', id: 'default' },
];
const rosterSteps = [];
for (const step of steps) {
  let result;
  try {
    if (step.op === 'register') await accounts.registerProviderAccount(P, step.id, { label: step.label, includeDefault: step.includeDefault === true });
    else if (step.op === 'change') await accounts.changeProviderAccounts(P, step.change);
    else if (step.op === 'clearQuota') await accounts.clearProviderAccountQuotaState(P, step.id);
    else if (step.op === 'remove') await accounts.removeProviderAccount(P, step.id);
    result = { pool: accounts.readProviderAccountPool(P) };
  } catch (error) {
    result = failure(error);
  }
  rosterSteps.push({ step, ...result });
}
writeJson(out('account-change.json'), { domain: 'account-change', recorder, provider: P, steps: rosterSteps });

// ---- admin refusals (no keychain, network or config writes happen before these throw)
const cfg = { loadConfig: () => ({}), saveConfig: () => {} };
const cases = [
  { fn: 'saveProviderApiKey', args: ['nope', 'k'] },
  { fn: 'saveProviderApiKey', args: ['openai', '   '] },
  { fn: 'saveProviderApiKey', args: ['', 'k'] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', 'k', { authMode: 'adc' }] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', '{"a":1}', { authMode: 'api-key' }] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', 'abc', { authMode: 'api-key', location: 'eu' }] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', 'abc', { authMode: 'api-key', location: 'Bad_Loc' }] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', 'abc', { authMode: 'api-key', projectId: 'a/b' }] },
  { fn: 'saveProviderApiKey', args: ['vertex-ai', 'not json'] },
  { fn: 'saveOpenAIUsageSessionKey', args: ['  '] },
  { fn: 'forgetProviderAuth', args: ['nope'] },
  { fn: 'forgetProviderAuth', args: ['openai-oauth', '../outside'] },
  { fn: 'forgetProviderAuth', args: ['openai-oauth', ID(7)] },
  { fn: 'loginOAuthProvider', args: ['nope'] },
  { fn: 'beginOAuthProviderLogin', args: ['nope'] },
  { fn: 'beginOAuthProviderLogin', args: ['openai-oauth', { surprise: 1 }] },
  { fn: 'beginOAuthProviderLogin', args: ['openai-oauth', { addAccount: 'yes' }] },
  { fn: 'beginOAuthProviderLogin', args: ['openai-oauth', { label: 'x'.repeat(81) }] },
  { fn: 'beginOAuthProviderLogin', args: ['openai-oauth', { accountId: ID(7) }] },
  { fn: 'beginOAuthProviderLogin', args: ['openai-oauth', { accountId: ID(7), addAccount: true }] },
  { fn: 'listProviderAccounts', args: ['nope'] },
  { fn: 'updateProviderAccounts', args: ['nope', {}] },
  { fn: 'checkCustomProviderKeyEnv', args: ['OK_NAME'], sync: true },
  { fn: 'checkCustomProviderKeyEnv', args: ['1bad'], sync: true },
  { fn: 'checkCustomProviderKeyEnv', args: ['a'.repeat(129)], sync: true },
  { fn: 'checkCustomProviderKeyEnv', args: [5], sync: true },
];
const withCfg = new Set(['saveProviderApiKey', 'saveOpenAIUsageSessionKey', 'forgetProviderAuth', 'loginOAuthProvider', 'beginOAuthProviderLogin']);
const adminCases = [];
for (const c of cases) {
  const args = withCfg.has(c.fn) ? [cfg, ...c.args] : c.args;
  let result;
  try {
    const value = admin[c.fn](...args);
    result = { ok: c.sync ? value : await value };
  } catch (error) {
    result = failure(error);
  }
  adminCases.push({ fn: c.fn, args: c.args, ...result });
}
// The flow registry's id check and pending-flow errors.
const flows = createSessionOAuthFlowRegistry();
const flowCases = [];
for (const [op, id] of [['status', 'nope'], ['status', 'oauth_missing'], ['status', ''], ['cancel', 'oauth_gone'], ['complete', 'oauth_gone']]) {
  try {
    flowCases.push({ op, id, ok: await flows[op](id, 'code') });
  } catch (error) {
    flowCases.push({ op, id, ...failure(error) });
  }
}
writeJson(out('account-admin.json'), { domain: 'account-admin', recorder, cases: adminCases, flowCases });

// ---- per-provider describe / forget over stored credential documents
const NOW = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims) => `h.${b64(claims)}.s`;
const HOUR = 3_600_000;
const OPENAI_AUTH = 'https://api.openai.com/auth';
const accessJwt = jwt({
  exp: (NOW + 2 * HOUR) / 1000,
  sub: 'user-sub',
  email: 'jwt@example.com',
  [OPENAI_AUTH]: { chatgpt_account_id: 'acct12345678xyz', chatgpt_plan_type: 'plus' },
});
const idJwt = jwt({ email: ' id@example.com ', 'https://api.openai.com/profile': { email: 'profile@example.com' } });
const expiredJwt = jwt({ exp: (NOW - HOUR) / 1000 });
const dir = (name) => join(dataDir, name);
const providers = [
  { id: 'anthropic-oauth', mod: 'providers/anthropic-oauth-credentials.mjs', env: 'ANTHROPIC_OAUTH_CREDENTIALS_PATH', describe: 'describeAnthropicOAuthCredentials', forget: 'forgetAnthropicOAuthCredentials',
    docs: (() => {
      const oauth = (extra) => ({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'ref', scopes: ['user:inference', 'user:profile'], expiresAt: NOW + 2 * HOUR, ...extra }, other: { keep: true } });
      return {
        valid: oauth({ subscriptionType: 'max', identity: { id: ' u1 ', email: ' E@x.com ', organizationId: 'o' } }),
        'expired with refresh': oauth({ expiresAt: NOW - HOUR }),
        'expiring soon': oauth({ expiresAt: NOW + 60_000 }),
        'no refresh': oauth({ refreshToken: null }),
        'no refresh expired': oauth({ refreshToken: null, expiresAt: NOW - HOUR }),
        'expires in seconds': oauth({ expiresAt: (NOW + HOUR) / 1000 }),
        'expires_at key': oauth({ expiresAt: undefined, expires_at: NOW + HOUR }),
        'expiry from jwt': oauth({ accessToken: accessJwt, expiresAt: 0 }),
        'missing scope': oauth({ scopes: ['user:profile'] }),
        'no scopes': oauth({ scopes: undefined }),
        'reauth required': oauth({ reauthRequired: true }),
        'no oauth key': { other: 1 },
        'empty access token': oauth({ accessToken: '' }),
      };
    })() },
  { id: 'openai-oauth', mod: 'providers/openai-oauth-tokens.mjs', env: 'OPENAI_OAUTH_CREDENTIALS_PATH', describe: 'describeOpenAIOAuthCredentials', forget: 'forgetOpenAIOAuthCredentials',
    docs: {
      full: { access_token: accessJwt, id_token: idJwt, refresh_token: 'r', expires_at: NOW + 2 * HOUR },
      'expired with refresh': { access_token: accessJwt, refresh_token: 'r', expires_at: NOW - HOUR },
      'expiring soon': { access_token: accessJwt, refresh_token: 'r', expires_at: NOW + 60_000 },
      'no refresh unexpired': { access_token: accessJwt, expires_at: NOW + HOUR },
      'no refresh expired': { access_token: accessJwt, expires_at: NOW - HOUR },
      'no refresh no expiry': { access_token: 'opaque' },
      'expiry from jwt': { access_token: accessJwt, refresh_token: 'r' },
      'expires in seconds': { access_token: 'opaque', refresh_token: 'r', expires_at: (NOW + HOUR) / 1000 },
      'expires iso': { access_token: 'opaque', refresh_token: 'r', expiresAt: '2027-01-15T09:00:00Z' },
      'expires numeric string': { access_token: 'opaque', refresh_token: 'r', expires_at: String(NOW + HOUR) },
      'stored identity and account': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + HOUR, identity: { id: 'stored-id', email: 'stored@example.com' }, account_id: 'abcdefghijklmnop' },
      'opaque tokens': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + HOUR },
      'no access token': { refresh_token: 'r' },
    } },
  { id: 'grok-oauth', mod: 'providers/grok-oauth-tokens.mjs', env: 'GROK_OAUTH_CREDENTIALS_PATH', describe: 'describeGrokOAuthCredentials', forget: 'forgetGrokOAuthCredentials',
    docs: {
      full: { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + HOUR, user_id: 'u-1', email: 'g@example.com' },
      'expired': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW - HOUR },
      'identity from jwt': { access_token: jwt({ exp: (NOW + HOUR) / 1000, principal_id: 'p-9', email: 'x@y.z' }), refresh_token: 'r' },
      'user id from sub': { access_token: jwt({ sub: 'sub-1' }), refresh_token: 'r', expires_at: NOW + HOUR, id_token: jwt({ email: ' tok@example.com ' }) },
      'camel keys': { access_token: 'opaque', refresh_token: 'r', expiresAt: NOW + HOUR, userId: 'cam' },
      'no refresh': { access_token: 'opaque', expires_at: NOW + HOUR },
    } },
  { id: 'mimo-oauth', mod: 'providers/mimo-oauth-tokens.mjs', env: 'MIMO_OAUTH_CREDENTIALS_PATH', describe: 'describeMimoOAuthCredentials', forget: 'forgetMimoOAuthCredentials',
    docs: { key: { apiKey: 'k', uid: 12345 }, 'no uid': { apiKey: 'k' }, 'no key': { uid: 'u' } } },
  { id: 'muse-code-oauth', mod: 'providers/muse-code-oauth-tokens.mjs', env: 'MUSE_CODE_OAUTH_CREDENTIALS_PATH', describe: 'describeMuseCodeOAuthCredentials', forget: 'forgetMuseCodeOAuthCredentials',
    docs: { full: { accessToken: 'a', apiKey: 'k', accountId: 'acc-1', email: 'm@example.com' }, 'only access token': { accessToken: 'a' }, 'blank key': { accessToken: 'a', apiKey: '  ' }, 'no identity': { accessToken: 'a', apiKey: 'k' } } },
  { id: 'command-code-oauth', mod: 'providers/command-code-oauth-tokens.mjs', env: 'COMMAND_CODE_OAUTH_CREDENTIALS_PATH', describe: 'describeCommandCodeOAuthCredentials', forget: 'forgetCommandCodeOAuthCredentials',
    docs: { full: { apiKey: 'k', userId: ' user-1 ', userName: ' Name ' }, 'no name': { apiKey: 'k', userId: 'u' }, 'no user': { apiKey: 'k' }, 'blank key': { apiKey: ' ' } } },
  { id: 'opencode-go-oauth', mod: 'providers/opencode-go-oauth-tokens.mjs', env: 'OPENCODE_GO_OAUTH_CREDENTIALS_PATH', describe: 'describeOpenCodeGoOAuthCredentials', forget: 'forgetOpenCodeGoOAuthCredentials',
    docs: {
      full: { access_token: 'a', refresh_token: 'r', expires_at: NOW + HOUR, account_id: ' acc ', email: 'o@example.com', org_id: 'org1', org_name: 'Org One' },
      'expired': { access_token: 'a', refresh_token: 'r', expires_at: NOW - HOUR },
      'expiring': { access_token: 'a', refresh_token: 'r', expires_at: NOW + 60_000, org_name: 'Org' },
      'no expiry': { access_token: 'a', refresh_token: 'r' },
      'no refresh': { access_token: 'a' },
    } },
  { id: 'cursor-oauth', mod: 'providers/cursor-auth.mjs', env: 'CURSOR_OAUTH_CREDENTIALS_PATH', describe: 'describeCursorOAuthCredentials', forget: 'forgetCursorOAuthCredentials',
    docs: {
      full: { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + HOUR, identity: { id: 'cu', email: 'c@example.com' } },
      'expired with refresh': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW - HOUR },
      'expired no refresh': { access_token: 'opaque', expires_at: NOW - HOUR },
      'expiring': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + 60_000 },
      'access only': { access_token: 'opaque', expires_at: NOW + HOUR },
      'jwt expiry and identity': { access_token: jwt({ exp: (NOW + HOUR) / 1000, sub: 'cursor-sub', email: 'cj@example.com' }) },
      'reauth flagged': { access_token: 'opaque', refresh_token: 'r', expires_at: NOW + HOUR, reauth_required: true },
      'reauth flagged no expiry': { access_token: 'opaque', reauth_required: true },
    },
    envCases: { 'env token': 'opaque-env', 'env jwt': jwt({ exp: (NOW + HOUR) / 1000, sub: 'ignored' }) } },
  { id: 'devin-oauth', mod: 'providers/devin-auth.mjs', env: 'DEVIN_OAUTH_CREDENTIALS_PATH', describe: 'describeDevinOAuthCredentials', forget: 'forgetDevinOAuthCredentials',
    docs: {
      full: { access_token: 'opaque', refresh_token: null, expires_at: NOW + HOUR, identity: { id: 'dv', email: 'd@example.com' } },
      expired: { access_token: 'opaque', expires_at: NOW - HOUR },
      'jwt expiry and identity': { access_token: jwt({ exp: (NOW + HOUR) / 1000, sub: 'dev-sub', email: 'dj@example.com' }) },
      'expired jwt': { access_token: expiredJwt },
      'no expiry': { access_token: 'opaque' },
    } },
  { id: 'antigravity-oauth', mod: 'providers/antigravity-oauth-tokens.mjs', env: 'ANTIGRAVITY_OAUTH_CREDENTIALS_PATH', describe: 'describeAntigravityOAuthCredentials', forget: 'forgetAntigravityOAuthCredentials',
    docs: {
      full: { access_token: 'a', refresh_token: 'r', expires_at: NOW + HOUR, project_id: 'proj', tier_id: 'pro', email: 'ag@example.com', user_id: 'ag-1' },
      expired: { access_token: 'a', refresh_token: 'r', expires_at: NOW - HOUR },
      'camel keys': { access_token: 'a', refresh_token: 'r', expiresAt: NOW + HOUR, projectId: 'p2', userId: 'u2' },
      'no email': { access_token: 'a', refresh_token: 'r', project_id: 'p' },
      'no refresh': { access_token: 'a' },
    } },
];
const describeCases = [];
const forgetCases = [];
const fs = await import('node:fs');
for (const p of providers) {
  const mod = await importFrom(tree, `src/runtime/agent/orchestrator/${p.mod}`);
  const file = join(dataDir, `${p.id}.json`);
  process.env[p.env] = file;
  const scrub = (value) => JSON.parse(JSON.stringify(value ?? null).replaceAll(JSON.stringify(file).slice(1, -1), '<path>'));
  const run = async (name, doc, env) => {
    rmSync(file, { force: true });
    if (doc === 'unreadable') fs.writeFileSync(file, 'not json');
    else if (doc !== undefined) fs.writeFileSync(file, JSON.stringify(doc));
    if (env) process.env.CURSOR_ACCESS_TOKEN = env;
    describeCases.push({ provider: p.id, name, doc: doc ?? null, env: env ?? null, result: scrub(mod[p.describe]()) });
    delete process.env.CURSOR_ACCESS_TOKEN;
  };
  await run('absent', undefined);
  await run('unreadable', 'unreadable');
  for (const [name, doc] of Object.entries(p.docs)) await run(name, doc);
  for (const [name, env] of Object.entries(p.envCases ?? {})) await run(name, undefined, env);
  // forget: with a sign-in, then again, with the file after each
  const firstDoc = Object.values(p.docs)[0];
  rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(firstDoc));
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const first = await mod[p.forget]();
  const afterFirst = read();
  const second = await mod[p.forget]();
  forgetCases.push({ provider: p.id, doc: firstDoc, first, afterFirst, second, afterSecond: read() });
  delete process.env[p.env];
}
Date.now = realNow;
writeJson(out('oauth-describe.json'), { domain: 'oauth-describe', recorder, now: NOW, describeCases, forgetCases });

// ---- the gcloud login `describeVertexAdc` reports, over files in a throwaway config dir
const vertexAuth = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/vertex-ai-auth.mjs');
const SA = { type: 'service_account', client_email: 'sa@p.iam', private_key: 'KEY', project_id: 'sa-proj', private_key_id: 'k1' };
const AU = { type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r', account: 'me@x.com', quota_project_id: 'quota-proj' };
const AU_PLAIN = { ...AU, quota_project_id: undefined };
const IMP_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/t@p.iam:generateAccessToken';
const IMP = { type: 'impersonated_service_account', service_account_impersonation_url: IMP_URL, source_credentials: AU_PLAIN, delegates: ['d@p.iam'] };
const adcFile = (doc) => ({ 'application_default_credentials.json': typeof doc === 'string' ? doc : JSON.stringify(doc) });
const CFG = (project) => `[compute]\nproject = other\n[core]\naccount = a@b.c\nproject = ${project}\n`;
const vertexCases = [
  ['service account', {}, adcFile(SA)],
  ['authorized user with quota project', {}, adcFile(AU)],
  ['authorized user, gcloud config project', {}, { ...adcFile(AU_PLAIN), 'configurations/config_default': CFG('cfg-proj') }],
  ['active configuration', {}, { ...adcFile(AU_PLAIN), active_config: 'work\n', 'configurations/config_work': CFG('work-proj'), 'configurations/config_default': CFG('cfg-proj') }],
  ['config name from env', { CLOUDSDK_ACTIVE_CONFIG_NAME: 'envcfg' }, { ...adcFile(AU_PLAIN), 'configurations/config_envcfg': CFG('env-cfg-proj') }],
  ['bad active config name', {}, { ...adcFile(AU_PLAIN), active_config: 'bad name!', 'configurations/config_default': CFG('cfg-proj') }],
  ['crlf config, project outside core', {}, { ...adcFile(AU_PLAIN), 'configurations/config_default': '[other]\r\nproject = no\r\n[ Core ]\r\n  project   =   crlf-proj  \r\n' }],
  ['environment project wins', { GOOGLE_CLOUD_PROJECT: ' env-proj ' }, adcFile(AU)],
  ['environment order', { GCLOUD_PROJECT: 'late', GCP_PROJECT: 'early' }, adcFile(SA)],
  ['explicit project', {}, adcFile(AU), ' explicit '],
  ['service account without project', {}, adcFile({ ...SA, project_id: '' })],
  ['impersonated', {}, adcFile(IMP)],
  ['impersonated bad url', {}, adcFile({ ...IMP, service_account_impersonation_url: 'https://x/serviceAccounts/a b:generateAccessToken' })],
  ['impersonated unsupported source', {}, adcFile({ ...IMP, source_credentials: { type: 'external_account' } })],
  ['impersonated nested', {}, adcFile({ ...IMP, source_credentials: IMP })],
  ['impersonated no source', {}, adcFile({ ...IMP, source_credentials: undefined })],
  ['service account missing key', {}, adcFile({ type: 'service_account', client_email: 'a@b' })],
  ['authorized user missing fields', {}, adcFile({ type: 'authorized_user', client_id: 'c' })],
  ['unsupported type', {}, adcFile({ type: 'external_account' })],
  ['no type', {}, adcFile({ client_id: 'c' })],
  ['not an object', {}, adcFile('5')],
  ['array', {}, adcFile('[]')],
  ['invalid json', {}, adcFile('{nope')],
  ['missing file', {}, {}],
  ['missing file, metadata server', {}, {}, '', 'meta-proj'],
  ['missing file, metadata server, explicit project', {}, {}, 'mine', 'meta-proj'],
  ['missing file, metadata server, environment project', { VERTEXAI_PROJECT: 'env-v' }, {}, '', 'meta-proj'],
  ['explicit credentials path missing', { GOOGLE_APPLICATION_CREDENTIALS: '<dir>/nope.json' }, {}, '', 'meta-proj'],
  ['explicit credentials path', { GOOGLE_APPLICATION_CREDENTIALS: '<dir>/creds.json' }, { 'creds.json': JSON.stringify(AU) }],
  ['present file ignores metadata', {}, adcFile(SA), '', 'meta-proj'],
];
const metadataFetch = (project) => async () => ({
  ok: true,
  headers: { get: (name) => (name === 'metadata-flavor' ? 'Google' : null) },
  text: async () => project,
});
const vertexResults = [];
for (const [name, extraEnv, files, projectId = '', metadata = null] of vertexCases) {
  const dir = mkdtempSync(join(dataDir, 'adc-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'));
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, content);
  }
  const env = { CLOUDSDK_CONFIG: dir, ...Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [k, v.replaceAll('<dir>', dir)])) };
  const fetchFn = metadata ? metadataFetch(metadata) : fetch;
  if (metadata) await vertexAuth.probeVertexMetadata(fetchFn);
  const raw = JSON.stringify(vertexAuth.describeVertexAdc({ env, projectId, fetchFn }));
  // The temp dir is the only machine-specific text; its separator is the platform's.
  const scrubbed = raw.replaceAll(JSON.stringify(dir).slice(1, -1), '<dir>').replace(/<dir>(\\\\|\/)/g, '<dir>/');
  vertexResults.push({ name, env: Object.fromEntries(Object.entries(extraEnv)), files, projectId, metadata, result: JSON.parse(scrubbed) });
}
writeJson(out('vertex-adc.json'), { domain: 'vertex-adc', recorder, cases: vertexResults });
rmSync(dataDir, { recursive: true, force: true });
writeSetManifest(stage, { set: 'ai-account', recorder, command: 'node benchmarks/rust-core/recorders/record-ai-account.mjs --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
console.log(`recorded ${rosterSteps.length} roster steps, ${adminCases.length} admin cases, ${flowCases.length} flow cases, ${describeCases.length} describe cases, ${forgetCases.length} forget cases`);
