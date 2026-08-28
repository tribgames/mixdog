import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotProviderRequestTools } from './provider-request-snapshot.mjs';

test('Anthropic deferred tool snapshot adds only discovered schemas', () => {
    const session = {
        provider: 'anthropic-oauth',
        deferredNativeTools: true,
        deferredToolCatalog: [
            { name: 'shell', inputSchema: { type: 'object', properties: {} } },
            { name: 'recall', inputSchema: { type: 'object', properties: {} } },
        ],
    };
    const tools = [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }];
    const first = snapshotProviderRequestTools({
        provider: session.provider,
        tools,
        messages: [],
        session,
    });
    const later = snapshotProviderRequestTools({
        provider: session.provider,
        tools,
        messages: [{
            role: 'tool',
            nativeToolSearch: {
                provider: 'anthropic-oauth',
                toolReferences: ['shell'],
            },
        }],
        session,
    });
    assert.deepEqual(first.map((tool) => tool.name), ['load_tool']);
    assert.deepEqual(later.map((tool) => tool.name), ['load_tool', 'shell']);
    assert.equal(later[1].deferLoading, true);
    assert.equal(later.some((tool) => tool.name === 'recall'), false);
});

test('Anthropic can select a late MCP schema without exposing unselected peers', () => {
    const session = {
        provider: 'anthropic-oauth',
        deferredNativeTools: true,
        deferredToolCatalog: [],
        deferredLateToolCatalog: [
            { name: 'mcp__demo__selected', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
            { name: 'mcp__demo__hidden', inputSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
        ],
        deferredDiscoveredTools: ['mcp__demo__selected'],
    };
    const snapshot = snapshotProviderRequestTools({
        provider: session.provider,
        tools: [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }],
        messages: [],
        session,
    });

    assert.deepEqual(snapshot.map((tool) => tool.name), ['load_tool', 'mcp__demo__selected']);
    assert.equal(snapshot[1].deferLoading, true);
});
