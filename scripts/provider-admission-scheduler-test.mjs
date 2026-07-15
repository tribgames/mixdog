import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PROVIDER_ACCOUNT_CONCURRENCY,
    ProviderAdmissionScheduler,
    providerAdmissionKey,
    wrapProviderAdmission,
} from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import { withRetry } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS,
} from '../src/runtime/agent/orchestrator/stall-policy.mjs';
import { WS_PRE_RESPONSE_CREATED_MS } from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import { withXaiResponsesCacheLane } from '../src/runtime/agent/orchestrator/providers/openai-compat-xai.mjs';
import { AnthropicOAuthProvider } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { AnthropicProvider } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

test('fixed 64-wide lane drains an unbounded FIFO queue in continuous waves', async () => {
    assert.equal(PROVIDER_ACCOUNT_CONCURRENCY, 64);
    const scheduler = new ProviderAdmissionScheduler();
    const gate = deferred();
    let active = 0;
    let peak = 0;
    let started = 0;
    const startedOrder = [];
    const work = Array.from({ length: 150 }, (_, index) => scheduler.run('openai:acct', async () => {
        active += 1;
        started += 1;
        startedOrder.push(index);
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return index;
    }));
    await new Promise((r) => setImmediate(r));
    assert.equal(started, 64);
    assert.equal(peak, 64);
    gate.resolve();
    assert.deepEqual(await Promise.all(work), Array.from({ length: 150 }, (_, i) => i));
    assert.deepEqual(startedOrder, Array.from({ length: 150 }, (_, i) => i));
    assert.equal(peak, 64);
});

test('provider/account lanes are independent and never adapt downward', async () => {
    const scheduler = new ProviderAdmissionScheduler();
    const gate = deferred();
    let activeA = 0;
    let activeB = 0;
    const jobs = [];
    for (let i = 0; i < 70; i += 1) {
        jobs.push(scheduler.run('gemini:a', async () => { activeA += 1; await gate.promise; }));
        jobs.push(scheduler.run('gemini:b', async () => { activeB += 1; await gate.promise; }));
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(activeA, 64);
    assert.equal(activeB, 64);
    gate.resolve();
    await Promise.all(jobs);
});

test('queued cancellation removes work and running cancellation reaches provider signal', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    const runningAbort = new AbortController();
    const queuedAbort = new AbortController();
    let queuedRan = false;
    const running = scheduler.run('anthropic:a', (signal) => new Promise((_, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { signal: runningAbort.signal });
    const queued = scheduler.run('anthropic:a', async () => { queuedRan = true; }, { signal: queuedAbort.signal });
    await new Promise((r) => setImmediate(r));
    queuedAbort.abort(new Error('queued canceled'));
    assert.equal(scheduler.lanes.get('anthropic:a')?.queue.length, 0);
    runningAbort.abort(new Error('running canceled'));
    await assert.rejects(queued, /queued canceled/);
    await assert.rejects(running, /running canceled/);
    assert.equal(queuedRan, false);
});

test('shutdown rejects the queue and aborts every running request', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    let queuedRan = false;
    const running = scheduler.run('openai:a', (signal) => new Promise((_, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const queued = scheduler.run('openai:a', async () => { queuedRan = true; });
    await new Promise((r) => setImmediate(r));
    scheduler.shutdown(new Error('process ending'));
    await assert.rejects(queued, /process ending/);
    await assert.rejects(running, /process ending/);
    assert.equal(queuedRan, false);
    await assert.rejects(scheduler.run('openai:a', async () => 'late'), /process ending/);
});

test('queue wait is outside provider timeout lifetime', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    const firstGate = deferred();
    const provider = wrapProviderAdmission({
        name: 'test',
        async send(_messages, _model, _tools, opts) {
            if (opts.block) return firstGate.promise;
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve('ok'), 5);
                opts.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(opts.signal.reason);
                }, { once: true });
            });
        },
    }, 'test', scheduler);
    const first = provider.send([], 'm', [], { block: true });
    const second = provider.send([], 'm', [], {});
    await new Promise((r) => setTimeout(r, 30));
    firstGate.resolve('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'ok');
});

test('429 and timeout retry only when the provider marks the request safe', async () => {
    let rateAttempts = 0;
    await assert.rejects(withRetry(async () => {
        rateAttempts += 1;
        throw Object.assign(new Error('rate limited unsafe'), {
            httpStatus: 429,
            unsafeToRetry: true,
        });
    }, { maxAttempts: 2, backoffMs: [1, 1], retryJitterRatio: 0 }), /unsafe/);
    assert.equal(rateAttempts, 1);

    let safeRateAttempts = 0;
    const rateResult = await withRetry(async () => {
        safeRateAttempts += 1;
        if (safeRateAttempts === 1) throw Object.assign(new Error('rate limited'), { httpStatus: 429 });
        return 'rate-ok';
    }, { maxAttempts: 2, backoffMs: [1, 1], retryJitterRatio: 0 });
    assert.equal(rateResult, 'rate-ok');
    assert.equal(safeRateAttempts, 2);

    let timeoutAttempts = 0;
    const timeoutResult = await withRetry(async () => {
        timeoutAttempts += 1;
        if (timeoutAttempts === 1) throw Object.assign(new Error('timed out'), { code: 'EPROVIDERTIMEOUT' });
        return 'timeout-ok';
    }, { maxAttempts: 2, backoffMs: [1, 1], retryJitterRatio: 0 });
    assert.equal(timeoutResult, 'timeout-ok');
    assert.equal(timeoutAttempts, 2);

    let unsafeAttempts = 0;
    await assert.rejects(withRetry(async () => {
        unsafeAttempts += 1;
        throw Object.assign(new Error('rate limited after output'), {
            httpStatus: 429,
            liveTextEmitted: true,
            unsafeToRetry: true,
        });
    }, { maxAttempts: 2, backoffMs: [1, 1] }), /after output/);
    assert.equal(unsafeAttempts, 1);
});

