import assert from 'node:assert/strict';
import { test, after, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every account-store write on Windows spawns icacls/PowerShell to lock the
// file to its owner (~0.2-0.5 s each, hundreds of writes here). The roster
// logic under test does not depend on file ACLs, which have their own suite
// (shared/file-permissions.test.mjs, atomic-file.test.mjs).
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-account-pool-quota-'));
process.env.MIXDOG_DATA_DIR = dir;
const {
  registerProviderAccount,
  changeProviderAccounts,
  readProviderAccountPool,
  newProviderAccountId,
  recordProviderAccountUsage,
  blockProviderAccount,
  removeProviderAccount,
} = await import('../../../shared/provider-accounts.mjs');
const { createAccountPoolProvider, resetAccountProbePacing, resetSessionAccountBindings } = await import(
  './account-pool.mjs'
);
const { fetchOAuthUsageSnapshot } = await import('./oauth-usage.mjs');
const { providerErrorKind } = await import('./provider-error-kind.mjs');
const { isProviderRecoveryTerminal } = await import('./retry-executor.mjs');
const { currentProviderAccountId } = await import('../../../shared/provider-auth-binding.mjs');
after(() => rmSync(dir, { recursive: true, force: true }));

const provider = 'cursor-oauth';

async function setup(options = {}) {
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  resetAccountProbePacing();
  const ids = [newProviderAccountId(), newProviderAccountId(), newProviderAccountId()];
  for (const [i, id] of ids.entries()) await registerProviderAccount(provider, id, { label: `Account ${i + 1}` });
  await changeProviderAccounts(provider, { selectedId: ids[0], auto: true, useCredits: false, ...options });
  return ids;
}
function quotaError(retryAfterMs) {
  return Object.assign(new Error('Quota exhausted'), {
    code: 'usage_limit_reached',
    status: 429,
    ...(retryAfterMs ? { headers: { 'retry-after-ms': String(retryAfterMs) } } : {}),
  });
}
const failing = (makeError, onSend) =>
  createAccountPoolProvider(provider, () => ({
    async send(_m, _model, _t, opts) {
      onSend?.(opts);
      throw makeError();
    },
  }));

test('every account refused with retry-after marks the error with the earliest reset', async () => {
  await setup();
  const delays = [3_600_000, 7_200_000, 1_800_000];
  let i = 0;
  const gateway = failing(() => quotaError(delays[i++]));
  const before = Date.now();
  await assert.rejects(gateway.send([], 'model-x', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    assert.equal(error.quotaExhausted.model, 'model-x');
    assert.ok(error.quotaExhausted.resetAt >= before + 1_800_000);
    assert.ok(error.quotaExhausted.resetAt <= Date.now() + 1_800_000);
    return true;
  });
});

test('inferred blocks leave the reset unknown but still mark exhaustion', async () => {
  await setup();
  const gateway = failing(() => quotaError());
  await assert.rejects(gateway.send([], 'model-x', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'model-x', resetAt: null });
    return true;
  });
});

test('a pre-exhausted roster throws the structured error: 5H cleared, 7D Opus full', async () => {
  const ids = await setup();
  const resetAt = Date.now() + 5_000_000;
  for (const id of ids) {
    await recordProviderAccountUsage(provider, id, {
      quotaWindows: [
        { label: '5H', usedPct: 10, resetAt: Date.now() + 60_000 },
        { label: '7D Opus', usedPct: 100, resetAt },
      ],
    });
  }
  const gateway = createAccountPoolProvider(provider, () => ({
    async send() {
      return { content: 'ok' };
    },
  }));
  await assert.rejects(gateway.send([], 'claude-opus-4-1', [], {}), (error) => {
    assert.equal(error.code, 'provider_accounts_exhausted');
    assert.deepEqual(error.quotaExhausted, { provider, model: 'claude-opus-4-1', resetAt });
    return true;
  });
  assert.equal((await gateway.send([], 'claude-sonnet-4', [], {})).content, 'ok');
});

test('a retry-after block marks exhaustion with its time', async () => {
  const ids = await setup();
  const until = Date.now() + 900_000;
  for (const id of ids) {
    await blockProviderAccount(provider, id, until, 'm', 'retry-after');
    await recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: 100, resetAt: until }] });
  }
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.ok(Math.abs(error.quotaExhausted.resetAt - until) < 5);
    return true;
  });
});

