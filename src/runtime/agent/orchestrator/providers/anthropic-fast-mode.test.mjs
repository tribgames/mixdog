import assert from 'node:assert/strict';
import test from 'node:test';

import {
    _FAST_MODE_POLICY,
    clearFastModeCooldown,
    fastModeAvailable,
    fastModeCooldownRemainingMs,
    fastModeDisabledReason,
    noteFastModeCapacityError,
} from './anthropic-fast-mode.mjs';

test.beforeEach(() => clearFastModeCooldown());
test.after(() => clearFastModeCooldown());

test('non-capacity failures and standard-speed requests leave fast mode alone', () => {
    assert.equal(noteFastModeCapacityError({ httpStatus: 429 }, { fast: false }), 'ignored');
    assert.equal(noteFastModeCapacityError({ httpStatus: 500 }, { fast: true }), 'ignored');
    assert.equal(noteFastModeCapacityError({ httpStatus: 401 }, { fast: true }), 'ignored');
    assert.equal(fastModeAvailable(), true);
});

test('a short server window keeps fast mode so the cache prefix survives', () => {
    const decision = noteFastModeCapacityError(
        { httpStatus: 429, retryAfterMs: _FAST_MODE_POLICY.SHORT_RETRY_THRESHOLD_MS - 1 },
        { fast: true },
    );
    assert.equal(decision, 'retry-fast');
    assert.equal(fastModeAvailable(), true);
});

test('a long window downgrades to standard speed for at least the cooldown floor', () => {
    const now = 1_000_000;
    const retryAfterMs = 20_000;
    assert.equal(
        noteFastModeCapacityError({ httpStatus: 429, retryAfterMs }, { fast: true, now }),
        'downgrade',
    );
    assert.equal(fastModeAvailable(now), false);
    // 20s window is below the floor, so the floor wins.
    assert.equal(fastModeCooldownRemainingMs(now), _FAST_MODE_POLICY.MIN_COOLDOWN_MS);
    assert.equal(fastModeAvailable(now + _FAST_MODE_POLICY.MIN_COOLDOWN_MS), true);
});

test('a long window longer than the floor is honored verbatim', () => {
    const now = 2_000_000;
    const retryAfterMs = _FAST_MODE_POLICY.MIN_COOLDOWN_MS * 3;
    noteFastModeCapacityError({ httpStatus: 529, retryAfterMs }, { fast: true, now });
    assert.equal(fastModeCooldownRemainingMs(now), retryAfterMs);
});

test('a 529 with no window uses the default cooldown', () => {
    const now = 3_000_000;
    assert.equal(noteFastModeCapacityError({ httpStatus: 529 }, { fast: true, now }), 'downgrade');
    assert.equal(fastModeCooldownRemainingMs(now), _FAST_MODE_POLICY.DEFAULT_COOLDOWN_MS);
});

test('cooldowns never shrink an existing longer cooldown', () => {
    const now = 4_000_000;
    noteFastModeCapacityError({ httpStatus: 429, retryAfterMs: 600_000 }, { fast: true, now });
    noteFastModeCapacityError({ httpStatus: 429, retryAfterMs: 60_000 }, { fast: true, now });
    assert.equal(fastModeCooldownRemainingMs(now), 600_000);
});

test('an overage-disabled header turns fast mode off for the process', () => {
    const decision = noteFastModeCapacityError(
        {
            httpStatus: 429,
            headers: new Map([[_FAST_MODE_POLICY.OVERAGE_DISABLED_HEADER, 'no_overage']]),
            retryAfterMs: 1,
        },
        { fast: true },
    );
    assert.equal(decision, 'disabled');
    assert.equal(fastModeDisabledReason(), 'no_overage');
    assert.equal(fastModeAvailable(Date.now() + 86_400_000), false);
    clearFastModeCooldown();
    assert.equal(fastModeAvailable(), true);
});

test('plain-object headers resolve case-insensitively', () => {
    noteFastModeCapacityError(
        {
            httpStatus: 429,
            response: { headers: { 'ANTHROPIC-RateLimit-Unified-Overage-Disabled-Reason': 'billing' } },
        },
        { fast: true },
    );
    assert.equal(fastModeDisabledReason(), 'billing');
});
