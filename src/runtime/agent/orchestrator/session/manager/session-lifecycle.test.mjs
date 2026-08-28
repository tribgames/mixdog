import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSessionContextMeta } from './context-meta.mjs';
import {
    contextSeedForRouteUpdate,
    prepareSessionProjection,
    _refreshSessionRuleVariantsForModel,
} from './session-lifecycle.mjs';
import { _buildSharedRules } from './rules-cache.mjs';
import {
    contextMessagesSignature,
    toolSchemaSignature,
} from '../context-utils.mjs';
import { createContextStatus } from '../../../../../session-runtime/context-status.mjs';

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

test('a cold projection preserves the provider-aligned active tool surface', () => {
    const messages = [{ role: 'user', content: 'continue the existing task' }];
    const tools = [
        { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
        { name: 'recall', description: 'Recall memory', inputSchema: { type: 'object' } },
    ];
    const baselineTokens = 123_456;
    const session = {
        id: `cold-context-projection-${Date.now()}`,
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        cwd: process.cwd(),
        preset: 'full',
        toolSpec: 'full',
        messages,
        tools,
        contextWindow: 272_000,
        rawContextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        compaction: {
            auto: true,
            boundaryTokens: 272_000,
            contextWindow: 272_000,
            rawContextWindow: 272_000,
        },
        contextPressureBaselineTokens: baselineTokens,
        contextPressureBaselineOutputTokens: 0,
        contextPressureBaselineMessageCount: messages.length,
        contextPressureBaselinePrefixSignature: contextMessagesSignature(messages),
        contextPressureBaselineProvider: 'openai-oauth',
        contextPressureBaselineModel: 'gpt-5.6-sol',
        contextPressureBaselineToolSignature: toolSchemaSignature(tools),
        contextPressureBaselineBoundary: 'complete',
        contextPressureBaselineUpdatedAt: Date.now(),
        lastContextTokensStaleAfterCompact: false,
    };

    const projection = prepareSessionProjection(session, 'full');
    const status = createContextStatus({
        getSession: () => projection,
        getRoute: () => ({
            provider: projection.provider,
            model: projection.model,
            contextWindow: projection.contextWindow,
        }),
        getCurrentCwd: () => projection.cwd,
        getMode: () => 'full',
    }).contextStatus();

    assert.equal(toolSchemaSignature(projection.tools), session.contextPressureBaselineToolSignature);
    assert.equal(status.usedTokens, baselineTokens);
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