test('auto switching off: the selected account refusing with quota is the whole eligible set', async () => {
  await setup({ auto: false });
  const gateway = failing(() => quotaError(600_000));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    assert.ok(error.quotaExhausted.resetAt > Date.now());
    return true;
  });
});

test('auto switching off: a non-quota failure is not marked', async () => {
  await setup({ auto: false });
  const gateway = failing(() => Object.assign(new Error('boom'), { status: 500 }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('a generic 429 with a long Retry-After rotates accounts but carries no marker', async () => {
  await setup();
  let calls = 0;
  const gateway = failing(() => {
    calls += 1;
    return Object.assign(new Error('Too many requests'), { status: 429, headers: { 'retry-after': '120' } });
  });
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
  assert.equal(calls, 3, 'rotation across the roster is unchanged');
});

test('an overload 429 with a long Retry-After never blocks the account', async () => {
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  resetAccountProbePacing();
  const id = newProviderAccountId();
  await registerProviderAccount(provider, id, { label: 'Only' });
  await changeProviderAccounts(provider, { selectedId: id, auto: true, useCredits: false });
  const stages = [];
  let calls = 0;
  const gateway = createAccountPoolProvider(provider, () => ({
    async send() {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('Codex is at capacity, please try again later'), {
          status: 429,
          headers: { 'retry-after': '3600' },
        });
      }
      return { content: 'ok' };
    },
  }));
  const onStageChange = (stage, detail) => stages.push(detail?.message || stage);
  await assert.rejects(gateway.send([], 'm', [], { onStageChange }), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return /at capacity/.test(error.message);
  });
  const row = readProviderAccountPool(provider).accounts.find((entry) => entry.id === id);
  assert.ok(!(row.blockedUntil > Date.now()), 'the account is not blocked');
  assert.equal(
    stages.some((message) => /Quota exhausted/.test(message)),
    false
  );
  assert.equal((await gateway.send([], 'm', [], { onStageChange })).content, 'ok');
  assert.equal(calls, 2, 'the next send dispatches to the same account');
});

test('a long Retry-After without quota evidence is a cooldown: rotates, blocks only as advised', async () => {
  const ids = await setup();
  const stages = [];
  const gateway = failing(() =>
    Object.assign(new Error('Too many requests'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 120_000 })
  );
  const before = Date.now();
  await assert.rejects(gateway.send([], 'm', [], { onStageChange: (_s, d) => stages.push(d?.message) }), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
  for (const row of readProviderAccountPool(provider).accounts.filter((entry) => ids.includes(entry.id))) {
    assert.ok(row.blockedUntil <= Date.now() + 120_000 && row.blockedUntil >= before + 120_000);
    assert.notEqual(row.blockedQuota, true);
  }
  assert.ok(stages.length > 0 && stages.every((message) => /Rate limited \(cooldown\)/.test(message)));
});

test('a typed quota refusal blocks until the provider-named reset', async () => {
  await setup({ auto: false });
  const resetAt = Date.now() + 2 * 3_600_000;
  const gateway = failing(() =>
    Object.assign(new Error('limit'), { status: 429, code: 'usage_limit_reached', resetAt })
  );
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.ok(Math.abs(error.quotaExhausted.resetAt - resetAt) < 5);
    return true;
  });
});

