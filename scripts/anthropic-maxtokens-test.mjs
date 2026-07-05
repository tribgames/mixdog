#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _test as _apiKeyTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';

const { resolveMaxTokens } = _test;
const { resolveMaxTokens: resolveMaxTokensApiKey } = _apiKeyTest;
const ENV_VAR = 'MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS';

function withEnvOverride(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, ENV_VAR);
    const prev = process.env[ENV_VAR];
    try {
        if (value == null) delete process.env[ENV_VAR];
        else process.env[ENV_VAR] = value;
        fn();
    } finally {
        if (had) process.env[ENV_VAR] = prev;
        else delete process.env[ENV_VAR];
    }
}

test('claude-sonnet-5 resolves to 65536 (catalog or fallback)', () => {
    withEnvOverride(null, () => {
        assert.equal(resolveMaxTokens('claude-sonnet-5'), 65536);
    });
});

test('unknown model id falls back to a sane >=8192 value', () => {
    withEnvOverride(null, () => {
        const result = resolveMaxTokens('claude-totally-unknown-model-xyz');
        assert.equal(typeof result, 'number');
        assert.ok(Number.isFinite(result));
        assert.ok(result >= 8192, `expected >=8192, got ${result}`);
    });
});

test('MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS=32768 overrides the result', () => {
    withEnvOverride('32768', () => {
        assert.equal(resolveMaxTokens('claude-sonnet-5'), 32768);
        assert.equal(resolveMaxTokens('claude-totally-unknown-model-xyz'), 32768);
    });
});

test('invalid MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS=0 does not override', () => {
    withEnvOverride(null, () => {
        const baseline = resolveMaxTokens('claude-sonnet-5');
        withEnvOverride('0', () => {
            assert.equal(resolveMaxTokens('claude-sonnet-5'), baseline);
            assert.notEqual(baseline, 0);
        });
    });
});

// Regression guard for the reviewer-caught masking gap: sonnet-5's baseline
// already equals DEFAULT_SAFETY_CAP (65536), so an invalid override that
// wrongly returns the default cap is invisible on sonnet-5. Assert on models
// whose baseline is BELOW the cap — an invalid env value must leave them at
// their catalog/fallback value, never jump them to 65536.
test('invalid env values do not bypass catalog/fallback on low-cap models', () => {
    withEnvOverride(null, () => {
        const sonnet46 = resolveMaxTokens('claude-sonnet-4-6');
        const unknown = resolveMaxTokens('claude-totally-unknown-model-xyz');
        for (const bad of ['0', '-1', 'garbage', '   ']) {
            withEnvOverride(bad, () => {
                assert.equal(resolveMaxTokens('claude-sonnet-4-6'), sonnet46, `env=${JSON.stringify(bad)}`);
                assert.equal(resolveMaxTokens('claude-totally-unknown-model-xyz'), unknown, `env=${JSON.stringify(bad)}`);
            });
        }
    });
});

// --- API-key provider (anthropic.mjs) — shares the anthropic-max-tokens.mjs
// helper and reads the same on-disk anthropic-oauth-models.json catalog.

test('API-key provider: claude-sonnet-5 resolves to 65536 (catalog or fallback)', () => {
    withEnvOverride(null, () => {
        assert.equal(resolveMaxTokensApiKey('claude-sonnet-5'), 65536);
    });
});

test('API-key provider: claude-sonnet-4-6 stays at legacy 16384 when catalog has no entry', () => {
    withEnvOverride(null, () => {
        const result = resolveMaxTokensApiKey('claude-sonnet-4-6');
        assert.ok(result === 16384 || result >= 16384, `expected >=16384, got ${result}`);
    });
});

test('API-key provider: haiku no longer starves visible output at 8192-only ceiling', () => {
    withEnvOverride(null, () => {
        const result = resolveMaxTokensApiKey('claude-haiku-4-5-20251001');
        assert.ok(result >= 8192, `expected >=8192, got ${result}`);
    });
});

test('API-key provider: unknown model id falls back to a sane >=8192 value', () => {
    withEnvOverride(null, () => {
        const result = resolveMaxTokensApiKey('claude-totally-unknown-model-xyz');
        assert.equal(typeof result, 'number');
        assert.ok(Number.isFinite(result));
        assert.ok(result >= 8192, `expected >=8192, got ${result}`);
    });
});

test('API-key provider: MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS=32768 overrides the result', () => {
    withEnvOverride('32768', () => {
        assert.equal(resolveMaxTokensApiKey('claude-sonnet-5'), 32768);
        assert.equal(resolveMaxTokensApiKey('claude-totally-unknown-model-xyz'), 32768);
    });
});

test('OAuth and API-key providers agree on fallback heuristic for the same model id', () => {
    withEnvOverride(null, () => {
        for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-totally-unknown-model-xyz']) {
            assert.equal(resolveMaxTokens(id), resolveMaxTokensApiKey(id), `mismatch for ${id}`);
        }
    });
});