test('common admission never nests a retry around provider retry ownership', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    let attempts = 0;
    let active = 0;
    let peak = 0;
    const provider = wrapProviderAdmission({
        name: 'raw-transport',
        async send() {
            attempts += 1;
            active += 1;
            peak = Math.max(peak, active);
            active -= 1;
            throw Object.assign(new Error('429'), { httpStatus: 429 });
        },
    }, 'raw-transport', scheduler);
    await assert.rejects(provider.send([], 'm', [], {}), /429/);
    assert.equal(attempts, 1);
    assert.equal(peak, 1);
});

test('xAI legacy cache-lane knobs cannot create a secondary queue or timeout', async () => {
    const gate = deferred();
    const started = [];
    const opts = { xaiCacheMaxInFlight: 1, xaiCacheQueueTimeoutMs: 1 };
    const run = (index) => withXaiResponsesCacheLane({
        opts, config: {}, cacheRouting: { key: 'same' }, model: 'grok', transport: 'http',
        previousResponseId: null, inputCount: 1, signal: null,
    }, async (meta) => {
        started.push(index);
        assert.equal(meta.enabled, false);
        await gate.promise;
        return index;
    });
    const first = run(0);
    const second = run(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(started, [0, 1]);
    gate.resolve();
    assert.deepEqual((await Promise.all([first, second])).map((item) => item.value), [0, 1]);
});

test('Anthropic providers retry request-local pre-output 429 responses', async () => {
    const oauth = Object.create(AnthropicOAuthProvider.prototype);
    oauth.credentials = { accessToken: 'fixture', expiresAt: Date.now() + 60_000 };
    oauth.config = {};
    oauth.fastModeBetaHeaderLatched = false;
    oauth.ensureAuth = async () => oauth.credentials;
    let oauthAttempts = 0;
    const oauthResult = await oauth.send([], 'claude-sonnet-4-5', [], {
        _doRequestFn: async () => {
            oauthAttempts += 1;
            return {
                response: {
                    status: oauthAttempts === 1 ? 429 : 200,
                    ok: oauthAttempts > 1,
                    headers: new Map([['retry-after', '0']]),
                    async text() { return ''; },
                },
                controller: { abort() {} },
                cancelHandler: null,
            };
        },
        _parseSSEFn: async () => ({
            content: 'oauth-ok', model: 'claude', toolCalls: [], usage: {},
        }),
    });
    assert.equal(oauthResult.content, 'oauth-ok');
    assert.equal(oauthAttempts, 2);

    const direct = Object.create(AnthropicProvider.prototype);
    direct.name = 'anthropic';
    direct.config = {};
    direct.fastModeBetaHeaderLatched = false;
    let directAttempts = 0;
    direct.client = { messages: { create() {
        directAttempts += 1;
        return { async asResponse() {
            if (directAttempts === 1) {
                return { ok: false, status: 429, headers: new Map([['retry-after', '0']]), async text() { return ''; } };
            }
            return anthropicSuccessResponse();
        } };
    } } };
    const directResult = await direct._doSend([], 'claude-sonnet-4-5', [], {});
    assert.equal(directResult.content, 'direct-ok');
    assert.equal(directAttempts, 2);
});

function anthropicSuccessResponse() {
    const events = [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'direct-ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
    const bytes = new TextEncoder().encode(events.map((event) => (
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )).join(''));
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
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

test('admission starts request stage only after queue wait', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    const gate = deferred();
    const stages = [];
    const provider = wrapProviderAdmission({
        async send(_messages, _model, _tools, opts) {
            if (opts.block) return gate.promise;
            return 'ok';
        },
    }, 'clock', scheduler);
    const first = provider.send([], 'm', [], { block: true });
    const second = provider.send([], 'm', [], { onStageChange: (stage) => stages.push(stage) });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(stages, []);
    gate.resolve('first');
    await first;
    assert.equal(await second, 'ok');
    assert.deepEqual(stages, ['requesting']);
});

test('lane identity uses delegated provider credentials and stable OAuth account ids', () => {
    const grokA = { tokens: { user_id: 'user-a', access_token: 'old' } };
    const grokARefreshed = { tokens: { user_id: 'user-a', access_token: 'new' } };
    const grokB = { tokens: { user_id: 'user-b', access_token: 'old' } };
    assert.equal(providerAdmissionKey('grok-oauth', grokA), providerAdmissionKey('grok-oauth', grokARefreshed));
    assert.notEqual(providerAdmissionKey('grok-oauth', grokA), providerAdmissionKey('grok-oauth', grokB));
    assert.notEqual(
        providerAdmissionKey('opencode-go', { config: { apiKey: 'account-a' } }),
        providerAdmissionKey('opencode-go', { config: { apiKey: 'account-b' } }),
    );
});

test('first-byte deadlines remain 60 seconds', () => {
    assert.equal(PROVIDER_FIRST_BYTE_TIMEOUT_MS, 60_000);
    assert.equal(PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS, 60_000);
    assert.equal(WS_PRE_RESPONSE_CREATED_MS, 60_000);
});