test('a provider-supplied accountCooldownPolicy sets reason-based cooldowns when the server names no delay', async () => {
  const { ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY } = await import('./antigravity-retry-policy.mjs');
  const ag = 'antigravity-oauth';
  for (const row of readProviderAccountPool(ag).accounts) await removeProviderAccount(ag, row.id);
  resetAccountProbePacing();
  const ids = [newProviderAccountId(), newProviderAccountId()];
  for (const [i, id] of ids.entries()) await registerProviderAccount(ag, id, { label: `AG ${i}` });
  await changeProviderAccounts(ag, { selectedId: ids[0], auto: false, useCredits: false });
  const blockedFor = (id) =>
    readProviderAccountPool(ag).accounts.find((row) => row.id === id).blockedUntil - Date.now();
  const near = (actual, expected) => Math.abs(actual - expected) < 5_000;
  // Cooldown waits are exercised separately; here every refusal surfaces.
  const noWait = { ...ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY, waitForCooldownMs: 0 };
  const gateway = (makeError, policy = noWait) =>
    createAccountPoolProvider(ag, () => ({
      accountCooldownPolicy: policy,
      async send() {
        throw makeError();
      },
    }));
  const quota = () => Object.assign(new Error('quota'), { status: 429, code: 'quota_exhausted' });
  for (const expected of [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 2 * 60 * 60_000]) {
    await assert.rejects(gateway(quota).send([], 'm', [], {}));
    assert.ok(near(blockedFor(ids[0]), Math.min(expected, 6 * 60 * 60_000)), `quota step ${expected}`);
    await blockProviderAccount(ag, ids[0], 0);
  }
  assert.equal(ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY.waitForCooldownMs, 300_000);
  assert.equal(ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY.rotateOnRateLimit, true);
  // A 30s cooldown sits inside the 300s wait bound: the pool waits for it,
  // so an abort ends that wait.
  const rate = () => Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_exceeded' });
  const stop = new AbortController();
  const waited = gateway(rate, ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY).send([], 'm', [], {
    signal: stop.signal,
    onStageChange: (stage, detail) => {
      if (stage === 'reconnecting' && detail?.waitMs > 0) stop.abort(new Error('cancelled'));
    },
  });
  await assert.rejects(waited, /cancelled/);
  assert.ok(near(blockedFor(ids[0]), 30_000), 'rate limit 30s');
  await blockProviderAccount(ag, ids[0], 0);
  const advised = () =>
    Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 100 });
  await assert.rejects(gateway(advised).send([], 'm', [], {}));
  assert.ok(near(blockedFor(ids[0]), 2_000), 'advised rate limit rotates; the advice (floored) is the cooldown');
  await blockProviderAccount(ag, ids[0], 0);
  const longAdvice = () =>
    Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 400_000 });
  await assert.rejects(gateway(longAdvice).send([], 'm', [], {}));
  assert.ok(near(blockedFor(ids[0]), 400_000), 'advice beyond the wait bound blocks for the advice');
  await blockProviderAccount(ag, ids[0], 0);
  const capacity = () => Object.assign(new Error('busy'), { status: 503, code: 'model_capacity_exceeded' });
  await assert.rejects(gateway(capacity).send([], 'm', [], {}));
  assert.equal(readProviderAccountPool(ag).accounts.find((row) => row.id === ids[0]).blockedUntil > Date.now(), false);
  // Without a policy the inferred five minutes apply.
  const cursorIds = await setup({ auto: false });
  await assert.rejects(
    failing(() => Object.assign(new Error('q'), { status: 429, code: 'quota_exceeded' })).send([], 'm', [], {})
  );
  const cursorRow = readProviderAccountPool(provider).accounts.find((row) => row.id === cursorIds[0]);
  assert.ok(near(cursorRow.blockedUntil - Date.now(), 5 * 60_000));
});

test('the 20-attempt cap with every account exhausted still carries the marker', async () => {
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  resetAccountProbePacing();
  const ids = Array.from({ length: 20 }, () => newProviderAccountId());
  for (const [i, id] of ids.entries()) await registerProviderAccount(provider, id, { label: `A${i}` });
  await changeProviderAccounts(provider, { selectedId: ids[0], auto: true, useCredits: false });
  let calls = 0;
  const gateway = failing(() => {
    calls += 1;
    return quotaError(600_000);
  });
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted.provider, provider);
    return true;
  });
  assert.equal(calls, 20);
});

test('no marker when output was already emitted', async () => {
  await setup();
  const gateway = failing(
    () => quotaError(600_000),
    (opts) => opts.onTextDelta('partial')
  );
  await assert.rejects(gateway.send([], 'm', [], { onTextDelta() {} }), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('no marker for a generic 429 without a quota signal', async () => {
  await setup();
  const gateway = failing(() => Object.assign(new Error('Too many requests'), { status: 429 }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('no roster: an exhausted cached snapshot marks the error with its reset', async () => {
  for (const row of readProviderAccountPool(provider).accounts) await removeProviderAccount(provider, row.id);
  const resetAt = Date.now() + 4_000_000;
  await fetchOAuthUsageSnapshot(
    { provider },
    {
      async getUsageSnapshot() {
        return {
          quotaWindows: [
            { label: '5H', usedPct: 100, resetAt: Date.now() + 1_000_000 },
            { label: '7D', usedPct: 100, resetAt },
          ],
        };
      },
    },
    () => {},
    { force: true }
  );
  const gateway = createAccountPoolProvider(provider, () => ({
    async send() {
      return { content: 'ok' };
    },
  }));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'm', resetAt });
    return true;
  });
});

test('a retry before the block expires still carries the marker', async () => {
  await setup();
  const gateway = failing(() => quotaError(600_000));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => error.quotaExhausted?.provider === provider);
  const fresh = createAccountPoolProvider(provider, () => ({
    async send() {
      throw new Error('unreachable');
    },
  }));
  await assert.rejects(fresh.send([], 'm', [], {}), (error) => {
    assert.equal(error.code, 'provider_accounts_exhausted');
    assert.equal(error.quotaExhausted.provider, provider);
    assert.ok(error.quotaExhausted.resetAt > Date.now());
    return true;
  });
});

test('blocks without quota evidence stay unmarked on later sends', async () => {
  const ids = await setup();
  for (const id of ids) await blockProviderAccount(provider, id, Date.now() + 600_000, 'm', 'retry-after');
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.equal(error.quotaExhausted, undefined);
    return true;
  });
});

