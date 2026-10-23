import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Account-store writes on Windows would spawn icacls for each file; the
// roster logic under test does not depend on file ACLs.
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-pool-scope-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  changeProviderAccounts,
  readProviderAccountPool,
  newProviderAccountId,
  recordProviderAccountUsage,
  chooseProviderAccount,
  providerAccountLimit,
  blockProviderAccount,
  removeProviderAccount,
} = await import('../../../shared/provider-accounts.mjs');
const { createAccountPoolProvider, resetAccountProbePacing } = await import('./account-pool.mjs');
const { antigravityQuotaWindows } = await import('./antigravity-oauth-catalog.mjs');
const { ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY } = await import('./antigravity-retry-policy.mjs');
const { normalizeAnthropicUsage, normalizeOpenAIWhamUsage } = await import('./oauth-usage.mjs');
const { normalizeCursorUsage } = await import('./cursor-wire-normalization.mjs');
const { httpResponseError } = await import('./openai-error-contract.mjs');
const { currentProviderAccountId } = await import('../../../shared/provider-auth-binding.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const RESET = new Date(Date.now() + 3 * 3_600_000).toISOString();

// One connected account, so a refused model has nowhere else to go.
async function single(provider) {
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  const id = newProviderAccountId();
  await registerProviderAccount(provider, id, { label: 'Only' });
  await changeProviderAccounts(provider, { selectedId: id, policy: 'limit', useCredits: false });
  resetAccountProbePacing();
  return id;
}
const pick = (provider, model) => chooseProviderAccount(readProviderAccountPool(provider), new Set(), Date.now(), model);
const accountRow = (provider, id) => readProviderAccountPool(provider).accounts.find((row) => row.id === id);

function antigravitySummary({ gemini = 0.5, thirdParty = 0.5, argon } = {}) {
  const bucket = (bucketId, window, remainingFraction) => ({ bucketId, window, remainingFraction, resetTime: RESET });
  return {
    groups: [
      { buckets: [bucket('gemini-5h', '5h', gemini), bucket('gemini-weekly', 'weekly', 0.5)] },
      { buckets: [bucket('3p-5h', '5h', thirdParty), bucket('3p-weekly', 'weekly', 0.5)] },
      ...(argon === undefined ? [] : [{ buckets: [bucket('gemini-argon-wtu-weekly', 'weekly', argon)] }]),
    ],
  };
}

test('Antigravity: a full Claude/GPT bucket blocks only Claude/GPT models, a full Gemini bucket only Gemini', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary({ thirdParty: 0 })) });
  assert.equal(pick(ag, 'gemini-3.8-flash-high')?.id, id, 'Gemini stays selectable');
  assert.equal(pick(ag, 'claude-opus-4-6-thinking'), null);
  assert.equal(pick(ag, 'gpt-oss-120b-medium'), null);
  assert.deepEqual(providerAccountLimit(accountRow(ag, id)), { scope: 'model', families: ['Claude/GPT'] });

  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary({ gemini: 0 })) });
  assert.equal(pick(ag, 'gemini-3.8-flash-high'), null);
  assert.equal(pick(ag, 'claude-opus-4-6-thinking')?.id, id, 'Claude stays selectable');
  assert.equal(pick(ag, 'gpt-oss-120b-medium')?.id, id);

  // Argon reports its own bucket: the shared Gemini buckets do not gate it, its own does.
  await recordProviderAccountUsage(ag, id, {
    quotaWindows: antigravityQuotaWindows(antigravitySummary({ gemini: 0, argon: 0.4 })),
  });
  assert.equal(pick(ag, 'gemini-4-argon')?.id, id);
  await recordProviderAccountUsage(ag, id, {
    quotaWindows: antigravityQuotaWindows(antigravitySummary({ argon: 0 })),
  });
  assert.equal(pick(ag, 'gemini-4-argon'), null);
  assert.equal(pick(ag, 'gemini-3.8-flash-high')?.id, id);
});

