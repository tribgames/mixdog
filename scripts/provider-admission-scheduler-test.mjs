import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    PROVIDER_ACCOUNT_CONCURRENCY,
    PROVIDER_ACCOUNT_MAX_QUEUE,
    ProviderAdmissionScheduler,
    notifyCurrentAnthropicRateLimit,
    providerAdmissionKey,
    wrapProviderAdmission,
} from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import { providerInputExcludesCache } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
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

test('fixed 64-wide non-Anthropic lane drains a bounded FIFO queue in continuous waves', async () => {
    assert.equal(PROVIDER_ACCOUNT_CONCURRENCY, 64);
    assert.equal(PROVIDER_ACCOUNT_MAX_QUEUE, 1024);
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

test('hard ceiling and bounded queue reject overflow explicitly', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1000, maxQueue: 2 });
    assert.equal(scheduler.concurrency, 64);
    const gate = deferred();
    const first = scheduler.run('openai:a', () => gate.promise);
    const second = scheduler.run('openai:a', () => gate.promise);
    const third = scheduler.run('openai:a', () => gate.promise);
    // Fill all 64 active slots before exercising the two queue positions.
    const active = Array.from({ length: 61 }, () => scheduler.run('openai:a', () => gate.promise));
    const queuedA = scheduler.run('openai:a', () => gate.promise);
    const queuedB = scheduler.run('openai:a', () => gate.promise);
    await assert.rejects(
        scheduler.run('openai:a', async () => 'overflow'),
        (error) => error?.code === 'EPROVIDERQUEUEFULL' && error?.maxQueue === 2,
    );
    gate.resolve();
    await Promise.all([first, second, third, ...active, queuedA, queuedB]);
    assert.equal(scheduler.lanes.size, 0);
});

test('Anthropic internal 429 followed by success still cools down and recovers additively', async () => {
    let now = 10_000;
    const timers = new Set();
    const scheduler = new ProviderAdmissionScheduler({
        concurrency: 4,
        now: () => now,
        setTimer(fn, delay) {
            const timer = { fn, at: now + delay };
            timers.add(timer);
            return timer;
        },
        clearTimer(timer) { timers.delete(timer); },
    });
    const advance = async (ms) => {
        now += ms;
        for (const timer of [...timers]) {
            if (timer.at <= now) {
                timers.delete(timer);
                timer.fn();
            }
        }
        await new Promise((resolve) => setImmediate(resolve));
    };

    assert.equal(notifyCurrentAnthropicRateLimit(
        Object.assign(new Error('outside'), { httpStatus: 429, retryAfterMs: 5000 }),
    ), false);
    assert.equal(await scheduler.run('anthropic-oauth:acct', async () => (
        // Provider-owned recursive recovery must reuse the current slot.
        scheduler.run('anthropic-oauth:acct', async () => {
            assert.equal(notifyCurrentAnthropicRateLimit(
                Object.assign(new Error('limited'), { httpStatus: 429, retryAfterMs: 5000 }),
            ), true);
            return 'eventual-success';
        })
    )), 'eventual-success');
    const lane = scheduler.lanes.get('anthropic-oauth:acct');
    assert.equal(lane.limit, 2);

    const gates = Array.from({ length: 5 }, deferred);
    let started = 0;
    const work = gates.map((gate) => scheduler.run('anthropic-oauth:acct', async () => {
        started += 1;
        await gate.promise;
    }));
    await advance(4999);
    assert.equal(started, 0);
    await advance(1);
    assert.equal(started, 2);
    gates[0].resolve();
    gates[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lane.limit, 3);
    assert.equal(started, 5);
    gates.slice(2).forEach((gate) => gate.resolve());
    await Promise.all(work);
    assert.equal(lane.limit, 4);
    assert.equal(scheduler.lanes.size, 0);
});