test('a roster that is only cooling down reports a rate limit advising the earliest cooldown, not quota', async () => {
  const ids = await setup();
  const now = Date.now();
  for (const [index, id] of ids.entries()) {
    await blockProviderAccount(provider, id, now + 600_000 + index * 60_000, 'm', 'retry-after');
  }
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.notEqual(error.code, 'provider_accounts_exhausted');
    const kind = providerErrorKind(error);
    assert.equal(kind.kind, 'rate_limited');
    assert.ok(kind.retryAfterMs > 590_000 && kind.retryAfterMs <= 600_000, `advice ${kind.retryAfterMs}`);
    // A deliberate verdict: the loop surfaces it instead of classifying it
    // as an unknown failure.
    assert.equal(isProviderRecoveryTerminal(error), true);
    return true;
  });
});

const cooling = (policy, send) => createAccountPoolProvider(provider, () => ({ accountCooldownPolicy: policy, send }));

test('waitForCooldownMs waits out a cooldown-only roster inside the bound, then sends', async () => {
  const ids = await setup();
  const until = Date.now() + 150;
  for (const id of ids) await blockProviderAccount(provider, id, until, 'm', 'retry-after');
  const stages = [];
  const gateway = cooling({ waitForCooldownMs: 10_000 }, async () => ({ content: 'ok' }));
  const result = await gateway.send([], 'm', [], {
    onStageChange: (stage, detail) => stages.push([stage, detail]),
  });
  assert.equal(result.content, 'ok');
  assert.ok(Date.now() >= until, 'the send waited for the earliest cooldown');
  const wait = stages.find(([stage, detail]) => stage === 'reconnecting' && detail?.waitMs > 0);
  assert.ok(wait && wait[1].waitMs <= 150, 'the wait is reported as reconnect progress');
});

test('waitForCooldownMs: beyond the bound, or with quota evidence, the send throws without waiting', async () => {
  const ids = await setup();
  for (const id of ids) await blockProviderAccount(provider, id, Date.now() + 600_000, 'm', 'retry-after');
  const gateway = cooling({ waitForCooldownMs: 1_000 }, async () => ({ content: 'ok' }));
  const started = Date.now();
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => error.code === 'rate_limited');
  await setup();
  await assert.rejects(
    cooling({ waitForCooldownMs: 600_000 }, async () => {
      throw quotaError();
    }).send([], 'other', [], {}),
    (error) => Boolean(error.quotaExhausted)
  );
  assert.ok(Date.now() - started < 5_000);
});