test('a bare 429 on a Gemini model blocks only its bucket until the hinted time; a fresh reading lifts it', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const served = [];
  const gateway = createAccountPoolProvider(ag, () => ({
    accountCooldownPolicy: { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs: 0 },
    async send(_messages, model) {
      if (model.startsWith('gemini')) {
        throw Object.assign(new Error('rate limited'), {
          status: 429,
          code: 'rate_limit_exceeded',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45s' }],
        });
      }
      served.push([currentProviderAccountId(ag), model]);
      return { content: 'ok' };
    },
  }));
  const before = Date.now();
  await assert.rejects(gateway.send([], 'gemini-3.8-flash-high', [], {}), /rate limited/);
  const row = accountRow(ag, id);
  assert.ok(row.blockedUntil >= before + 45_000 && row.blockedUntil <= Date.now() + 45_000, 'expires at the hint');
  assert.equal(pick(ag, 'gemini-3.1-pro-high'), null, 'the whole Gemini bucket waits');
  assert.equal((await gateway.send([], 'claude-sonnet-4-6', [], {})).content, 'ok');
  assert.deepEqual(served, [[id, 'claude-sonnet-4-6']], 'Claude still runs on the same account');
  const later = chooseProviderAccount(readProviderAccountPool(ag), new Set(), row.blockedUntil + 1, 'gemini-3.8-flash-high');
  assert.equal(later?.id, id, 'the block expires at the hinted time');
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary({ thirdParty: 0 })) });
  assert.equal(accountRow(ag, id).blockedUntil, undefined, 'a reading with Gemini room lifts the block');
  assert.equal(pick(ag, 'gemini-3.8-flash-high')?.id, id);
});

test('Anthropic: a full EXTRA window never blocks; 7D Opus blocks only Opus', async () => {
  const anthropic = 'anthropic-oauth';
  const id = await single(anthropic);
  const reading = (opus) =>
    normalizeAnthropicUsage({
      five_hour: { utilization: 40, resets_at: RESET },
      seven_day: { utilization: 10, resets_at: RESET },
      seven_day_opus: { utilization: opus, resets_at: RESET },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 5000, utilization: 100 },
    });
  await recordProviderAccountUsage(anthropic, id, reading(20));
  assert.equal(pick(anthropic, 'claude-sonnet-4-6')?.id, id);
  assert.equal(pick(anthropic, 'claude-opus-4-1')?.id, id);
  assert.equal(providerAccountLimit(accountRow(anthropic, id)), null, 'EXTRA at 100% holds nothing');
  await recordProviderAccountUsage(anthropic, id, reading(100));
  assert.equal(pick(anthropic, 'claude-opus-4-1'), null);
  assert.equal(pick(anthropic, 'claude-sonnet-4-6')?.id, id);
  assert.deepEqual(providerAccountLimit(accountRow(anthropic, id)), { scope: 'model', families: ['Opus'] });
});

test('Codex: additional limits are recorded per limit id; a 429 naming one blocks only it, until the server reset', async () => {
  const openai = 'openai-oauth';
  const id = await single(openai);
  const window = (used) => ({ used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: 600 });
  const reading = normalizeOpenAIWhamUsage({
    plan_type: 'pro',
    rate_limit: { primary_window: window(20), secondary_window: { ...window(10), limit_window_seconds: 604_800 } },
    additional_rate_limits: [
      {
        limit_name: 'GPT-5.3-Codex-Spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: { primary_window: window(30) },
      },
    ],
  });
  assert.deepEqual(
    reading.quotaWindows.map((row) => [row.label, row.limit]),
    [
      ['5H', 'codex'],
      ['7D', 'codex'],
      ['5H GPT-5.3-Codex-Spark', 'codex_bengalfox'],
    ]
  );
  await recordProviderAccountUsage(openai, id, reading);
  const resetAt = Date.now() + 2 * 24 * 3_600_000;
  const served = [];
  const gateway = createAccountPoolProvider(openai, () => ({
    async send(_messages, model) {
      if (model === 'gpt-5.3-codex-spark') {
        throw httpResponseError({
          label: 'OpenAI OAuth',
          status: 429,
          headers: { 'x-codex-active-limit': 'codex_bengalfox' },
          text: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.floor(resetAt / 1000) } }),
        });
      }
      served.push(model);
      return { content: 'ok' };
    },
  }));
  await assert.rejects(gateway.send([], 'gpt-5.3-codex-spark', [], {}), (error) => {
    assert.ok(error.quotaExhausted, 'the refused model reports exhaustion');
    return true;
  });
  const row = accountRow(openai, id);
  assert.equal(row.blockedLimit, 'codex_bengalfox');
  assert.ok(Math.abs(row.blockedUntil - Math.floor(resetAt / 1000) * 1000) < 1_000, 'the server reset, not 6 h');
  assert.equal(pick(openai, 'gpt-5.3-codex-spark'), null);
  assert.equal((await gateway.send([], 'gpt-5.5', [], {})).content, 'ok');
  assert.deepEqual(served, ['gpt-5.5'], 'other models still run on the account');
});