test('Anthropic cooldown chunks oversized timers and deletes reduced idle lane only at expiry', async () => {
    let now = 1000;
    const delays = [];
    let timer = null;
    const scheduler = new ProviderAdmissionScheduler({
        concurrency: 4,
        now: () => now,
        setTimer(fn, delay) {
            delays.push(delay);
            timer = { fn, at: now + delay };
            return timer;
        },
        clearTimer() { timer = null; },
    });
    const runTimer = async () => {
        const pending = timer;
        timer = null;
        now = pending.at;
        pending.fn();
        await new Promise((resolve) => setImmediate(resolve));
    };
    const oversized = 2_147_483_647 + 1234;

    await scheduler.run('anthropic:acct', async () => {
        notifyCurrentAnthropicRateLimit(
            Object.assign(new Error('long cooldown'), { httpStatus: 429, retryAfterMs: oversized }),
        );
        return 'ok';
    });
    assert.equal(scheduler.lanes.get('anthropic:acct')?.limit, 2);
    assert.equal(delays[0], 2_147_483_647);
    assert.equal(scheduler.lanes.has('anthropic:acct'), true);

    await runTimer();
    assert.equal(delays[1], 1234);
    assert.equal(scheduler.lanes.has('anthropic:acct'), true);
    await runTimer();
    assert.equal(scheduler.lanes.has('anthropic:acct'), false);

    assert.equal(await scheduler.run('openai:acct', async () => (
        notifyCurrentAnthropicRateLimit(
            Object.assign(new Error('non-anthropic'), { httpStatus: 429, retryAfterMs: 1000 }),
        )
    )), false);
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

test('lane identity uses real Claude credential path across access and refresh rotation', () => {
    const claudeBefore = {
        credentials: { path: 'C:\\accounts\\claude-a.json', accessToken: 'access-old', refreshToken: 'refresh-old' },
    };
    const claudeAfter = {
        credentials: { path: 'C:\\accounts\\claude-a.json', accessToken: 'access-new', refreshToken: 'refresh-new' },
    };
    const claudeOther = {
        credentials: { path: 'C:\\accounts\\claude-b.json', accessToken: 'access-old', refreshToken: 'refresh-old' },
    };
    assert.equal(
        providerAdmissionKey('anthropic-oauth', claudeBefore),
        providerAdmissionKey('anthropic-oauth', claudeAfter),
    );
    assert.notEqual(
        providerAdmissionKey('anthropic-oauth', claudeBefore),
        providerAdmissionKey('anthropic-oauth', claudeOther),
    );

    const grokA = { tokens: { user_id: 'user-a', access_token: 'old' } };
    const grokARefreshed = { tokens: { user_id: 'user-a', access_token: 'new' } };
    const grokB = { tokens: { user_id: 'user-b', access_token: 'old' } };
    assert.equal(providerAdmissionKey('grok-oauth', grokA), providerAdmissionKey('grok-oauth', grokARefreshed));
    assert.notEqual(providerAdmissionKey('grok-oauth', grokA), providerAdmissionKey('grok-oauth', grokB));
    assert.notEqual(
        providerAdmissionKey('opencode-go', { config: { apiKey: 'account-a' } }),
        providerAdmissionKey('opencode-go', { config: { apiKey: 'account-b' } }),
    );
    assert.notEqual(
        providerAdmissionKey('anthropic', { apiKey: 'direct-account-a', config: {} }),
        providerAdmissionKey('anthropic', { apiKey: 'direct-account-b', config: {} }),
    );
});

test('usage convention is declared by providers, never guessed from an unknown name', () => {
    assert.equal(AnthropicProvider.inputExcludesCache, true);
    assert.equal(AnthropicOAuthProvider.inputExcludesCache, true);
    assert.equal(providerInputExcludesCache('anthropic'), true);
    assert.equal(providerInputExcludesCache('anthropic-oauth'), true);
    assert.equal(providerInputExcludesCache('unknown-anthropic-compatible-proxy'), false);
});

test('fresh registry knows built-in Anthropic usage convention before provider instantiation', () => {
    const registryUrl = new URL('../src/runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const r = await import(${JSON.stringify(registryUrl)}); process.stdout.write(JSON.stringify([
            r.providerInputExcludesCache('anthropic'),
            r.providerInputExcludesCache('anthropic-oauth'),
            r.providerInputExcludesCache('disabled-anthropic-proxy')
        ]));`,
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), [true, true, false]);
});

test('usage lookup stays registration-free when OAuth credentials are available', () => {
    const registryUrl = new URL('../src/runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href;
    const probesUrl = new URL('../src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-usage-pure-'));
        const credentialsPath = path.join(dir, 'openai-oauth.json');
        fs.writeFileSync(credentialsPath, JSON.stringify({access_token:'fixture',refresh_token:'fixture'}));
        process.env.OPENAI_OAUTH_CREDENTIALS_PATH = credentialsPath;
        try {
            const probes = await import(${JSON.stringify(probesUrl)});
            const r = await import(${JSON.stringify(registryUrl)});
            const available = probes.hasOpenAIOAuthCredentials();
            const before = r.getAllProviders().size;
            const usage = r.providerInputExcludesCache('openai-oauth');
            const after = r.getAllProviders().size;
            process.stdout.write(JSON.stringify([available, before, usage, after]));
        } finally {
            fs.rmSync(dir, {recursive:true, force:true});
        }`,
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), [true, 0, false, 0]);
});