test('accountBlocked: a policy blockedMs cools that account and rotates; without it the error surfaces', async () => {
  const { ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY } = await import('./antigravity-retry-policy.mjs');
  assert.equal(ANTIGRAVITY_ACCOUNT_COOLDOWN_POLICY.blockedMs, 600_000);
  const blocked = () =>
    Object.assign(new Error('verify'), {
      status: 403,
      code: 'validation_required',
      accountBlocked: true,
      unsafeToRetry: true,
    });
  const ids = await setup();
  let calls = 0;
  const gateway = cooling({ blockedMs: 600_000 }, async () => {
    calls += 1;
    if (calls === 1) throw blocked();
    return { content: 'ok' };
  });
  assert.equal((await gateway.send([], 'm', [], {})).content, 'ok');
  assert.equal(calls, 2);
  const row = readProviderAccountPool(provider).accounts.find((entry) => entry.id === ids[0]);
  assert.ok(Math.abs(row.blockedUntil - Date.now() - 600_000) < 5_000, 'the blocked account cools for blockedMs');
  assert.notEqual(row.blockedQuota, true, 'never quota evidence');

  const plainIds = await setup();
  const error = blocked();
  await assert.rejects(
    cooling(null, async () => {
      throw error;
    }).send([], 'm', [], {}),
    (thrown) => thrown === error
  );
  const plain = readProviderAccountPool(provider).accounts.find((entry) => entry.id === plainIds[0]);
  assert.equal(plain.blockedUntil > Date.now(), false, 'default: no block');

  await setup();
  const emitted = cooling({ blockedMs: 600_000 }, async (_m, _model, _t, opts) => {
    opts.onTextDelta('partial');
    throw blocked();
  });
  await assert.rejects(emitted.send([], 'm', [], { onTextDelta() {} }), /verify/, 'emitted output never rotates');
});

test('rotateOnRateLimit rotates an advised rate limit and the wait retries the account after its advice', async () => {
  const ids = await setup({ auto: false });
  let calls = 0;
  const gateway = cooling({ rotateOnRateLimit: true, waitForCooldownMs: 10_000 }, async () => {
    calls += 1;
    if (calls === 1)
      throw Object.assign(new Error('slow'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 100 });
    return { content: 'ok' };
  });
  const result = await gateway.send([], 'm', [], {});
  assert.equal(result.content, 'ok');
  assert.equal(calls, 2);
  assert.ok(ids.length > 0);
});

const shortRateLimit = () =>
  Object.assign(new Error('short cooldown'), { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 100 });

function expiringCooldown(t, policy, send, elapsedMs = 100) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return createAccountPoolProvider(provider, () => ({
    get accountCooldownPolicy() {
      // The refusal captures its deadline before reading the policy. Advance
      // to that deadline before block persistence finishes, without sleeping.
      now += elapsedMs;
      return { rotateOnRateLimit: true, ...policy };
    },
    send,
  }));
}

for (const [auto, elapsedMs] of [[false, 100], [false, 101], [true, 100]]) {
  test(`an expired short cooldown retries the eligible account with auto=${auto}, elapsed=${elapsedMs}`, async (t) => {
    const ids = await setup({ auto });
    // Manual mode must ignore available alternatives. Automatic mode needs
    // an exhausted eligible set to exercise recovery rather than fallback.
    if (auto) for (const id of ids.slice(1)) await removeProviderAccount(provider, id);
    const used = [];
    const stages = [];
    const gateway = expiringCooldown(t, { waitForCooldownMs: 10_000 }, async () => {
      used.push(currentProviderAccountId(provider));
      if (used.length === 1) throw shortRateLimit();
      return { content: 'ok' };
    }, elapsedMs);
    const result = await gateway.send([], 'm', [], {
      onStageChange: (stage, detail) => stages.push([stage, detail]),
    });
    assert.equal(result.content, 'ok');
    assert.deepEqual(used, [ids[0], ids[0]]);
    assert.ok(stages.some(([stage, detail]) => stage === 'reconnecting' && detail?.waitMs === 0));
    assert.equal(readProviderAccountPool(provider).selectedId, ids[0]);
  });
}

for (const [name, policy, errorFactory, emit] of [
  ['absent wait policy', {}, shortRateLimit, false],
  ['disabled wait policy', { waitForCooldownMs: 0 }, shortRateLimit, false],
  ['quota refusal', { waitForCooldownMs: 10_000 }, () => quotaError(100), false],
  ['authentication refusal', { waitForCooldownMs: 10_000 }, () => Object.assign(new Error('auth'), { status: 401 }), false],
  ['already emitted output', { waitForCooldownMs: 10_000 }, shortRateLimit, true],
  ['unsafe retry', { waitForCooldownMs: 10_000 }, () => Object.assign(shortRateLimit(), { unsafeToRetry: true }), false],
]) {
  test(`an expired cooldown does not bypass ${name}`, async (t) => {
    await setup({ auto: false });
    let calls = 0;
    const waits = [];
    const error = errorFactory();
    const gateway = expiringCooldown(t, policy, async (_messages, _model, _tools, options) => {
      calls += 1;
      if (emit) options.onTextDelta('partial');
      throw error;
    });
    await assert.rejects(gateway.send([], 'm', [], {
      onTextDelta() {},
      onStageChange: (_stage, detail) => {
        if (detail?.waitMs != null) waits.push(detail.waitMs);
      },
    }), (thrown) => thrown === error);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });
}