test('an account whose reading comes back empty is measured once, not on every refusal', async () => {
  const ag = 'antigravity-oauth';
  for (const row of readProviderAccountPool(ag).accounts) await removeProviderAccount(ag, row.id);
  const refusing = newProviderAccountId();
  const serving = newProviderAccountId();
  await registerProviderAccount(ag, refusing, { label: 'Refusing' });
  await registerProviderAccount(ag, serving, { label: 'Serving' });
  await changeProviderAccounts(ag, { selectedId: refusing, policy: 'limit', useCredits: false });
  resetAccountProbePacing();
  const readings = [];
  const gateway = createAccountPoolProvider(ag, () => ({
    accountCooldownPolicy: { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs: 0 },
    async getUsageSnapshot() {
      readings.push(currentProviderAccountId(ag));
      return { quotaWindows: [] };
    },
    async send() {
      if (currentProviderAccountId(ag) === refusing) {
        throw Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded' });
      }
      return { content: 'ok' };
    },
  }));
  for (let refusal = 0; refusal < 2; refusal += 1) {
    await blockProviderAccount(ag, refusing, 0);
    await changeProviderAccounts(ag, { selectedId: refusing });
    assert.equal((await gateway.send([], 'gemini-3.8-flash-high', [], {})).content, 'ok');
  }
  assert.deepEqual(readings, [refusing], 'one reading for the account across both refusals');
});

test('Codex: an additional limit without windows leaves its model under the full plan window', async () => {
  const openai = 'openai-oauth';
  const id = await single(openai);
  const reading = normalizeOpenAIWhamUsage({
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
    additional_rate_limits: [
      { limit_name: 'GPT-5.3-Codex-Spark', metered_feature: 'codex_bengalfox', rate_limit: null },
    ],
  });
  assert.equal(reading.quotaWindows[0].except, undefined, 'the plan window gates every model');
  await recordProviderAccountUsage(openai, id, reading);
  assert.equal(pick(openai, 'gpt-5.3-codex-spark'), null);
  assert.equal(pick(openai, 'gpt-5.5'), null);
});

test('an Opus refusal stays blocked while a shared window it draws on is full', async () => {
  const anthropic = 'anthropic-oauth';
  const id = await single(anthropic);
  const until = Date.now() + 3_600_000;
  await blockProviderAccount(anthropic, id, until, 'claude-opus-4-1', 'retry-after', { quota: true });
  await recordProviderAccountUsage(anthropic, id, {
    quotaWindows: [
      { label: '5H', usedPct: 10, resetAt: until },
      { label: '7D', usedPct: 100, resetAt: until },
      { label: '7D Opus', usedPct: 50, resetAt: until },
    ],
  });
  assert.equal(accountRow(anthropic, id).blockedUntil, until, 'the Opus meter alone cannot lift it');
  await recordProviderAccountUsage(anthropic, id, {
    quotaWindows: [
      { label: '5H', usedPct: 10, resetAt: until },
      { label: '7D', usedPct: 40, resetAt: until },
      { label: '7D Opus', usedPct: 50, resetAt: until },
    ],
  });
  assert.equal(accountRow(anthropic, id).blockedUntil, undefined, 'every meter with room lifts it');
});

test('Cursor: a full API pool leaves Auto and Composer usable, and the reverse', async () => {
  const cursor = 'cursor-oauth';
  const id = await single(cursor);
  const cycleEnd = Date.now() + 10 * 24 * 3_600_000;
  const reading = (auto, api) =>
    normalizeCursorUsage({ planUsage: { autoPercentUsed: auto, apiPercentUsed: api }, billingCycleEnd: cycleEnd });
  await recordProviderAccountUsage(cursor, id, reading(20, 100));
  assert.equal(pick(cursor, 'auto')?.id, id);
  assert.equal(pick(cursor, 'default')?.id, id);
  assert.equal(pick(cursor, 'composer-2.5')?.id, id);
  assert.equal(pick(cursor, 'claude-opus-5-high'), null);
  assert.deepEqual(providerAccountLimit(accountRow(cursor, id)), { scope: 'model', families: ['API'] });
  await recordProviderAccountUsage(cursor, id, reading(100, 20));
  assert.equal(pick(cursor, 'auto'), null);
  assert.equal(pick(cursor, 'composer-2.5'), null);
  assert.equal(pick(cursor, 'claude-opus-5-high')?.id, id);
});
