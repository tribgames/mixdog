import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchOpenAICodexResetCredits } from './oauth-usage.mjs';

const provider = { ensureAuth: async () => ({ access_token: 'token', account_id: 'acct' }) };

test('a reset credit row without a status is not counted as available and does not throw', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({
      available_count: 1,
      credits: [{ status: 'available', expires_at: 2_000_000_000 }, { expires_at: 2_100_000_000 }],
    }),
  }));
  const credits = await fetchOpenAICodexResetCredits(provider);
  assert.equal(credits.availableCount, 1);
  assert.equal(credits.availableCredits.length, 1);
  assert.equal(credits.nextExpiresAt, 2_000_000_000 * 1000);
});
