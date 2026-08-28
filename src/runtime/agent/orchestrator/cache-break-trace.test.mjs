import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCacheBreakPayload,
    traceCacheBreak,
} from './cache-break-trace.mjs';
import {
    prepareProviderPrefixGuard,
    ProviderPrefixMutationError,
} from './session/provider-prefix-guard.mjs';

test('cache-break trace emits structured hashes without message content', () => {
    const rows = [];
    const lines = [];
    const payload = traceCacheBreak({
        sessionId: 'sess_test',
        iteration: 2,
        classification: 'unexpected',
        reason: 'message_prefix',
        source: 'browser_snapshot_supersession',
        provider: 'openai-oauth',
        model: 'gpt-test',
        index: 7,
        previousHash: 'a'.repeat(64),
        nextHash: 'b'.repeat(64),
        message: 'must never be logged',
    }, {
        traceFn: (row) => rows.push(row),
        stderrFn: (line) => lines.push(line),
    });
    assert.equal(payload.previous_hash, 'a'.repeat(16));
    assert.equal(payload.next_hash, 'b'.repeat(16));
    assert.equal(rows[0].kind, 'cache_break');
    assert.match(lines[0], /reason="message_prefix"/);
    assert.doesNotMatch(`${JSON.stringify(rows)}${lines.join('')}`, /must never be logged/);
});

test('provider prefix guard explains unexpected rewrites and intentional compaction', () => {
    const events = [];
    const first = prepareProviderPrefixGuard(
        null,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
        { provider: 'openai-oauth', model: 'gpt-test' },
    );
    assert.throws(
        () => prepareProviderPrefixGuard(
            first,
            [{ role: 'user', content: 'rewritten' }],
            { tools: [{ name: 'read' }], nativeTools: [] },
            {
                provider: 'openai-oauth',
                model: 'gpt-test',
                mutationSource: 'test_projection',
                onCacheBreak: (event) => events.push(event),
            },
        ),
        (error) => error instanceof ProviderPrefixMutationError
            && error.details.kind === 'message_prefix'
            && error.details.index === 0,
    );
    assert.equal(events[0].classification, 'unexpected');
    assert.equal(events[0].source, 'test_projection');

    const compactEvents = [];
    assert.doesNotThrow(() => prepareProviderPrefixGuard(
        first,
        [{ role: 'user', content: 'summary' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
        {
            provider: 'openai-oauth',
            model: 'gpt-test',
            cacheBreakIntent: 'automatic_compaction',
            onCacheBreak: (event) => compactEvents.push(event),
        },
    ));
    assert.equal(compactEvents[0].classification, 'intentional');
    assert.equal(compactEvents[0].reason, 'automatic_compaction');
});

test('defer_loading tool changes are excluded from Anthropic cache-key diagnostics', () => {
    const first = prepareProviderPrefixGuard(
        null,
        [{ role: 'user', content: 'one' }],
        { tools: [{ name: 'read' }], nativeTools: [] },
        { provider: 'anthropic-oauth', model: 'claude-test' },
    );
    const events = [];
    const next = prepareProviderPrefixGuard(
        first,
        [{ role: 'user', content: 'one' }],
        {
            tools: [
                { name: 'read' },
                { name: 'mcp__demo__deferred', deferLoading: true },
            ],
            nativeTools: [],
        },
        {
            provider: 'anthropic-oauth',
            model: 'claude-test',
            onCacheBreak: (event) => events.push(event),
        },
    );
    assert.equal(next.requestPrefixHash, first.requestPrefixHash);
    assert.deepEqual(events, []);

    const payload = buildCacheBreakPayload({
        classification: 'intentional',
        reason: 'tool_schema_changed',
        previousHash: 'c'.repeat(64),
    });
    assert.equal(payload.previous_hash.length, 16);
});
