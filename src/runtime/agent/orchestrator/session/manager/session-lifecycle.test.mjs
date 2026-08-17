import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { contextSeedForRouteUpdate } from './session-lifecycle.mjs';

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
