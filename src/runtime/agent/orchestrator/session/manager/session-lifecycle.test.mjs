import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { contextSeedForRouteUpdate, _refreshSessionRuleVariantsForModel } from './session-lifecycle.mjs';
import { _buildSharedRules } from './rules-cache.mjs';

test('a cold Cursor route uses 200k instead of inheriting another model window', () => {
    const seed = contextSeedForRouteUpdate({
        selectedContextWindow: 272_000,
        contextWindow: 272_000,
        rawContextWindow: 272_000,
        compactBoundaryTokens: 272_000,
    }, true);
    assert.deepEqual(seed, {});
    const meta = resolveSessionContextMeta(
        { name: 'cursor-oauth' },
        'gemini-3.7-flash',
        seed,
    );
    assert.equal(meta.contextWindow, 200_000);
    assert.equal(meta.rawContextWindow, 200_000);
});

test('a cold Cursor route does not use another provider exact-id window', () => {
    const meta = resolveSessionContextMeta(
        { name: 'cursor-oauth' },
        'gpt-5.4',
        {},
    );
    assert.equal(meta.contextWindow, 200_000);
    assert.equal(meta.rawContextWindow, 200_000);
});

test('an explicitly selected context window survives a route update', () => {
    assert.deepEqual(contextSeedForRouteUpdate({
        selectedContextWindow: 300_000,
        contextWindow: 300_000,
    }, true, true), {
        selectedContextWindow: 300_000,
    });
});

test('an empty-session route change re-renders the edit-dialect rule variants', () => {
    const gptRules = _buildSharedRules({ omitTools: ['edit'] });
    const claudeRules = _buildSharedRules({ omitTools: ['apply_patch'] });
    assert.notEqual(gptRules, claudeRules);
    const session = {
        model: 'claude-fable-5',
        messages: [
            { role: 'system', content: gptRules },
            { role: 'system', content: 'profile block' },
            { role: 'system', content: 'core block', cacheTier: 'tier3' },
        ],
    };
    // GPT-created session switched to Claude: BP1 flips to the edit variant.
    assert.equal(_refreshSessionRuleVariantsForModel(session, 'gpt-5.6-sol'), true);
    assert.equal(session.messages[0].content, claudeRules);
    assert.match(session.messages[0].content, /`edit`/);
    assert.doesNotMatch(session.messages[0].content, /apply_patch/);
    // Untouched blocks keep their identity and content.
    assert.equal(session.messages[1].content, 'profile block');
    assert.equal(session.messages[2].cacheTier, 'tier3');
    // Same edit dialect on both sides is a no-op.
    assert.equal(_refreshSessionRuleVariantsForModel(session, 'claude-opus-5'), false);
    // A layout without the expected BP1 content is left untouched.
    assert.equal(_refreshSessionRuleVariantsForModel({
        model: 'claude-fable-5',
        messages: [{ role: 'system', content: 'custom prompt' }],
    }, 'gpt-5.6-sol'), false);
});
