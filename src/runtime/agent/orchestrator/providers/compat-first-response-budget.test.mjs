import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate credential and cache lookups from the developer's own data.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-compat-budget-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(dir, 'mimo-oauth.json');

const { PROVIDER_MAX_BEFORE_WARN_MS, providerFirstResponseBudget } = await import('../stall-policy.mjs');
const { COMPAT_RETRY_PROFILES, compatFirstByteWindowMs, compatFirstResponseBudget, withCompatRetryProfile } =
  await import('./openai-compat-retry-profile.mjs');
const { isProviderRecoveryExhausted } = await import('./retry-classifier.mjs');
const { DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS } = await import('./retry-backoff.mjs');
const { MIMO_CHAT_PROFILE, MIMO_FIRST_BYTE_TIMEOUT_MS } = await import('./mimo-oauth-profile.mjs');
const { MimoOAuthProvider } = await import('./mimo-oauth.mjs');
const { OpenAICompatProvider } = await import('./openai-compat.mjs');

test('the budget sums every attempt window and the backoff between attempts', () => {
  assert.deepEqual(
    providerFirstResponseBudget({ attempts: 3, windowMs: (n) => 100 * (n + 1), backoffMs: [5, 5, 10] }),
    {
      transportMs: 100 + 5 + 200 + 10 + 300,
      semanticMs: 200 + 5 + 400 + 10 + 600,
    }
  );
  // The last backoff step repeats past the end of the list.
  assert.equal(providerFirstResponseBudget({ attempts: 4, windowMs: () => 1, backoffMs: [0, 7] }).transportMs, 4 + 21);
});

// Backoff before every retry of a ladder of `attempts` sends (the last step repeats).
function ladderBackoffMs(backoffMs, attempts) {
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt++) total += backoffMs[Math.min(attempt, backoffMs.length - 1)];
  return total;
}

test('Mimo budgets two first-byte windows on a doubled, capped window, plus its whole 9-attempt backoff', () => {
  const { backoffMs, firstByteRetries, maxAttempts } = COMPAT_RETRY_PROFILES['mimo-oauth'];
  assert.equal(firstByteRetries, 1);
  assert.equal(maxAttempts, 9);
  const retryMs = Math.min(
    2 * MIMO_FIRST_BYTE_TIMEOUT_MS,
    Math.max(MIMO_FIRST_BYTE_TIMEOUT_MS, PROVIDER_MAX_BEFORE_WARN_MS)
  );
  assert.equal(compatFirstByteWindowMs('mimo-oauth', MIMO_FIRST_BYTE_TIMEOUT_MS, 1), retryMs);
  // Drops and 5xx use the other seven attempts; each may land at the end of
  // the widened window, behind all eight backoff steps.
  const backoff = ladderBackoffMs(backoffMs, maxAttempts);
  assert.ok(backoff > backoffMs[1]);
  const expected = {
    transportMs: MIMO_FIRST_BYTE_TIMEOUT_MS + 8 * retryMs + backoff,
    semanticMs: 2 * MIMO_FIRST_BYTE_TIMEOUT_MS + 16 * retryMs + backoff,
  };
  assert.deepEqual(compatFirstResponseBudget('mimo-oauth', MIMO_CHAT_PROFILE), expected);
  assert.deepEqual(new MimoOAuthProvider({}).firstResponseBudget('mimo-v2-pro'), expected);
  // Never more than every attempt at the widened window plus the backoff.
  assert.ok(expected.transportMs <= maxAttempts * retryMs + backoff);
});

test('a profile without a first-byte cap budgets every attempt of its ladder as a possible timeout', () => {
  // command-code has 3 attempts and no first-byte cap: every attempt may time out.
  const { backoffMs, maxAttempts } = COMPAT_RETRY_PROFILES['command-code-oauth'];
  assert.deepEqual(compatFirstResponseBudget('command-code-oauth', { firstByteTimeoutMs: 10_000 }), {
    transportMs: maxAttempts * 10_000 + ladderBackoffMs(backoffMs, maxAttempts),
    semanticMs: 2 * maxAttempts * 10_000 + ladderBackoffMs(backoffMs, maxAttempts),
  });
});

test('Mimo retries a first-byte timeout once on a longer window; other errors keep the ladder', async () => {
  const timeout = (phase) =>
    Object.assign(new Error('mimo-oauth first byte timed out'), { code: 'EPROVIDERTIMEOUT', timeoutPhase: phase });
  const seen = [];
  const attempt = withCompatRetryProfile('mimo-oauth', async (ctx) => {
    seen.push(ctx.firstByteTimeouts);
    throw timeout(seen.length === 1 ? 'headers' : 'first-chunk');
  });
  await assert.rejects(attempt({ attempt: 0 }), (err) => !isProviderRecoveryExhausted(err));
  await assert.rejects(attempt({ attempt: 1 }), (err) => isProviderRecoveryExhausted(err));
  assert.deepEqual(seen, [0, 1]);

  // A connect error is not a first-byte timeout: it stays on the ordinary ladder.
  const reset = withCompatRetryProfile('mimo-oauth', async () => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  for (let n = 0; n < 4; n++) {
    await assert.rejects(reset({ attempt: n }), (err) => !isProviderRecoveryExhausted(err));
  }
  // Providers without the cap keep their flat window.
  assert.equal(compatFirstByteWindowMs('deepseek', 90_000, 3), 90_000);
});

test('a compat chat profile with its own window reports a budget; one without reports none', () => {
  const profiled = new OpenAICompatProvider('custom-gateway', {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKey: 'k',
    preconnect: false,
    chatProfile: { firstByteTimeoutMs: 90_000 },
  });
  let backoff = 0;
  for (let attempt = 1; attempt < DEFAULT_MAX_ATTEMPTS; attempt++) {
    backoff += DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)];
  }
  assert.deepEqual(profiled.firstResponseBudget('m'), {
    transportMs: DEFAULT_MAX_ATTEMPTS * 90_000 + backoff,
    semanticMs: 2 * DEFAULT_MAX_ATTEMPTS * 90_000 + backoff,
  });
  const plain = new OpenAICompatProvider('custom-gateway', {
    baseURL: 'http://127.0.0.1:9/v1',
    apiKey: 'k',
    preconnect: false,
  });
  assert.equal(plain.firstResponseBudget('m'), null);
});
