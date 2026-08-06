#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-turn-ttft-'));
process.env.MIXDOG_DATA_DIR = DATA_DIR;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

test.after(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
});

test('MCP connection grace is opt-in so it cannot tax default TTFT', async () => {
    const previous = process.env.MIXDOG_MCP_TURN_GRACE_MS;
    delete process.env.MIXDOG_MCP_TURN_GRACE_MS;
    try {
        const { readRuntimeTunables } = await import('../src/session-runtime/runtime-tunables.mjs');
        assert.equal(readRuntimeTunables().mcpTurnGraceMs, 0);
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_MCP_TURN_GRACE_MS;
        else process.env.MIXDOG_MCP_TURN_GRACE_MS = previous;
    }
});

test('provider and tool-loop boundaries propagate in execution order', { concurrency: false }, async () => {
    const { initProviders, getProvider } = await import(
        '../src/runtime/agent/orchestrator/providers/registry.mjs'
    );
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const events = [];
    let sends = 0;
    provider.send = async (_messages, _model, _tools, opts) => {
        sends += 1;
        events.push(`send:${sends}`);
        if (sends === 1) {
            return {
                content: '',
                toolCalls: [{
                    id: 'ttft-list',
                    name: 'list',
                    arguments: { path: process.cwd(), head_limit: 1 },
                }],
                stopReason: 'tool_use',
                usage: { inputTokens: 1, outputTokens: 1 },
            };
        }
        opts.onStreamDelta?.('text');
        opts.onTextDelta?.('done');
        return {
            content: 'done',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
        };
    };

    const {
        askSession,
        closeSession,
        createSession,
    } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const session = createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: 'readonly',
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    try {
        await askSession(
            session.id,
            'list one entry',
            null,
            null,
            process.cwd(),
            null,
            {
                onProviderSendStarted: () => events.push('provider-boundary'),
                onToolPhaseStarted: () => events.push('tool-start'),
                onToolPhaseCompleted: () => events.push('tool-complete'),
                onStreamDelta: () => {},
            },
        );
        assert.deepEqual(events, [
            'provider-boundary',
            'send:1',
            'tool-start',
            'tool-complete',
            'provider-boundary',
            'send:2',
        ]);
    } finally {
        try { closeSession(session.id, 'ttft-test'); } catch {}
    }
});
