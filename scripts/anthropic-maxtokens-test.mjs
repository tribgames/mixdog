#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { _test } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

const { resolveMaxTokens } = _test;
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