test('repeated immediately expired cooldowns still stop at the send-attempt limit', async (t) => {
  await setup({ auto: false });
  let calls = 0;
  const gateway = expiringCooldown(t, { waitForCooldownMs: 10_000 }, async () => {
    calls += 1;
    throw shortRateLimit();
  });
  await assert.rejects(gateway.send([], 'm', [], {}), { code: 'rate_limit_exceeded' });
  assert.equal(calls, 20);
});

test('automatic rotation reopens an expired account only after trying the eligible roster', async (t) => {
  const ids = await setup();
  const used = [];
  const gateway = expiringCooldown(t, { waitForCooldownMs: 10_000 }, async () => {
    used.push(currentProviderAccountId(provider));
    if (used.length <= ids.length) throw shortRateLimit();
    return { content: 'ok' };
  });
  assert.equal((await gateway.send([], 'm', [], {})).content, 'ok');
  assert.equal(used.length, ids.length + 1);
  assert.equal(used[0], ids[0]);
  assert.deepEqual(new Set(used.slice(0, ids.length)), new Set(ids));
  assert.ok(ids.includes(used.at(-1)));
});

test('repeated positive cooldown waits cannot exceed the cumulative wait budget', async (t) => {
  await setup({ auto: false });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const waits = [];
  const gateway = cooling({ rotateOnRateLimit: true, waitForCooldownMs: 15 }, async () => {
    calls += 1;
    throw Object.assign(shortRateLimit(), { retryAfterMs: 10 });
  });
  await assert.rejects(
    gateway.send([], 'm', [], {
      onStageChange: (_stage, detail) => {
        if (detail?.waitMs != null) {
          waits.push(detail.waitMs);
          now += detail.waitMs;
        }
      },
    }),
    { code: 'rate_limit_exceeded' }
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10]);
});

for (const cancelAt of [1, 20]) {
  test(`cancellation during zero-wait recovery on send ${cancelAt} retains the abort reason`, async (t) => {
    await setup({ auto: false });
    const controller = new AbortController();
    const cancelled = new Error('cancel zero-wait recovery');
    let calls = 0;
    const gateway = expiringCooldown(t, { waitForCooldownMs: 10_000 }, async () => {
      calls += 1;
      throw shortRateLimit();
    });
    await assert.rejects(
      gateway.send([], 'm', [], {
        signal: controller.signal,
        onStageChange: (stage, detail) => {
          if (stage === 'reconnecting' && detail?.waitMs === 0 && calls === cancelAt) controller.abort(cancelled);
        },
      }),
      (error) => error === cancelled
    );
    assert.equal(calls, cancelAt);
  });
}

const serving = (used, refuse = () => false) =>
  createAccountPoolProvider(provider, () => {
    const id = currentProviderAccountId(provider);
    return {
      async send() {
        used.push(id);
        if (refuse(id)) throw quotaError();
        return { content: 'ok' };
      },
    };
  });

test('headroom first: each new session starts on the most headroom and keeps that account', async () => {
  const ids = await setup({ policy: 'headroom' });
  const usage = async (pcts) => {
    for (const [i, id] of ids.entries()) {
      await recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: pcts[i] }] });
    }
  };
  await usage([80, 20, 50]);
  const used = [];
  const gateway = serving(used);
  await gateway.send([], 'm', [], { sessionId: 'headroom-1' });
  assert.equal(used.at(-1), ids[1]);
  assert.equal(readProviderAccountPool(provider).selectedId, ids[1], 'the first pick is the account in use');
  await usage([80, 60, 10]);
  await gateway.send([], 'm', [], { sessionId: 'headroom-1' });
  assert.equal(used.at(-1), ids[1], 'the session keeps its account while it is usable');
  await gateway.send([], 'm', [], { sessionId: 'headroom-2' });
  assert.equal(used.at(-1), ids[2], 'a new session takes the most headroom now');
  assert.equal(readProviderAccountPool(provider).selectedId, ids[2]);
  await gateway.send([], 'm', [], { sessionId: 'headroom-1' });
  assert.equal(used.at(-1), ids[1]);
  assert.equal(readProviderAccountPool(provider).selectedId, ids[2], 'continuing a session moves no selection');
  // A session this process has not seen keeps the account its state names.
  await gateway.send([], 'm', [], {
    sessionId: 'headroom-3',
    providerState: { providerAccountId: ids[0], providerAccountProvider: provider },
  });
  assert.equal(used.at(-1), ids[0]);
  const routed = { accountRouting: { provider, accountId: ids[0] } };
  await gateway.send([{ role: 'assistant', content: 'x', providerMetadata: routed }], 'm', [], {
    sessionId: 'headroom-4',
  });
  assert.equal(used.at(-1), ids[0]);
  // Within a session, only a limit moves it — to the most headroom.
  const refusing = serving(used, (id) => id === ids[1]);
  await refusing.send([], 'm', [], { sessionId: 'headroom-1' });
  assert.deepEqual(used.slice(-2), [ids[1], ids[2]]);
  await usage([80, 60, 40]);
  await gateway.send([], 'm', [], { sessionId: 'headroom-1' });
  assert.equal(used.at(-1), ids[2], 'the session stays on the account it moved to');
});

