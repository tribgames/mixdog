import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitResetFromUsage } from './chatgpt-usage.mjs';

const exhausted = (resetAt) => ({ primary_window: { used_percent: 100, reset_at: resetAt } });

test('the named limit wins, then an image limit, then the main window', () => {
  const payload = {
    rate_limit: exhausted(30),
    additional_rate_limits: [
      { limit_name: 'imagegen_premium', metered_feature: 'imagegen_premium', rate_limit: exhausted(20) },
      { limit_name: 'codex_other', metered_feature: 'codex_other', rate_limit: exhausted(10) },
    ],
  };
  assert.equal(limitResetFromUsage(payload, 'codex_other'), 10);
  assert.equal(limitResetFromUsage(payload, 'image_gen'), 20);
  assert.equal(limitResetFromUsage({ rate_limit: exhausted(30) }, 'image_gen'), 30);
});

test('windows below their cap give no reset unless the limit is marked reached', () => {
  const windows = {
    primary_window: { used_percent: 40, reset_at: 5 },
    secondary_window: { used_percent: 90, reset_at: 9 },
  };
  assert.equal(limitResetFromUsage({ rate_limit: windows }), null);
  assert.equal(limitResetFromUsage({ rate_limit: { ...windows, limit_reached: true } }), 9);
  assert.equal(limitResetFromUsage(null), null);
});
