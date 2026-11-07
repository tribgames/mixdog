#!/usr/bin/env node
// Golden twin of the production ports under `OAuthUsage` (providers/oauth-usage.mjs): the requests
// Node's usage fetch puts on the wire (url, method, header order and spelling, body, redirect mode,
// timeout), what it does with a transport failure, a redirect and a status, and the quota history it
// leaves in the usage ledger. Node's real `fetchOAuthUsageSnapshot` / `consumeOpenAICodexResetCredit`
// run over a scripted `globalThis.fetch`, a frozen clock and a real ledger on a temp path. The
// credential is an injected provider (ensureAuth), so the flows pin the HTTP, the Grok version
// headers and the history, not the credential files.
//
// Every user directory is a temp dir before any Mixdog module loads.
//   node benchmarks/rust-core/recorders/record-usage-ports.mjs --tree <dir with node_modules> [--out <dir>]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'usage-ports');
const base = mkdtempSync(join(tmpdir(), 'usage-ports-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = join(base, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
process.env.MIXDOG_GROK_CLIENT_VERSION = '9.9.9';
delete process.env.NODE_TEST_CONTEXT;
const NOW = 1_800_000_000_000;
Date.now = () => NOW;

const usage = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/oauth-usage.mjs');
const ledgerModule = await importFrom(tree, 'src/runtime/shared/llm/usage-ledger.mjs');

let timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => {
  timeouts.push(ms);
  return realTimeout(2_147_000_000);
};
let script = [];
let wire = [];
globalThis.fetch = async (url, options = {}) => {
  const timeout = timeouts.shift() ?? null;
  const call = {
    url: String(url),
    method: options.method ?? 'GET',
    headers: Object.entries(options.headers ?? {}),
    body: options.body ?? null,
    redirect: options.redirect ?? null,
    timeoutMs: timeout,
  };
  wire.push(call);
  const next = script.find((entry) => entry.url === call.url && !entry.used);
  if (!next) throw new TypeError('fetch failed');
  next.used = true;
  if (next.fail) throw new TypeError('fetch failed');
  return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
};

const URLS = {
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  credits: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  consume: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  billing: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  billingLegacy: 'https://cli-chat-proxy.grok.com/v1/billing',
  limits: 'https://cli-chat-proxy.grok.com/v1/rate_limits',
};
const WHAM = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_after_seconds: 600 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 90000 },
  },
};
const ANTHROPIC = {
  five_hour: { utilization: 33.3333, resets_at: '2027-01-01T00:00:00Z' },
  seven_day: { utilization: 71, resets_at: '2027-01-05T00:00:00Z' },
};
const GROK_BILLING = { monthlyLimit: { val: 100 }, used: { val: 25 }, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2027-02-01T00:00:00Z' } };
// Node's cadence reader calls .toUpperCase() on a null when the period names no type: that billing
// answer throws and is skipped, so the generic probes run (kept as recorded).
const GROK_TYPELESS = { monthlyLimit: { val: 100 }, used: { val: 25 } };
const GROK_LEGACY = { config: { monthlyLimit: 50, used: 5, current_period: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2027-02-01T00:00:00Z' } } };

const flows = [
  { name: 'codex usage and reset credits', provider: 'openai-oauth', auth: { access_token: 'tok-o', account_id: 'acct-1' }, replies: [{ url: URLS.codex, body: WHAM }, { url: URLS.credits, body: { credits: [] } }] },
  { name: 'codex usage without an account id', provider: 'openai-oauth', auth: { accessToken: 'tok-o2' }, replies: [{ url: URLS.codex, body: WHAM }, { url: URLS.credits, status: 404, body: {} }] },
  { name: 'codex usage rejected', provider: 'openai-oauth', auth: { access_token: 'tok-o', account_id: 'acct-1' }, replies: [{ url: URLS.codex, status: 500, body: {} }, { url: URLS.credits, body: {} }] },
  { name: 'codex usage transport failure', provider: 'openai-oauth', auth: { access_token: 'tok-o', account_id: 'acct-1' }, replies: [{ url: URLS.codex, fail: true }, { url: URLS.credits, fail: true }] },
  { name: 'anthropic usage', provider: 'anthropic-oauth', auth: { accessToken: 'tok-a' }, replies: [{ url: URLS.anthropic, body: ANTHROPIC }] },
  { name: 'anthropic usage redirected', provider: 'anthropic-oauth', auth: { accessToken: 'tok-a' }, replies: [{ url: URLS.anthropic, fail: true }] },
  { name: 'anthropic 401 then refreshed', provider: 'anthropic-oauth', auth: { accessToken: 'tok-a' }, forcedAuth: { accessToken: 'tok-a2' }, replies: [{ url: URLS.anthropic, status: 401, body: {} }, { url: URLS.anthropic, body: ANTHROPIC }] },
  { name: 'anthropic 403 twice', provider: 'anthropic-oauth', auth: { accessToken: 'tok-a' }, forcedAuth: { accessToken: 'tok-a2' }, replies: [{ url: URLS.anthropic, status: 403, body: {} }, { url: URLS.anthropic, status: 403, body: {} }] },
  { name: 'anthropic without a token', provider: 'anthropic-oauth', auth: {}, replies: [] },
  { name: 'grok billing', provider: 'grok-oauth', auth: { access_token: 'tok-g', user_id: 'u-1' }, replies: [{ url: URLS.billing, body: GROK_BILLING }] },
  { name: 'grok billing falls back to the legacy shape then the generic', provider: 'grok-oauth', auth: { access_token: 'tok-g', userId: 'u-2' }, replies: [{ url: URLS.billing, status: 500, body: {} }, { url: URLS.billingLegacy, status: 404, body: {} }, { url: URLS.limits, body: { rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } }] },
  { name: 'grok legacy billing shape', provider: 'grok-oauth', auth: { access_token: 'tok-g', user_id: 'u-3' }, replies: [{ url: URLS.billing, status: 500, body: {} }, { url: URLS.billingLegacy, body: GROK_LEGACY }] },
  { name: 'grok billing without a period type is skipped', provider: 'grok-oauth', auth: { access_token: 'tok-g', user_id: 'u-4' }, replies: [{ url: URLS.billing, body: GROK_TYPELESS }, { url: URLS.billingLegacy, body: GROK_TYPELESS }, { url: URLS.limits, body: { rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } }] },
  ...[
    ['grok billing: blank period type is skipped', { currentPeriod: { type: '  ' }, monthlyLimit: 100, used: 5 }],
    ['grok billing: non-string period type is skipped', { currentPeriod: { type: 7 }, monthlyLimit: 100, used: 5 }],
    ['grok billing: unified answer without a type is skipped', { isUnifiedBillingUser: true, creditUsagePercent: { val: 40 } }],
    ['grok billing: a period without a type defers to current_period', { currentPeriod: { end: '2027-02-01T00:00:00Z' }, current_period: { type: 'USAGE_PERIOD_TYPE_WEEKLY' }, weeklyLimit: 10, used: 1 }],
    ['grok billing: an unnamed type falls back to the period length', { currentPeriod: { type: 'OTHER' }, monthlyLimit: 10, used: 1, billingPeriodStart: '2027-01-01T00:00:00Z', billingPeriodEnd: '2027-01-08T00:00:00Z' }],
    ['grok billing: the type is read case-insensitively', { currentPeriod: { type: 'usage_period_type_monthly' }, monthlyLimit: 10, used: 1 }],
  ].map(([name, body]) => ({
    name,
    provider: 'grok-oauth',
    auth: { access_token: 'tok-g', user_id: 'u-5' },
    replies: [{ url: URLS.billing, body }, { url: URLS.billingLegacy, body }, { url: URLS.limits, body: { rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } }],
  })),  { name: 'grok without a user id', provider: 'grok-oauth', auth: { key: 'tok-key' }, replies: [{ url: URLS.billing, body: GROK_BILLING }] },
];

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
// What the usage fetch hands the ledger (`recordQuotaQueued(samples)`), taken at the ledger's door.
let queued = [];
const watchLedger = () => {
  const ledger = ledgerModule.getUsageLedger();
  const original = ledger.recordQuotaQueued.bind(ledger);
  ledger.recordQuotaQueued = (samples) => {
    queued.push(plain(samples));
    return original(samples);
  };
  return ledger;
};
const settleHistory = async (ledger) => {
  for (let i = 0; i < 100 && queued.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  await Promise.allSettled([...ledger.quotaWrites]);
  await ledger.settleWrites();
  return queued;
};
const results = [];
let n = 0;
for (const flow of flows) {
  n += 1;
  const account = `acct-${String(n).padStart(2, '0')}`;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(base, `ledger-${n}`, 'ledger.sqlite');
  mkdirSync(join(base, `ledger-${n}`), { recursive: true });
  script = flow.replies.map((r) => ({ ...r }));
  wire = [];
  timeouts = [];
  queued = [];
  const ledger = watchLedger();
  const authCalls = [];
  let refreshed = false;
  const providerObj = {
    ensureAuth: async (options = {}) => {
      authCalls.push(plain(options));
      // A forced refresh leaves the refreshed credential behind, as the real providers do.
      if (options.forceRefresh) refreshed = true;
      return refreshed && flow.forcedAuth ? flow.forcedAuth : flow.auth;
    },
  };
  const logs = [];
  let snapshot;
  let error = null;
  try {
    snapshot = await usage.fetchOAuthUsageSnapshot({ provider: flow.provider, model: '', accountId: account }, providerObj, (m) => logs.push(String(m)), { force: true });
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const history = await settleHistory(ledger);
  results.push({
    name: flow.name,
    provider: flow.provider,
    account,
    auth: flow.auth,
    forcedAuth: flow.forcedAuth ?? null,
    replies: flow.replies,
    authCalls,
    wire,
    snapshotNull: snapshot == null,
    windows: plain(snapshot?.quotaWindows?.map((w) => ({ label: w.label, usedPct: w.usedPct ?? null, resetAt: w.resetAt ?? null })) ?? []),
    error,
    history,
  });
  ledgerModule.closeUsageLedgers?.();
}

// The redeem POST: one replay after a transport failure.
async function redeem(name, replies) {
  n += 1;
  script = replies.map((r) => ({ ...r }));
  wire = [];
  timeouts = [];
  const revision = `v1:${'a'.repeat(64)}`;
  const key = '11111111-1111-4111-8111-111111111111';
  let out;
  try {
    out = { value: plain((await usage.consumeOpenAICodexResetCredit({ ensureAuth: async () => ({ access_token: 'tok-o', account_id: 'acct-1' }) }, { expectedOfferRevision: revision, idempotencyKey: key })).outcome) };
  } catch (e) {
    out = { error: String(e?.message ?? e) };
  }
  results.push({ name, provider: 'openai-oauth', redeem: true, key, replies, wire, ...out });
}
await redeem('redeem resets', [{ url: URLS.consume, body: { code: 'reset' } }, { url: URLS.credits, body: { credits: [] } }]);
await redeem('redeem replays once after a transport failure', [{ url: URLS.consume, fail: true }, { url: URLS.consume, body: { code: 'already_redeemed' } }, { url: URLS.credits, fail: true }]);
await redeem('redeem refused', [{ url: URLS.consume, status: 500, body: {} }]);

writeJson(join(outDir, 'usage-ports-twin.json'), {
  domain: 'usage-ports-twin',
  recorder: 'benchmarks/rust-core/recorders/record-usage-ports.mjs',
  now: NOW,
  grokVersion: '9.9.9',
  flows: results,
});
writeSetManifest(outDir, {
  set: 'usage-ports',
  recorder: 'benchmarks/rust-core/recorders/record-usage-ports.mjs',
  command: 'node benchmarks/rust-core/recorders/record-usage-ports.mjs --tree <tree>',
  identityTree: tree,
});
for (const r of results) console.log(r.name, '|', r.wire.map((w) => `${w.method} ${w.url.slice(8, 60)} t=${w.timeoutMs}`).join(' ; '), '|', r.error ?? r.value ?? (r.snapshotNull ? 'null' : `${r.windows.length} windows, ${r.history.length} hist`));
