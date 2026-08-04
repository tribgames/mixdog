import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicProvider } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import {
    ProviderAdmissionScheduler,
    wrapProviderAdmission,
} from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';

const encoder = new TextEncoder();

function sseResponse(events, headers = new Map()) {
    const bytes = encoder.encode(events.map((event) => (
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )).join(''));
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers,
        body: { getReader: () => ({
            async read() {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: bytes };
            },
            async cancel() {},
            releaseLock() {},
        }) },
    };
}

test('real wrapped Anthropic retries report HTTP and SSE 429 before eventual success', async () => {
    let now = 10_000;
    const scheduled = [];
    const scheduler = new ProviderAdmissionScheduler({
        concurrency: 4,
        now: () => now,
        setTimer(fn, delay) {
            const timer = { fn, delay };
            scheduled.push(timer);
            return timer;
        },
        clearTimer() {},
    });

    const provider = Object.create(AnthropicProvider.prototype);
    provider.name = 'anthropic';
    provider.config = { apiKey: 'fixture-key' };
    provider.fastModeBetaHeaderLatched = false;
    let attempts = 0;
    provider.client = { messages: { create() {
        attempts += 1;
        return { async asResponse() {
            if (attempts === 1) {
                return {
                    ok: false,
                    status: 429,
                    headers: new Map([['retry-after-ms', '7']]),
                    async text() { return 'limited'; },
                };
            }
            if (attempts === 2) {
                return sseResponse([
                    { type: 'error', error: { type: 'rate_limit_error', message: 'rate limit' } },
                ], new Map([['retry-after-ms', '11']]));
            }
            return sseResponse([
                { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
                { type: 'message_stop' },
            ]);
        } };
    } } };

    wrapProviderAdmission(provider, 'anthropic', scheduler);
    const result = await provider.send([], 'claude-sonnet-4-5', [], {});
    assert.equal(result.content, 'ok');
    assert.equal(attempts, 3);

    const lane = [...scheduler.lanes.values()][0];
    assert.equal(lane.limit, 1, 'each internally recovered 429 adapts the lane');
    assert.equal(lane.cooldownUntil, now + 11, 'full SSE Retry-After reaches admission');
    assert.ok(scheduled.some((timer) => timer.delay === 7));
});

test('terminal Anthropic 429 is adapted once by admission, not provider retry notification', async () => {
    const previous = process.env.CLAUDE_CODE_MAX_RETRIES;
    process.env.CLAUDE_CODE_MAX_RETRIES = '0';
    try {
        const scheduler = new ProviderAdmissionScheduler({
            concurrency: 4,
            setTimer() { return { unref() {} }; },
            clearTimer() {},
        });
        const provider = Object.create(AnthropicProvider.prototype);
        provider.name = 'anthropic';
        provider.config = { apiKey: 'fixture-key' };
        provider.fastModeBetaHeaderLatched = false;
        provider.client = { messages: { create() {
            return { async asResponse() {
                return {
                    ok: false,
                    status: 429,
                    headers: new Map([['retry-after-ms', '20']]),
                    async text() { return 'terminal'; },
                };
            } };
        } } };
        wrapProviderAdmission(provider, 'anthropic', scheduler);
        await assert.rejects(provider.send([], 'claude-sonnet-4-5', [], {}), (err) => err?.status === 429);
        assert.equal([...scheduler.lanes.values()][0]?.limit, 2);
    } finally {
        if (previous == null) delete process.env.CLAUDE_CODE_MAX_RETRIES;
        else process.env.CLAUDE_CODE_MAX_RETRIES = previous;
    }
});
