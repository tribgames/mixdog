import assert from 'node:assert/strict';
import test from 'node:test';
import {
    prepareProviderPrefixGuard,
    ProviderPrefixMutationError,
} from './provider-prefix-guard.mjs';

const CACHE_PROVIDERS = [
    'anthropic',
    'anthropic-oauth',
    'openai',
    'openai-oauth',
    'xai',
    'grok-oauth',
    'gemini',
    'deepseek',
    'opencode-go',
    'cursor-oauth',
    'ollama',
    'lmstudio',
];

test('accepts append-only provider history for every provider surface', () => {
    for (const provider of CACHE_PROVIDERS) {
        const first = prepareProviderPrefixGuard(
            null,
            [{ role: 'user', content: 'one' }],
            { tools: [{ name: 'read' }], nativeTools: [] },
            { provider },
        );
        assert.doesNotThrow(() => prepareProviderPrefixGuard(
            first,
            [
                { role: 'user', content: 'one' },
                { role: 'assistant', content: 'two' },
            ],
            { tools: [{ name: 'read' }], nativeTools: [] },
            { provider },
        ), provider);
    }
});

test('rejects prior-message rewrites outside compaction', () => {
    const first = prepareProviderPrefixGuard(
        null,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
    );
    assert.throws(
        () => prepareProviderPrefixGuard(
            first,
            [{ role: 'user', content: 'rewritten' }],
            { tools: [{ name: 'read' }], nativeTools: [] },
        ),
        ProviderPrefixMutationError,
    );
});

test('rebaselines tool-prefix changes while preserving transcript integrity checks', () => {
    const first = prepareProviderPrefixGuard(
        null,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
    );
    const changed = prepareProviderPrefixGuard(
        first,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }, { name: 'shell' }], nativeTools: [] },
    );
    assert.notEqual(changed.requestPrefixHash, first.requestPrefixHash);
    assert.doesNotThrow(() => prepareProviderPrefixGuard(
        changed,
        [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
        ],
        { tools: [{ name: 'read' }, { name: 'shell' }], nativeTools: [] },
    ));
    assert.throws(
        () => prepareProviderPrefixGuard(
            changed,
            [{ role: 'user', content: 'rewritten' }],
            { tools: [{ name: 'read' }, { name: 'shell' }], nativeTools: [] },
        ),
        ProviderPrefixMutationError,
    );
});

test('allows only compaction intents to establish a new prefix', () => {
    const first = prepareProviderPrefixGuard(
        null,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
    );
    for (const cacheBreakIntent of [
        'automatic_compaction',
        'deferred_body_compaction',
        'manual_compaction',
        'post_turn_compaction',
    ]) {
        assert.doesNotThrow(() => prepareProviderPrefixGuard(
            first,
            [{ role: 'user', content: 'compacted' }],
            { tools: [{ name: 'read' }], nativeTools: [] },
            { cacheBreakIntent },
        ));
    }
    assert.throws(
        () => prepareProviderPrefixGuard(
            first,
            [{ role: 'user', content: 'repaired' }],
            { tools: [{ name: 'read' }], nativeTools: [] },
            { cacheBreakIntent: 'transcript_rebuild' },
        ),
        ProviderPrefixMutationError,
    );
});
