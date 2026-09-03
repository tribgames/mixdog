import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenCodeGoProvider } from './opencode-go.mjs';

test('OpenCode Go Anthropic routes preserve the caller live-tail cache strategy', async () => {
    const provider = new OpenCodeGoProvider({
        apiKey: 'test-key',
        baseURL: 'https://opencode.ai/zen/go/v1',
    });
    const cacheStrategy = {
        tools: 'none',
        system: '1h',
        tier3: '1h',
        messages: '1h',
    };
    let capturedOpts = null;
    provider.anthropic = {
        send: async (_messages, _model, _tools, opts) => {
            capturedOpts = opts;
            return {
                usage: {
                    inputTokens: 7,
                    cachedTokens: 100,
                    cacheWriteTokens: 20,
                    promptTokens: 7,
                },
            };
        },
    };

    const result = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'minimax-m2.7',
        [],
        { cacheStrategy, sessionId: 'opencode-go-cache-test' },
    );

    assert.equal(capturedOpts.sessionId, 'opencode-go-cache-test');
    assert.deepEqual(capturedOpts.cacheStrategy, cacheStrategy);
    assert.equal(result.usage.inputTokens, 127);
    assert.equal(result.usage.promptTokens, 127);
});

test('OpenCode Go Anthropic routes do not synthesize a cache override', async () => {
    const provider = new OpenCodeGoProvider({
        apiKey: 'test-key',
        baseURL: 'https://opencode.ai/zen/go/v1',
    });
    let capturedOpts = null;
    provider.anthropic = {
        send: async (_messages, _model, _tools, opts) => {
            capturedOpts = opts;
            return {};
        },
    };

    await provider.send(
        [{ role: 'user', content: 'hello' }],
        'qwen3-coder',
        [],
        { sessionId: 'opencode-go-default-cache-test' },
    );

    assert.deepEqual(capturedOpts, { sessionId: 'opencode-go-default-cache-test' });
});