test('headroom first: a stateless session keeps its account after the in-memory binding is gone', async () => {
  const ids = await setup({ policy: 'headroom' });
  const usage = async (pcts) => {
    for (const [i, id] of ids.entries()) {
      await recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: pcts[i] }] });
    }
  };
  await usage([80, 20, 50]);
  const used = [];
  const first = await serving(used).send([], 'm', [], { sessionId: 'headroom-evicted' });
  assert.equal(used.at(-1), ids[1]);
  assert.equal(first.providerReplay, undefined);
  assert.equal(first.providerState, undefined);
  assert.deepEqual(first.providerMetadata, {
    accountRouting: { provider, accountId: ids[1], sessionAccountId: ids[1] },
  });
  await usage([80, 60, 10]);
  // Eviction from the bounded map, or a restart: only the transcript remains.
  resetSessionAccountBindings();
  const history = [{ role: 'assistant', content: 'ok', providerMetadata: first.providerMetadata }];
  await serving(used).send(history, 'm', [], { sessionId: 'headroom-evicted' });
  assert.equal(used.at(-1), ids[1], 'no limit was hit, so the session stays on its account');
});

test('headroom first: a model-scoped fallback answer leaves the session bound to its account after a restart', async () => {
  const ids = await setup({ policy: 'headroom' });
  for (const [i, id] of ids.entries()) {
    await recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: [10, 50, 60][i] }] });
  }
  const used = [];
  await serving(used).send([], 'claude-sonnet-4', [], { sessionId: 'headroom-scoped' });
  assert.equal(used.at(-1), ids[0]);
  await recordProviderAccountUsage(provider, ids[0], {
    quotaWindows: [
      { label: '5H', usedPct: 10 },
      { label: '7D Opus', usedPct: 100, resetAt: Date.now() + 3_600_000 },
    ],
  });
  const lent = await serving(used).send([], 'claude-opus-4-1', [], { sessionId: 'headroom-scoped' });
  assert.notEqual(used.at(-1), ids[0], 'the Opus answer comes from another account');
  assert.equal(lent.providerMetadata.accountRouting.accountId, used.at(-1));
  assert.equal(lent.providerMetadata.accountRouting.sessionAccountId, ids[0]);
  resetSessionAccountBindings();
  const history = [{ role: 'assistant', content: 'ok', providerMetadata: lent.providerMetadata }];
  await serving(used).send(history, 'claude-sonnet-4', [], { sessionId: 'headroom-scoped' });
  assert.equal(used.at(-1), ids[0], 'after a restart the session still runs on its own account');
});

test('headroom first ignores bindings recorded for another provider', async () => {
  const ids = await setup({ policy: 'headroom' });
  for (const [i, id] of ids.entries()) {
    await recordProviderAccountUsage(provider, id, { quotaWindows: [{ label: '5H', usedPct: [90, 10, 50][i] }] });
  }
  const used = [];
  const foreign = {
    role: 'assistant',
    content: 'x',
    providerReplay: { accountId: ids[0] },
    providerMetadata: { accountRouting: { provider: 'other-oauth', accountId: ids[0] } },
  };
  await serving(used).send([foreign], 'm', [], {
    sessionId: 'headroom-foreign',
    providerState: { providerAccountId: ids[0], providerAccountProvider: 'other-oauth' },
  });
  assert.equal(used.at(-1), ids[1], 'the most headroom wins over a foreign binding');
});

