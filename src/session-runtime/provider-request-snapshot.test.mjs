import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotProviderRequestTools } from './provider-request-snapshot.mjs';

test('Anthropic deferred tool surface is complete and byte-stable from the first send', () => {
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
    assert.deepEqual(JSON.parse(JSON.stringify(later)), JSON.parse(JSON.stringify(first)));
    assert.deepEqual(first.map((tool) => tool.name), ['load_tool', 'shell', 'recall']);
    assert.equal(first[1].deferLoading, true);
    assert.equal(first[2].deferLoading, true);
});
