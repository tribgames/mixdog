import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  clearProviderAccountQuotaState,
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
    await clearProviderAccountQuotaState(ag, refusing);
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

test('two buckets refused in turn each stay blocked until their own deadline', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const gateway = createAccountPoolProvider(ag, () => ({
    accountCooldownPolicy: { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs: 0 },
    async send(_messages, model) {
      throw Object.assign(new Error('rate limited'), {
        status: 429,
        code: 'rate_limit_exceeded',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: model.startsWith('gemini') ? '45s' : '90s',
          },
        ],
      });
    },
  }));
  await assert.rejects(gateway.send([], 'gemini-3.8-flash-high', [], {}), /rate limited/);
  const geminiUntil = accountRow(ag, id).blockedUntil;
  await assert.rejects(gateway.send([], 'claude-sonnet-4-6', [], {}), /rate limited/);
  const claudeUntil = accountRow(ag, id).blockedUntil;
  assert.ok(claudeUntil > geminiUntil);
  const at = (now, model) => chooseProviderAccount(readProviderAccountPool(ag), new Set(), now, model)?.id ?? null;
  assert.equal(at(Date.now(), 'gemini-3.1-pro-high'), null, 'the Claude refusal keeps the Gemini block');
  assert.equal(at(Date.now(), 'claude-sonnet-4-6'), null);
  assert.equal(at(geminiUntil + 1, 'gemini-3.1-pro-high'), id, 'the Gemini block ends at its own deadline');
  assert.equal(at(geminiUntil + 1, 'gpt-oss-120b-medium'), null, 'while the Claude/GPT block runs on');
  assert.equal(at(claudeUntil + 1, 'claude-sonnet-4-6'), id);
  assert.equal(providerAccountLimit(accountRow(ag, id))?.scope, 'model');
});

test('a request waits for, and is advised, the deadline of the block holding its own model', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const gateway = (waitForCooldownMs) =>
    createAccountPoolProvider(ag, () => ({
      accountCooldownPolicy: { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs },
      async send(_messages, model) {
        throw Object.assign(new Error('rate limited'), {
          status: 429,
          code: 'rate_limit_exceeded',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: model.startsWith('gemini') ? '45s' : '90s',
            },
          ],
        });
      },
    }));
  await assert.rejects(gateway(0).send([], 'gemini-3.8-flash-high', [], {}), /rate limited/);
  const geminiUntil = accountRow(ag, id).blockedUntil;
  await assert.rejects(gateway(0).send([], 'claude-sonnet-4-6', [], {}), /rate limited/);
  const near = (ms, until) => Math.abs(ms - (until - Date.now())) < 2_000;
  await assert.rejects(gateway(0).send([], 'gemini-3.1-pro-high', [], {}), (error) => {
    assert.equal(error.code, 'rate_limited');
    assert.ok(near(error.retryAfterMs, geminiUntil), `advice ${error.retryAfterMs} is the Gemini deadline`);
    return true;
  });
  resetAccountProbePacing();
  const stop = new AbortController();
  let waitMs = null;
  await assert.rejects(
    gateway(60_000).send([], 'gemini-3.1-pro-high', [], {
      signal: stop.signal,
      onStageChange: (stage, detail) => {
        if (stage !== 'reconnecting' || !(detail?.waitMs > 0)) return;
        waitMs = detail.waitMs;
        stop.abort(new Error('cancelled'));
      },
    }),
    /cancelled/
  );
  assert.ok(waitMs !== null && near(waitMs, geminiUntil), `waits ${waitMs} for the Gemini deadline`);
});

test('a usage reading lifts each bucket block on its own meters', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const until = Date.now() + 3_600_000;
  await blockProviderAccount(ag, id, until, 'gemini-3.8-flash-high', 'retry-after');
  await blockProviderAccount(ag, id, until, 'claude-sonnet-4-6', 'retry-after');
  await recordProviderAccountUsage(ag, id, {
    quotaWindows: antigravityQuotaWindows(antigravitySummary({ thirdParty: 0 })),
  });
  assert.equal(pick(ag, 'claude-sonnet-4-6'), null, 'the full Claude/GPT meter keeps its block');
  await recordProviderAccountUsage(ag, id, {
    quotaWindows: antigravityQuotaWindows(antigravitySummary({ gemini: 0 })),
  });
  assert.equal(pick(ag, 'claude-sonnet-4-6')?.id, id, 'Claude/GPT room lifts its block');
  assert.equal(pick(ag, 'gemini-3.8-flash-high'), null, 'the Gemini block is lifted only by Gemini room');
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  assert.equal(pick(ag, 'gemini-3.8-flash-high')?.id, id);
  assert.equal(accountRow(ag, id).blockedUntil, undefined);
});