test('loaded Anthropic OAuth constructor remains untouched by usage lookup', () => {
    const registryUrl = new URL('../src/runtime/agent/orchestrator/providers/registry.mjs', import.meta.url).href;
    const probesUrl = new URL('../src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs', import.meta.url).href;
    const output = execFileSync(process.execPath, [
        '--input-type=module',
        '--eval',
        `const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-usage-loaded-'));
        const credentialsPath = path.join(dir, 'anthropic-oauth.json');
        fs.writeFileSync(credentialsPath, JSON.stringify({
            claudeAiOauth: {accessToken:'fixture', scopes:['user:inference']}
        }));
        process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = credentialsPath;
        try {
            const probes = await import(${JSON.stringify(probesUrl)});
            const r = await import(${JSON.stringify(registryUrl)});
            let constructorCalls = 0;
            class LoadedAnthropicOAuth {
                static inputExcludesCache = true;
                constructor() { constructorCalls++; }
            }
            const available = probes.hasAnthropicOAuthCredentials();
            const legacy = r._withLoadedProviderCtorForTest(
                'anthropic-oauth',
                LoadedAnthropicOAuth,
                () => {
                    r.getProvider('anthropic-oauth');
                    return [constructorCalls, r.getAllProviders().size];
                },
            );
            const restoredAfterLegacy = r.getAllProviders().size;
            constructorCalls = 0;
            const current = r._withLoadedProviderCtorForTest(
                'anthropic-oauth',
                LoadedAnthropicOAuth,
                () => [
                    r.providerInputExcludesCache('anthropic-oauth'),
                    constructorCalls,
                    r.getAllProviders().size,
                ],
            );
            process.stdout.write(JSON.stringify([
                available, ...legacy, restoredAfterLegacy, ...current, r.getAllProviders().size
            ]));
        } finally {
            fs.rmSync(dir, {recursive:true, force:true});
        }`,
    ], { encoding: 'utf8' });
    // The legacy getProvider-based path constructs/registers (1,1). The pure
    // lookup returns true without either effect, and both seam exits restore.
    assert.deepEqual(JSON.parse(output), [true, 1, 1, 0, true, 0, 0, 0]);
});

test('first-byte deadlines remain 60 seconds', () => {
    assert.equal(PROVIDER_FIRST_BYTE_TIMEOUT_MS, 60_000);
    assert.equal(PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS, 60_000);
    assert.equal(WS_PRE_RESPONSE_CREATED_MS, 60_000);
});
