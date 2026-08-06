import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SHOW_TOKENS_AFTER_MS,
    buildSpinnerMeta,
    formatSpinnerTokens,
    isReducedMotion,
    spinnerThinkingLabel,
} from '../src/tui/spinner-meta.mjs';

test('tokens stay hidden on short turns and appear once the turn runs long', () => {
    const short = buildSpinnerMeta({ elapsedMs: 5_000, outputTokens: 1234 });
    assert.equal(short.tokensText, '1.2k tokens');
    assert.equal(short.showTokens, false);
    const long = buildSpinnerMeta({ elapsedMs: SHOW_TOKENS_AFTER_MS + 1, outputTokens: 1234 });
    assert.equal(long.showTokens, true);
    // A zero count is never a segment, however long the turn runs.
    assert.equal(buildSpinnerMeta({ elapsedMs: 120_000, outputTokens: 0 }).showTokens, false);
});

test('token counts read compactly below and above 1k', () => {
    assert.equal(formatSpinnerTokens(0), '0');
    assert.equal(formatSpinnerTokens(999), '999');
    assert.equal(formatSpinnerTokens(1000), '1k');
    assert.equal(formatSpinnerTokens(-5), '0');
});

test('live thinking reads as thinking, a finished span as thought for Ns', () => {
    assert.equal(spinnerThinkingLabel({ thinking: true }), 'thinking');
    assert.equal(spinnerThinkingLabel({ thinkingSince: Date.now() }), 'thinking');
    assert.equal(spinnerThinkingLabel({ thinkingMs: 12_400 }), 'thought for 12s');
    // Sub-second spans are noise.
    assert.equal(spinnerThinkingLabel({ thinkingMs: 400 }), '');
    assert.equal(spinnerThinkingLabel({}), '');
});

test('an explicit effort level becomes a suffix; auto never does', () => {
    assert.equal(spinnerThinkingLabel({ thinking: true, effort: 'high' }), 'thinking (high)');
    for (const effort of ['', 'auto', 'default', 'off', 'none', '  ']) {
        assert.equal(spinnerThinkingLabel({ thinking: true, effort }), 'thinking', `effort=${JSON.stringify(effort)}`);
    }
    // The suffix belongs to LIVE thinking only — a finished span reports duration.
    assert.equal(spinnerThinkingLabel({ thinkingMs: 3_000, effort: 'high' }), 'thought for 3s');
});

test('a live thinking span outranks the accumulated total', () => {
    const meta = buildSpinnerMeta({ thinking: true, thinkingMs: 9_000 });
    assert.equal(meta.thinkingText, 'thinking');
    assert.equal(meta.thinkingActive, true);
    const settled = buildSpinnerMeta({ thinking: false, thinkingMs: 9_000 });
    assert.equal(settled.thinkingText, 'thought for 9s');
    assert.equal(settled.thinkingActive, false);
});

test('reduced motion is opt-in and tolerates the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'on', 'YES']) {
        assert.equal(isReducedMotion({ MIXDOG_REDUCED_MOTION: value }), true, `value=${value}`);
    }
    for (const value of ['', '0', 'false', 'off', undefined]) {
        assert.equal(isReducedMotion({ MIXDOG_REDUCED_MOTION: value }), false, `value=${value}`);
    }
    assert.equal(isReducedMotion({}), false);
});