test('a new block drops expired predecessors and replaces its own model', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const later = Date.now() + 3_600_000;
  await blockProviderAccount(ag, id, Date.now() - 1, 'gemini-3.8-flash-high');
  await blockProviderAccount(ag, id, later, 'claude-sonnet-4-6');
  assert.equal(accountRow(ag, id).blockedBuckets, undefined, 'the expired Gemini block is dropped');
  await blockProviderAccount(ag, id, later, 'claude-sonnet-4-6');
  assert.equal(accountRow(ag, id).blockedBuckets, undefined, 'a second Claude refusal replaces its own block');
  await blockProviderAccount(ag, id, later, 'gemini-3.8-flash-high');
  assert.deepEqual(
    accountRow(ag, id).blockedBuckets.map((block) => block.blockedModel),
    ['claude-sonnet-4-6']
  );
});

test('an accountBlocked refusal keeps every model off the account', async () => {
  const ag = 'antigravity-oauth';
  const id = await single(ag);
  await recordProviderAccountUsage(ag, id, { quotaWindows: antigravityQuotaWindows(antigravitySummary()) });
  const gateway = createAccountPoolProvider(ag, () => ({
    accountCooldownPolicy: { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs: 0 },
    async send() {
      throw Object.assign(new Error('verify'), {
        status: 403,
        code: 'validation_required',
        accountBlocked: true,
        unsafeToRetry: true,
      });
    },
  }));
  await assert.rejects(gateway.send([], 'gemini-3.8-flash-high', [], {}), /verify/);
  assert.equal(pick(ag, 'gemini-3.1-pro-high'), null);
  assert.equal(pick(ag, 'claude-sonnet-4-6'), null);
  assert.equal(pick(ag, 'gpt-oss-120b-medium'), null);
  assert.deepEqual(providerAccountLimit(accountRow(ag, id)), { scope: 'account' });
});

// Windows as a build before per-model gating stored them: labels only.
const LEGACY_UNTIL = Date.now() + 3 * 3_600_000;
const legacy = (rows) => rows.map(([label, usedPct]) => ({ label, usedPct, resetAt: LEGACY_UNTIL }));
const LEGACY_READINGS = {
  'antigravity-oauth': [
    legacy([
      ['5H', 50],
      ['7D', 50],
      ['5H Claude/GPT', 100],
      ['7D Claude/GPT', 50],
    ]),
    'gemini-3.8-flash-high',
  ],
  'anthropic-oauth': [
    legacy([
      ['5H', 40],
      ['7D', 10],
      ['EXTRA', 100],
    ]),
    'claude-sonnet-4-6',
  ],
  'cursor-oauth': [
    legacy([
      ['Basic', 20],
      ['API', 100],
    ]),
    'auto',
  ],
};

test('upgrade: a roster reading stored before per-model gating does not hold unrelated models', async () => {
  const ids = {};
  for (const provider of Object.keys(LEGACY_READINGS)) ids[provider] = await single(provider);
  const path = join(dir, 'provider-accounts.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  for (const [provider, [windows]] of Object.entries(LEGACY_READINGS)) {
    stored.providers[provider].accounts[0].usage = { windows, checkedAt: Date.now() };
  }
  writeFileSync(path, JSON.stringify(stored));
  for (const [provider, [, model]] of Object.entries(LEGACY_READINGS)) {
    assert.equal(pick(provider, model)?.id, ids[provider], `${provider}: ${model} stays selectable`);
    assert.equal(providerAccountLimit(accountRow(provider, ids[provider])), null);
  }
});

test('upgrade: a cached snapshot stored before per-model gating does not hold unrelated models', async () => {
  const served = [];
  const cache = (provider, quotaWindows) =>
    writeFileSync(
      join(dir, 'gateway-oauth-usage-cache.json'),
      JSON.stringify({ version: 1, routes: { [provider]: { provider, quotaWindows, cachedAt: Date.now() } } })
    );
  for (const [provider, [windows, model]] of Object.entries(LEGACY_READINGS)) {
    for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
    cache(provider, windows);
    const gateway = createAccountPoolProvider(provider, () => ({
      async send(_messages, requested) {
        served.push(requested);
        return { content: 'ok' };
      },
    }));
    assert.equal((await gateway.send([], model, [], {})).content, 'ok', `${provider}: ${model} is served`);
  }
  assert.deepEqual(
    served,
    Object.values(LEGACY_READINGS).map(([, model]) => model)
  );
  // A current reading still holds the models its full window gates.
  const ag = 'antigravity-oauth';
  cache(ag, antigravityQuotaWindows(antigravitySummary({ thirdParty: 0 })));
  const gateway = createAccountPoolProvider(ag, () => ({ send: async () => ({ content: 'ok' }) }));
  await assert.rejects(gateway.send([], 'claude-sonnet-4-6', [], {}), (error) => Boolean(error.quotaExhausted));
  assert.equal((await gateway.send([], 'gemini-3.8-flash-high', [], {})).content, 'ok');
});
