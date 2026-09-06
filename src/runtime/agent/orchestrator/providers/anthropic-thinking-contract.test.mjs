import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAnthropicEffortToBody, setModelEffortCapabilities } from './anthropic-effort.mjs';
import { clampAnthropicThinkingBudget } from './lib/anthropic-request-utils.mjs';
import { _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';

test('adaptive-only Claude models reject manual thinking budgets before producing an invalid request', () => {
    for (const model of [
        'claude-fable-5-1', 'claude-fable-5.1-20260901', 'claude-mythos-5-1',
        'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5',
    ]) {
        const body = { model };
        assert.throws(() => applyAnthropicEffortToBody(body, {
            model, opts: { thinkingBudgetTokens: 4096, effort: 'high' }, maxTokens: 128000,
            clampThinkingBudgetTokens: clampAnthropicThinkingBudget,
        }), /does not support thinkingBudgetTokens; use effort/);
        assert.deepEqual(body, { model });
    }
});

test('Mythos 5.1 uses adaptive thinking and effort with no model catalog', () => {
    setModelEffortCapabilities([]);
    for (const model of ['claude-mythos-5-1', 'claude-mythos-5.1-20260901']) {
        for (const effort of ['low', 'high', 'xhigh', 'max']) {
            const body = _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'Hello.' }], model, [], { effort });
            assert.deepEqual(body.thinking, { type: 'adaptive' });
            assert.deepEqual(body.output_config, { effort });
        }
    }
});
