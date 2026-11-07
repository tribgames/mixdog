#!/usr/bin/env node
// Golden twin of `api-usage.mjs`: the API-key providers' balance and usage lookups
// (`fetchApiUsageSnapshot`, `readCachedApiUsageSnapshot`): DeepSeek's balance, OpenAI's credit
// grants / dashboard / organization costs / completion usage, Anthropic's cost report, Gemini's key
// probe and xAI's prepaid balance, with the requests each puts on the wire, the 5-minute and
// 1-hour cache, and every failure shape. Node's real module runs on a temp data dir, a scripted
// `fetch`, a frozen clock and a keychain stub (the environment and the stub are the only key
// sources, so no real credential is read).
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-api-usage.mjs --tree <dir with node_modules> [--out <dir>]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'api-usage');
const base = mkdtempSync(join(tmpdir(), 'api-usage-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_MODEL_PROXY;
delete process.env.NODE_TEST_CONTEXT;

// The keychain is the one place a stored key could come from besides the environment: stub it.
const secrets = {};
const keychain = createRequire(join(tree, 'package.json'))('./src/lib/keychain-cjs.cjs');
keychain.getSecret = (account) => secrets[account] ?? null;
keychain.getSecretAsync = async (account) => secrets[account] ?? null;
keychain.hasSecret = (account) => Boolean(secrets[account]);

let NOW = 1_800_000_000_000;
Date.now = () => NOW;

const KEY_ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY', 'MIXDOG_AGENT_OPENAI_APIKEY', 'MIXDOG_AGENT_XAI_APIKEY', 'OPENAI_USAGE_SESSION_KEY', 'OPENAI_DASHBOARD_SESSION_KEY', 'OPENAI_SESSION_KEY', 'MIXDOG_OPENAI_USAGE_SESSION_KEY', 'MIXDOG_AGENT_OPENAI_USAGESESSIONKEY', 'ANTHROPIC_ADMIN_API_KEY', 'MIXDOG_ANTHROPIC_ADMIN_API_KEY', 'ANTHROPIC_ADMIN_KEY', 'XAI_MANAGEMENT_API_KEY', 'XAI_TEAM_ID'];

const usage = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/api-usage.mjs');

let script = [];
let wire = [];
globalThis.fetch = async (url, options = {}) => {
  wire.push({ url: String(url), method: options.method ?? 'GET', headers: Object.entries(options.headers ?? {}), redirect: options.redirect ?? null });
  const next = script.find((entry) => entry.url === String(url) && !entry.used);
  if (!next) throw new TypeError('fetch failed');
  next.used = true;
  if (next.fail) throw new TypeError('fetch failed');
  return new Response(next.text ?? JSON.stringify(next.body), { status: next.status ?? 200 });
};

const D = 'https://api.deepseek.com/user/balance';
const O_GRANTS = 'https://api.openai.com/dashboard/billing/credit_grants';
const O_SUB = 'https://api.openai.com/dashboard/billing/subscription';
const dayStart = (ms) => new Date(ms).toISOString().slice(0, 10);
const O_USAGE = () => `https://api.openai.com/dashboard/billing/usage?start_date=${dayStart(NOW - 31 * 86_400_000)}&end_date=${dayStart(NOW)}`;
const O_COSTS = () => `https://api.openai.com/v1/organization/costs?start_time=${Math.floor((NOW - 31 * 86_400_000) / 1000)}&limit=31`;
const O_COMP = () => `https://api.openai.com/v1/organization/usage/completions?start_time=${Math.floor((NOW - 31 * 86_400_000) / 1000)}&bucket_width=1d&limit=31`;
const A_COST = () => `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(new Date(NOW - 31 * 86_400_000).toISOString()).replace(/%20/g, '+')}&bucket_width=1d&limit=31`;
const G_MODELS = (key) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
const X_PREPAID = (team) => `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}/prepaid/balance`;
const X_USAGE = 'https://api.x.ai/v1/usage';
const X_LIMITS = 'https://api.x.ai/v1/rate_limits';

const ok = (url, body) => ({ url, status: 200, body });
const bad = (url, status, body) => ({ url, status, body });
const fetchOp = (force = false) => ({ op: 'fetch', force });
const cachedOp = (allowStale) => ({ op: 'cached', ...(allowStale === undefined ? {} : { allowStale }) });
const advance = (ms) => ({ op: 'advance', ms });

// Replies are matched by URL at request time; URL builders that read the clock are resolved lazily.
const flows = [
  // DeepSeek
  { name: 'deepseek balance', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => ok(D, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9' }, { currency: 'usd', total_balance: '12.34567' }] })], ops: [fetchOp()] },
  { name: 'deepseek unavailable account', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '0' }] })], ops: [fetchOp()] },
  { name: 'deepseek without a USD balance', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => ok(D, { balance_infos: [{ currency: 'CNY', total_balance: '9' }] })], ops: [fetchOp()] },
  { name: 'deepseek key from the keychain', provider: 'deepseek', env: {}, secrets: { 'agent.deepseek.apiKey': 'vault-ds' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '5' }] })], ops: [fetchOp()] },
  { name: 'deepseek without a key', provider: 'deepseek', env: {}, replies: [], ops: [fetchOp()] },
  { name: 'deepseek rejected key', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => bad(D, 401, { error: { message: 'Authentication Fails' } })], ops: [fetchOp()] },
  { name: 'deepseek server error', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => bad(D, 500, { error: 'boom' })], ops: [fetchOp()] },
  { name: 'deepseek transport failure', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => ({ url: D, fail: true })], ops: [fetchOp()] },
  { name: 'deepseek not found without a body', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'ds-key' }, replies: [() => ({ url: D, status: 404, text: '' })], ops: [fetchOp()] },
  // cache
  { name: 'a fresh snapshot is served without a request', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'k' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '1' }] })], ops: [fetchOp(), advance(299_999), fetchOp(), cachedOp(false), advance(2), fetchOp()] },
  { name: 'force asks again', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'k' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '1' }] }), () => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '2' }] })], ops: [fetchOp(), fetchOp(true), cachedOp()] },
  { name: 'a stale snapshot is read when stale is allowed', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'k' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '1' }] })], ops: [fetchOp(), advance(3_599_999), cachedOp(), cachedOp(false), advance(2), cachedOp()] },
  { name: 'provider ids are folded', provider: ' DeepSeek ', env: { DEEPSEEK_API_KEY: 'k' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '3' }] })], ops: [fetchOp(), cachedOp()] },
  { name: 'an unknown provider', provider: 'mystery', env: {}, replies: [], ops: [fetchOp(), cachedOp()] },
  { name: 'a failed lookup leaves the cache alone', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'k' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '1' }] }), () => bad(D, 503, {})], ops: [fetchOp(), fetchOp(true), cachedOp()] },
  // OpenAI
  { name: 'openai credit grants', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => ok(O_GRANTS, { total_available: 12.5, total_used: 7.5, total_granted: 20, grants: { data: [{ expires_at: 1_900_000_000 }, { expires_at: 1_950_000_000_000 }, { expires_at: 0 }, {}] } })], ops: [fetchOp()] },
  { name: 'openai credit grants without totals', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => ok(O_GRANTS, { available: '3' })], ops: [fetchOp()] },
  { name: 'openai credit grants with camelCase totals', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => ok(O_GRANTS, { totalAvailable: 1, totalUsed: 2, totalGranted: 3, grants: { data: [{ expiresAt: 1_900_000_000 }] } })], ops: [fetchOp()] },
  { name: 'openai grants tried with the session key first', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o', OPENAI_USAGE_SESSION_KEY: 'sess-1' }, replies: [() => bad(O_GRANTS, 401, {}), () => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'openai session key from the keychain', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, secrets: { 'agent.openai.usageSessionKey': 'vault-sess' }, replies: [() => ok(O_GRANTS, { total_available: 4 })], ops: [fetchOp()] },
  { name: 'openai dashboard billing', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o', OPENAI_DASHBOARD_SESSION_KEY: 'sess-2' }, replies: [() => bad(O_GRANTS, 403, {}), () => bad(O_GRANTS, 403, {}), () => ok(O_SUB, { hard_limit_usd: 100 }), () => ok(O_USAGE(), { total_usage: 2550 })], ops: [fetchOp()] },
  { name: 'openai dashboard with only a limit', provider: 'openai', env: { OPENAI_SESSION_KEY: 'sess-3' }, replies: [() => bad(O_GRANTS, 403, {}), () => ok(O_SUB, { system_hard_limit_usd: '50', soft_limit_usd: 10 }), () => bad(O_USAGE(), 500, {})], ops: [fetchOp()] },
  { name: 'openai dashboard with only usage', provider: 'openai', env: { MIXDOG_OPENAI_USAGE_SESSION_KEY: 'sess-4' }, replies: [() => bad(O_GRANTS, 403, {}), () => bad(O_SUB, 500, {}), () => ok(O_USAGE(), { totalUsage: 100 })], ops: [fetchOp()] },
  { name: 'openai organization costs', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => ok(O_COSTS(), { data: [{ results: [{ amount: { value: 1.25 } }, { amount: { usd: 2 } }, { amount: 3 }, { amount: 'x' }] }, { results: [] }, {}] })], ops: [fetchOp()] },
  { name: 'openai costs without an amount fall to completion usage', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => ok(O_COSTS(), { data: [{ results: [{}] }] }), () => ok(O_COMP(), { data: [{ results: [{ input_tokens: 10, output_tokens: '5', input_cached_tokens: 2, num_model_requests: 3 }, { input_tokens: 1 }] }] })], ops: [fetchOp()] },
  { name: 'openai costs forbidden fall to completion usage', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => bad(O_COSTS(), 403, {}), () => ok(O_COMP(), { data: [] })], ops: [fetchOp()] },
  { name: 'openai completion usage with no data', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => bad(O_COSTS(), 401, {}), () => ok(O_COMP(), {})], ops: [fetchOp()] },
  { name: 'openai costs server error', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => bad(O_COSTS(), 500, { error: { message: 'down' } })], ops: [fetchOp()] },
  { name: 'openai completion usage rejected', provider: 'openai', env: { OPENAI_API_KEY: 'sk-o' }, replies: [() => bad(O_GRANTS, 404, {}), () => bad(O_COSTS(), 404, {}), () => bad(O_COMP(), 401, { error: { message: 'bad key', type: 'x' } })], ops: [fetchOp()] },
  { name: 'openai without any key', provider: 'openai', env: {}, replies: [], ops: [fetchOp()] },
  // Anthropic
  { name: 'anthropic without an admin key', provider: 'anthropic', env: {}, replies: [], ops: [fetchOp()] },
  { name: 'anthropic cost report', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1' }, replies: [() => ok(A_COST(), { data: [{ results: [{ amount: '1250', currency: 'USD' }, { amount: 500 }, { amount: 99, currency: 'EUR' }, { amount: null }] }, { results: [] }] })], ops: [fetchOp()] },
  { name: 'anthropic cost report with no rows', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1' }, replies: [() => ok(A_COST(), { data: [] })], ops: [fetchOp()] },
  { name: 'anthropic cost report without data', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1' }, replies: [() => ok(A_COST(), {})], ops: [fetchOp()] },
  { name: 'anthropic bearer rejected then x-api-key', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1' }, replies: [() => bad(A_COST(), 401, { error: { message: 'bearer no' } }), () => ok(A_COST(), { data: [{ results: [{ amount: 100 }] }] })], ops: [fetchOp()] },
  { name: 'anthropic every attempt rejected', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1', ANTHROPIC_API_KEY: 'api-2' }, replies: [() => bad(A_COST(), 401, { error: { message: 'first' } }), () => bad(A_COST(), 403, { message: 'second' }), () => bad(A_COST(), 404, {}), () => bad(A_COST(), 401, {})], ops: [fetchOp()] },
  { name: 'anthropic admin keys are tried in order and deduplicated', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'same', MIXDOG_ANTHROPIC_ADMIN_API_KEY: ' same ', ANTHROPIC_ADMIN_KEY: 'third', ANTHROPIC_API_KEY: 'same' }, replies: [() => bad(A_COST(), 401, {}), () => bad(A_COST(), 401, {}), () => bad(A_COST(), 401, {}), () => ok(A_COST(), { data: [{ results: [{ amount: 1 }] }] })], ops: [fetchOp()] },
  { name: 'anthropic server error', provider: 'anthropic', env: { ANTHROPIC_ADMIN_API_KEY: 'adm-1' }, replies: [() => bad(A_COST(), 500, {})], ops: [fetchOp()] },
  // Gemini
  { name: 'gemini key valid', provider: 'gemini', env: { GEMINI_API_KEY: 'g key/1' }, replies: [() => ok(G_MODELS('g key/1'), { models: [] })], ops: [fetchOp()] },
  { name: 'gemini key rejected', provider: 'gemini', env: { GEMINI_API_KEY: 'gk' }, replies: [() => bad(G_MODELS('gk'), 400, { error: { code: 400, message: 'API key not valid.' } })], ops: [fetchOp()] },
  { name: 'gemini transport failure', provider: 'gemini', env: { GEMINI_API_KEY: 'gk' }, replies: [], ops: [fetchOp()] },
  { name: 'gemini error object without a message', provider: 'gemini', env: { GEMINI_API_KEY: 'gk' }, replies: [() => bad(G_MODELS('gk'), 500, { error: { code: 500, status: 'INTERNAL' } })], ops: [fetchOp()] },
  { name: 'gemini without a key', provider: 'gemini', env: {}, replies: [], ops: [fetchOp()] },
  // xAI
  { name: 'xai prepaid balance', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 'team/1' }, replies: [() => ok(X_PREPAID('team/1'), { total: { val: '$1,234.50' } })], ops: [fetchOp()] },
  { name: 'xai prepaid balance forms', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 't' }, replies: [() => ok(X_PREPAID('t'), { availableCredits: { cents: 12345 } })], ops: [fetchOp()] },
  { name: 'xai prepaid balance nested', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 't' }, replies: [() => ok(X_PREPAID('t'), { balance: { usd: '  7.5 ' } })], ops: [fetchOp()] },
  { name: 'xai prepaid balance unreadable', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 't' }, replies: [() => ok(X_PREPAID('t'), { total: 'many' })], ops: [fetchOp()] },
  { name: 'xai prepaid forbidden', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 't' }, replies: [() => bad(X_PREPAID('t'), 403, { error: 'no access' })], ops: [fetchOp()] },
  { name: 'xai prepaid server error', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_TEAM_ID: 't' }, replies: [() => bad(X_PREPAID('t'), 502, {})], ops: [fetchOp()] },
  { name: 'xai public usage probe', provider: 'xai', env: { XAI_API_KEY: 'xk' }, replies: [() => ok(X_USAGE, { credit_balance: 3.25 })], ops: [fetchOp()] },
  { name: 'xai public probe falls to the second url', provider: 'xai', env: { GROK_API_KEY: 'xk' }, replies: [() => bad(X_USAGE, 404, {}), () => ok(X_LIMITS, { credits: '2' })], ops: [fetchOp()] },
  { name: 'xai public probe unsupported data', provider: 'xai', env: { XAI_API_KEY: 'xk' }, replies: [() => ok(X_USAGE, { requests: 3 })], ops: [fetchOp()] },
  { name: 'xai public probes all fail', provider: 'xai', env: { MIXDOG_AGENT_XAI_APIKEY: 'xk' }, replies: [() => bad(X_USAGE, 429, { error: { message: 'slow down' } }), () => bad(X_LIMITS, 500, {})], ops: [fetchOp()] },
  { name: 'xai nothing configured', provider: 'xai', env: {}, replies: [], ops: [fetchOp()] },
  { name: 'xai management key without a team', provider: 'xai', env: { XAI_MANAGEMENT_API_KEY: 'mgmt', XAI_API_KEY: 'xk' }, replies: [() => ok(X_USAGE, { balance: 1 })], ops: [fetchOp()] },
  // a cache file written by another process
  { name: 'a snapshot another process wrote', provider: 'deepseek', env: { DEEPSEEK_API_KEY: 'k' }, seed: (at) => ({ version: 1, updatedAt: at, snapshots: { deepseek: { provider: 'deepseek', balance: { remainingUsd: 9 }, cachedAt: at - 10_000 }, openai: { provider: 'openai', source: 'x', cachedAt: at - 10_000 }, gemini: { unavailable: { message: 'x' }, cachedAt: at - 400_000 } } }), replies: [], ops: [cachedOp(), fetchOp(), cachedOp('gemini-skip')] },
  // Key precedence with several sources set at once, and the remote-client mode (the Authorization header of
  // each request shows which key was used). `getAgentApiKey`: standard env, MIXDOG_AGENT_<ID>_APIKEY, aliases, keychain.
  { name: 'xai key: standard, MIXDOG_AGENT and alias all set', provider: 'xai', env: { XAI_API_KEY: 'k-std', MIXDOG_AGENT_XAI_APIKEY: 'k-own', GROK_API_KEY: 'k-alias' }, secrets: { 'agent.xai.apiKey': 'k-vault' }, replies: [() => ok(X_USAGE, { credit_balance: 1 })], ops: [fetchOp()] },
  { name: 'xai key: MIXDOG_AGENT beats the alias', provider: 'xai', env: { MIXDOG_AGENT_XAI_APIKEY: 'k-own', GROK_API_KEY: 'k-alias' }, secrets: { 'agent.xai.apiKey': 'k-vault' }, replies: [() => ok(X_USAGE, { credit_balance: 1 })], ops: [fetchOp()] },
  { name: 'xai key: the alias beats the keychain', provider: 'xai', env: { GROK_API_KEY: 'k-alias' }, secrets: { 'agent.xai.apiKey': 'k-vault' }, replies: [() => ok(X_USAGE, { credit_balance: 1 })], ops: [fetchOp()] },
  { name: 'xai key: an empty standard name falls through', provider: 'xai', env: { XAI_API_KEY: '', MIXDOG_AGENT_XAI_APIKEY: 'k-own' }, replies: [() => ok(X_USAGE, { credit_balance: 1 })], ops: [fetchOp()] },
  { name: 'xai key: remote-client mode has no agent key', provider: 'xai', remote: true, env: { XAI_API_KEY: 'k-std', GROK_API_KEY: 'k-alias' }, secrets: { 'agent.xai.apiKey': 'k-vault' }, replies: [() => ok(X_USAGE, { credit_balance: 1 })], ops: [fetchOp()] },
  { name: 'openai key: standard beats MIXDOG_AGENT and the keychain', provider: 'openai', env: { OPENAI_API_KEY: 'k-std', MIXDOG_AGENT_OPENAI_APIKEY: 'k-own' }, secrets: { 'agent.openai.apiKey': 'k-vault' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'openai key: MIXDOG_AGENT beats the keychain', provider: 'openai', env: { MIXDOG_AGENT_OPENAI_APIKEY: 'k-own' }, secrets: { 'agent.openai.apiKey': 'k-vault' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'openai key: remote-client mode has no agent key', provider: 'openai', remote: true, env: { OPENAI_API_KEY: 'k-std' }, secrets: { 'agent.openai.apiKey': 'k-vault' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'anthropic key: the stored agent key follows the admin keys', provider: 'anthropic', env: { ANTHROPIC_API_KEY: 'k-std', ANTHROPIC_ADMIN_KEY: 'k-admin' }, secrets: { 'agent.anthropic.apiKey': 'k-vault' }, replies: [() => ok(A_COST(), { data: [{ results: [{ amount: 100 }] }] })], ops: [fetchOp()] },
  { name: 'anthropic key: remote-client mode keeps the admin keys only', provider: 'anthropic', remote: true, env: { ANTHROPIC_API_KEY: 'k-std', ANTHROPIC_ADMIN_KEY: 'k-admin' }, replies: [() => bad(A_COST(), 401, {}), () => bad(A_COST(), 401, {}), () => bad(A_COST(), 401, {}), () => bad(A_COST(), 401, {})], ops: [fetchOp()] },
  { name: 'gemini key: remote-client mode has no agent key', provider: 'gemini', remote: true, env: { GEMINI_API_KEY: 'k-std' }, secrets: { 'agent.gemini.apiKey': 'k-vault' }, replies: [() => ok(G_MODELS('k-std'), { models: [] })], ops: [fetchOp()] },
  { name: 'deepseek key: remote-client mode has no agent key', provider: 'deepseek', remote: true, env: { DEEPSEEK_API_KEY: 'k-std' }, replies: [() => ok(D, { balance_infos: [{ currency: 'USD', total_balance: '5' }] })], ops: [fetchOp()] },
  // `getOpenAIUsageSessionKey`: five env names in order, then the keychain; there is no remote-client guard.
  { name: 'session key: every env name set', provider: 'openai', env: { OPENAI_USAGE_SESSION_KEY: 's1', OPENAI_DASHBOARD_SESSION_KEY: 's2', OPENAI_SESSION_KEY: 's3', MIXDOG_OPENAI_USAGE_SESSION_KEY: 's4', MIXDOG_AGENT_OPENAI_USAGESESSIONKEY: 's5' }, secrets: { 'agent.openai.usageSessionKey': 's6' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: the dashboard name is next', provider: 'openai', env: { OPENAI_DASHBOARD_SESSION_KEY: 's2', OPENAI_SESSION_KEY: 's3', MIXDOG_OPENAI_USAGE_SESSION_KEY: 's4', MIXDOG_AGENT_OPENAI_USAGESESSIONKEY: 's5' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: OPENAI_SESSION_KEY is third', provider: 'openai', env: { OPENAI_SESSION_KEY: 's3', MIXDOG_OPENAI_USAGE_SESSION_KEY: 's4', MIXDOG_AGENT_OPENAI_USAGESESSIONKEY: 's5' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: the MIXDOG name beats the account name', provider: 'openai', env: { MIXDOG_OPENAI_USAGE_SESSION_KEY: 's4', MIXDOG_AGENT_OPENAI_USAGESESSIONKEY: 's5' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: the account env name beats the keychain', provider: 'openai', env: { MIXDOG_AGENT_OPENAI_USAGESESSIONKEY: 's5' }, secrets: { 'agent.openai.usageSessionKey': 's6' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: empty env names fall through to the keychain', provider: 'openai', env: { OPENAI_USAGE_SESSION_KEY: '', OPENAI_SESSION_KEY: '' }, secrets: { 'agent.openai.usageSessionKey': 's6' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: remote-client mode still reads the env', provider: 'openai', remote: true, env: { OPENAI_API_KEY: 'k-std', OPENAI_USAGE_SESSION_KEY: 's1' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: remote-client mode still reads the keychain', provider: 'openai', remote: true, env: { OPENAI_API_KEY: 'k-std' }, secrets: { 'agent.openai.usageSessionKey': 's6' }, replies: [() => ok(O_GRANTS, { total_available: 1 })], ops: [fetchOp()] },
  { name: 'session key: remote-client mode with a session key only, dashboard', provider: 'openai', remote: true, env: { OPENAI_DASHBOARD_SESSION_KEY: 's2' }, replies: [() => bad(O_GRANTS, 403, {}), () => ok(O_SUB, { hard_limit_usd: 100 }), () => ok(O_USAGE(), { total_usage: 250 })], ops: [fetchOp()] },];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  NOW = 1_800_000_000_000;
  const dataDir = join(base, `data-${n}`);
  mkdirSync(dataDir, { recursive: true });
  process.env.MIXDOG_DATA_DIR = dataDir;
  const cacheFile = join(dataDir, 'api-usage-cache.json');
  const seed = flow.seed ? flow.seed(NOW) : null;
  if (seed) writeFileSync(cacheFile, JSON.stringify(seed));
  for (const name of KEY_ENV) delete process.env[name];
  Object.assign(process.env, flow.env);
  if (flow.remote) process.env.MIXDOG_MODEL_PROXY = 'client';
  else delete process.env.MIXDOG_MODEL_PROXY;
  for (const key of Object.keys(secrets)) delete secrets[key];
  Object.assign(secrets, flow.secrets ?? {});
  script = [];
  wire = [];
  const lazy = flow.replies;
  const ops = [];
  for (const op of flow.ops) {
    if (op.op === 'advance') {
      NOW += op.ms;
      ops.push({ ...op });
      continue;
    }
    // Resolve the scripted replies at the clock of this op.
    script = lazy.map((make) => ({ ...make() }));
    wire = [];
    let out;
    try {
      if (op.op === 'fetch') out = { value: plain(await usage.fetchApiUsageSnapshot(flow.provider, { force: op.force })) };
      else out = { value: plain(usage.readCachedApiUsageSnapshot(flow.provider, op.allowStale === undefined || op.allowStale === 'gemini-skip' ? {} : { allowStale: op.allowStale })) };
    } catch (error) {
      out = { error: { message: String(error?.message ?? error), status: error?.status ?? null } };
    }
    ops.push({ ...op, now: NOW, wire, ...out });
    // Replies consumed by earlier ops stay consumed for the same flow.
    for (const reply of script) if (reply.used) lazy[script.indexOf(reply)] = () => ({ url: '\u0000consumed', status: 200, body: {} });
  }
  const stored = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
  results.push({
    name: flow.name,
    provider: flow.provider,
    env: flow.env,
    remote: flow.remote === true,
    secrets: flow.secrets ?? {},
    seed,
    replies: flow.replies.map((make) => make()),
    ops,
    stored,
  });
}

writeJson(join(outDir, 'golden.json'), { domain: 'api-usage', recorder: 'benchmarks/rust-core/recorders/record-api-usage.mjs', now: 1_800_000_000_000, flows: results });
writeSetManifest(outDir, {
  set: 'api-usage',
  recorder: 'benchmarks/rust-core/recorders/record-api-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-api-usage.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name.padEnd(58), r.ops.map((o) => (o.op === 'advance' ? `+${o.ms}` : o.error ? `ERR${o.error.status ?? ''}` : `${o.wire.length}req:${o.value?.source ?? (o.value ? 'snap' : 'null')}`)).join(' '));