test('a switch to Manual while a fallback request runs keeps the user selection', async () => {
  const ids = await setup({ policy: 'limit' });
  const used = [];
  const gateway = createAccountPoolProvider(provider, () => {
    const id = currentProviderAccountId(provider);
    return {
      async send() {
        used.push(id);
        if (id === ids[0]) throw quotaError();
        await changeProviderAccounts(provider, { policy: 'manual' });
        return { content: 'ok' };
      },
    };
  });
  await gateway.send([], 'm', [], {});
  assert.deepEqual(used, [ids[0], ids[1]]);
  const pool = readProviderAccountPool(provider);
  assert.equal(pool.policy, 'manual');
  assert.equal(pool.selectedId, ids[0], 'the completion must not override the later policy change');
});

test('headroom first with an unmeasured account keeps roster order', async () => {
  const ids = await setup({ policy: 'headroom' });
  await recordProviderAccountUsage(provider, ids[1], { quotaWindows: [{ label: '5H', usedPct: 5 }] });
  const used = [];
  await serving(used).send([], 'm', [], { sessionId: 'headroom-unknown' });
  assert.deepEqual(used, [ids[0]]);
});

test('a model-scoped limit serves from the fallback without moving the selection', async () => {
  const ids = await setup({ policy: 'limit' });
  const resetAt = Date.now() + 3_600_000;
  await recordProviderAccountUsage(provider, ids[0], {
    quotaWindows: [
      { label: '5H', usedPct: 10, resetAt },
      { label: '7D Fable', usedPct: 100, resetAt },
    ],
  });
  for (const id of ids.slice(1)) {
    await recordProviderAccountUsage(provider, id, {
      quotaWindows: [
        { label: '5H', usedPct: 10, resetAt },
        { label: '7D Fable', usedPct: 10, resetAt },
      ],
    });
  }
  const used = [];
  const gateway = serving(used);
  await gateway.send([], 'claude-fable-5', [], {});
  assert.equal(used.at(-1), ids[1]);
  assert.equal(readProviderAccountPool(provider).selectedId, ids[0], 'a full Fable window keeps the selection');
  await gateway.send([], 'claude-opus-4', [], {});
  assert.equal(used.at(-1), ids[0], 'other models still run on the selected account');
});

test('a quota refusal scoped to a model family does not commit the fallback', async () => {
  const ids = await setup({ policy: 'limit' });
  for (const id of ids) {
    await recordProviderAccountUsage(provider, id, {
      quotaWindows: [
        { label: '5H', usedPct: 10 },
        { label: '7D Fable', usedPct: 40 },
      ],
    });
  }
  const used = [];
  await serving(used, (id) => id === ids[0]).send([], 'claude-fable-5', [], {});
  assert.deepEqual(used, [ids[0], ids[1]]);
  assert.equal(readProviderAccountPool(provider).selectedId, ids[0]);
  await serving(used).send([], 'claude-opus-4', [], {});
  assert.equal(used.at(-1), ids[0]);
  // An account-wide refusal still moves the selection.
  await serving(used, (id) => id === ids[0]).send([], 'claude-opus-4', [], {});
  assert.equal(readProviderAccountPool(provider).selectedId, ids[1]);
});

test('the pool keeps the tool executor identity, including an explicit empty one (model-proxy host)', async () => {
  await setup();
  const seen = [];
  const gateway = createAccountPoolProvider(provider, () => ({
    async send(_m, _model, _t, opts) {
      seen.push(opts.toolExecutionSessionId);
      return { content: 'ok' };
    },
  }));
  await gateway.send([], 'm', [], { sessionId: 'local-session' });
  await gateway.send([], 'm', [], { sessionId: 'proxied-session', toolExecutionSessionId: '' });
  assert.deepEqual(seen, ['local-session', '']);
});

test('auto switching off: a full window on the selected account marks even with another account free', async () => {
  const ids = await setup({ auto: false });
  const resetAt = Date.now() + 2_000_000;
  await recordProviderAccountUsage(provider, ids[0], { quotaWindows: [{ label: '5H', usedPct: 100, resetAt }] });
  const gateway = failing(() => new Error('unreachable'));
  await assert.rejects(gateway.send([], 'm', [], {}), (error) => {
    assert.deepEqual(error.quotaExhausted, { provider, model: 'm', resetAt });
    return true;
  });
});
