#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-max-output-persist-'));

test('askSession persists recovery history without duplicating the returned aggregate', async () => {
    const { initProviders, getProvider } = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const responses = [
        {
            content: 'persisted partial ',
            stopReason: 'MAX_TOKENS',
            truncated: true,
            usage: { inputTokens: 4, outputTokens: 3, cachedTokens: 1, promptTokens: 4 },
        },
        {
            content: 'terminal segment',
            stopReason: 'end_turn',
            usage: { inputTokens: 2, outputTokens: 2, cachedTokens: 0, promptTokens: 2 },
        },
    ];
    let sendIndex = 0;
    const streamed = [];
    provider.send = async (_messages, _model, _tools, opts = {}) => {
        const response = responses[sendIndex++];
        assert.ok(response, `unexpected provider send ${sendIndex}`);
        opts.onTextDelta?.(response.content);
        streamed.push(response.content);
        return response;
    };

    const { createSession, askSession, getSession } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const session = createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: [],
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });

    const result = await askSession(
        session.id,
        'produce a long answer',
        null,
        null,
        process.cwd(),
        null,
        { onTextDelta: () => {} },
    );
    const persisted = getSession(session.id);
    const partialRows = persisted.messages.filter((message) => message.role === 'assistant' && message.content === 'persisted partial ');
    const terminalRows = persisted.messages.filter((message) => message.role === 'assistant' && message.content === 'terminal segment');
    const aggregateRows = persisted.messages.filter((message) => message.role === 'assistant' && message.content === result.content);

    assert.equal(result.content, 'persisted partial terminal segment');
    assert.equal(streamed.join(''), result.content, 'streamed TUI text matches the aggregate without duplication');
    assert.equal(partialRows.length, 1);
    assert.equal(terminalRows.length, 1);
    assert.equal(aggregateRows.length, 0, 'aggregate is returned but is not persisted over the recovery chain');
    assert.equal(
        persisted.messages.filter((message) => message?.meta?.source === 'max-output-recovery').length,
        1,
    );
    assert.deepEqual(
        {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedTokens: result.usage.cachedTokens,
            promptTokens: result.usage.promptTokens,
        },
        { inputTokens: 6, outputTokens: 5, cachedTokens: 1, promptTokens: 6 },
    );
});
