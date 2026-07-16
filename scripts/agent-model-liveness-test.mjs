#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
    _clearSessionRuntime,
    _getRuntimeEntry,
    getSessionProgressSnapshot,
    markSessionAskStart,
    markSessionStreamDelta,
    updateSessionStage,
} from '../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs';
import {
    evaluateAgentWatchdogAbort,
    resolveEffectiveToolRunningCeilingMs,
} from '../src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';
import {
    buildAgentTaskProgressFields,
    formatAgentWatchdogSummary,
} from '../src/standalone/agent-task-status.mjs';
import {
    consumeCompatChatCompletionStream,
    consumeCompatResponsesStream,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-sse.mjs';
import { _streamResponse } from '../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import { sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';
import { shouldFallbackTransport } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import {
    PROVIDER_MAX_BEFORE_WARN_MS,
    PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
    PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS,
} from '../src/runtime/agent/orchestrator/stall-policy.mjs';
import {
    ProviderAdmissionScheduler,
    wrapProviderAdmission,
} from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';

const policy = {
    firstTransportMs: 120_000,
    firstSemanticMs: 600_000,
    idleStaleMs: 600_000,
    toolRunningMs: 600_000,
};

test('OpenAI HTTP and WS semantic idle defaults share the pre-watchdog ceiling', () => {
    assert.equal(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_MAX_BEFORE_WARN_MS);
    assert.equal(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_MAX_BEFORE_WARN_MS);
    assert.ok(PROVIDER_WS_SEMANTIC_IDLE_TIMEOUT_MS < 300_000);
});

function seededSnapshot(id, elapsedMs) {
    markSessionAskStart(id);
    const entry = _getRuntimeEntry(id);
    const startedAt = Date.now() - elapsedMs;
    entry.askStartedAt = startedAt;
    entry.modelRequestStartedAt = startedAt;
    entry.lastProgressAt = startedAt;
    return { entry, snapshot: () => getSessionProgressSnapshot(id) };
}

test('independent first transport and semantic deadlines', async (t) => {
    const id = `liveness-deadlines-${Date.now()}`;
    t.after(() => _clearSessionRuntime(id));
    const { entry, snapshot } = seededSnapshot(id, 121_000);
    let err = evaluateAgentWatchdogAbort(snapshot(), Date.now(), policy);
    assert.match(err?.message || '', /first transport stale \(120000ms\)/);

    entry.lastTransportAt = Date.now();
    err = evaluateAgentWatchdogAbort(snapshot(), entry.modelRequestStartedAt + 599_999, policy);
    assert.equal(err, null, 'keepalive transport must not switch/reset the semantic deadline');
    err = evaluateAgentWatchdogAbort(snapshot(), entry.modelRequestStartedAt + 600_001, policy);
    assert.match(err?.message || '', /first semantic response stale \(600000ms\)/);

    await markSessionStreamDelta(id, 'reasoning');
    assert.equal(evaluateAgentWatchdogAbort(snapshot(), entry.modelRequestStartedAt + 700_000, policy), null);
    assert.equal(snapshot().hasVisibleProgress, false);
});

test('genuinely queued scheduler request remains outside the real watchdog clock', async (t) => {
    const id = `liveness-admission-${Date.now()}`;
    t.after(() => _clearSessionRuntime(id));
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const provider = wrapProviderAdmission({
        async send(_messages, _model, _tools, opts) {
            if (opts.block) return firstGate;
            return 'queued-ok';
        },
    }, 'watchdog-integration', scheduler);
    markSessionAskStart(id);
    const entry = _getRuntimeEntry(id);
    entry.askStartedAt = Date.now() - 900_000;
    entry.lastProgressAt = entry.askStartedAt;
    const first = provider.send([], 'm', [], { block: true });
    const second = provider.send([], 'm', [], {
        onStageChange: (stage) => updateSessionStage(id, stage),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entry.modelRequestStartedAt, null);
    assert.equal(evaluateAgentWatchdogAbort(getSessionProgressSnapshot(id), Date.now(), policy), null);
    releaseFirst('first');
    await first;
    assert.equal(await second, 'queued-ok');
    assert.ok(entry.modelRequestStartedAt >= Date.now() - 100);
});

test('status labels distinguish transport, semantic, reasoning, text, tool, and true stall', async (t) => {
    const id = `liveness-status-${Date.now()}`;
    t.after(() => _clearSessionRuntime(id));
    const { entry, snapshot } = seededSnapshot(id, 10_000);
    const fields = () => buildAgentTaskProgressFields({
        now: Date.now(),
        runtimeStage: entry.stage,
        snapshot: snapshot(),
        runtime: entry,
        policy,
    });

    assert.equal(fields().last_progress, 'awaiting model transport');
    assert.equal(fields().watchdog, 'armed transport=120s');
    await markSessionStreamDelta(id, 'transport');
    assert.equal(fields().last_progress, 'transport active; awaiting first model event');
    assert.equal(fields().watchdog, 'armed semantic=600s');
    await markSessionStreamDelta(id, 'semantic');
    assert.equal(fields().last_progress, 'model active (no visible output yet)');
    await markSessionStreamDelta(id, 'reasoning');
    assert.equal(fields().last_progress, 'model reasoning (hidden; no visible output yet)');
    assert.equal(fields().diagnostic, 'hidden reasoning active; no visible output yet');
    await markSessionStreamDelta(id, 'text');
    assert.equal(fields().last_progress, 'visible model text');
    await markSessionStreamDelta(id, 'reasoning');
    assert.equal(fields().last_progress, 'model reasoning (hidden; visible output previously emitted)');
    await markSessionStreamDelta(id, 'tool');
    entry.lastVisibleTextAt = null;
    assert.equal(fields().last_progress, 'tool protocol progress');
    assert.equal(formatAgentWatchdogSummary(policy), 'armed transport=120s semantic=600s idle=600s tool=600s');

    entry.firstSemanticAt = null;
    entry.lastSemanticAt = null;
    entry.lastTransportAt = Date.now();
    entry.modelRequestStartedAt = Date.now() - 600_001;
    assert.match(fields().diagnostic, /^stale: first semantic response stale/);
});

test('tool-running status uses the same effective self-deadline ceiling as the watchdog', () => {
    const snapshot = {
        stage: 'tool_running',
        toolStartedAt: 1_000,
        currentTool: 'shell',
        toolSelfDeadlineMs: 900_000,
        lastProgressAt: 1_000,
    };
    const toolPolicy = { ...policy, idleStaleMs: 0 };
    assert.equal(resolveEffectiveToolRunningCeilingMs(snapshot, toolPolicy), 960_000);
    assert.equal(formatAgentWatchdogSummary(toolPolicy, snapshot), 'armed tool=960s');
    assert.equal(evaluateAgentWatchdogAbort(snapshot, 961_000, toolPolicy), null);
    assert.match(
        evaluateAgentWatchdogAbort(snapshot, 961_001, toolPolicy)?.message || '',
        /tool running stale \(960000ms\)/,
    );
});

function asyncEvents(events) {
    return { async *[Symbol.asyncIterator]() { for (const event of events) yield event; } };
}

function heartbeatOnlyStream(firstEvent, heartbeatEvent, intervalMs = 10) {
    return {
        async *[Symbol.asyncIterator]() {
            yield firstEvent;
            while (true) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
                yield heartbeatEvent;
            }
        },
    };
}

function closablePendingStream(firstEvent, { closeError = null } = {}) {
    let delivered = false;
    let returnCalls = 0;
    const iterator = {
        next() {
            if (!delivered) {
                delivered = true;
                return Promise.resolve({ done: false, value: firstEvent });
            }
            return new Promise(() => {});
        },
        return() {
            returnCalls += 1;
            if (closeError) return Promise.reject(closeError);
            return Promise.resolve({ done: true });
        },
    };
    return {
        stream: { [Symbol.asyncIterator]: () => iterator },
        returnCalls: () => returnCalls,
    };
}

async function assertCompatIteratorCloses({ kind, mode }) {
    const firstEvent = kind === 'chat'
        ? { choices: [{ delta: { role: 'assistant' } }] }
        : { type: 'response.created', response: { id: 'r1', model: 'gpt' } };
    const closeError = new Error(`${kind}-${mode} close failure`);
    const pending = closablePendingStream(firstEvent, { closeError });
    const controller = new AbortController();
    const originalAbort = new Error(`${kind} original abort`);
    const options = {
        label: `${kind}-${mode}`,
        signal: controller.signal,
        semanticIdleTimeoutMs: 25,
        ...(kind === 'responses'
            ? { parseResponsesToolCalls: () => undefined, responseOutputText: () => '' }
            : {}),
    };
    const consume = kind === 'chat'
        ? consumeCompatChatCompletionStream
        : consumeCompatResponsesStream;
    const keepAlive = setInterval(() => {}, 10);
    try {
        const run = consume(pending.stream, options);
        await new Promise((resolve) => setImmediate(resolve));
        if (mode === 'abort') controller.abort(originalAbort);
        if (mode === 'abort') {
            await assert.rejects(run, (err) => err === originalAbort);
        } else {
            await assert.rejects(run, (err) => err?.name === 'StreamStalledError');
        }
        assert.equal(pending.returnCalls(), 1, `${kind} ${mode} must close iterator once`);
    } finally {
        clearInterval(keepAlive);
    }
}

test('compat Chat/Responses watchdog and abort rejection close iterators without masking errors', async () => {
    for (const kind of ['chat', 'responses']) {
        for (const mode of ['abort', 'watchdog']) {
            await assertCompatIteratorCloses({ kind, mode });
        }
    }
});

test('recovered Chat tool persists eager-dispatch safety across a later stream failure', async () => {
    const original = new Error('compat stream failed after leaked tool dispatch');
    let step = 0;
    const stream = {
        [Symbol.asyncIterator]() {
            return {
                next() {
                    step += 1;
                    if (step === 1) {
                        return Promise.resolve({
                            done: false,
                            value: { choices: [{ delta: { content: '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>' } }] },
                        });
                    }
                    return Promise.reject(original);
                },
            };
        },
    };
    const calls = [];
    const rejected = await consumeCompatChatCompletionStream(stream, {
        label: 'leaked-tool-failure',
        knownToolNames: new Set(['read']),
        onToolCall: (call) => calls.push(call),
        parseToolCalls: () => undefined,
    }).then(() => null, (err) => err);
    assert.equal(rejected, original);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read');
    assert.equal(rejected.emittedToolCall, true);
    assert.equal(rejected.unsafeToRetry, true);
    assert.equal(shouldFallbackTransport(rejected, { enabled: true }), false);

    const truncatedCalls = [];
    const truncated = await consumeCompatChatCompletionStream(asyncEvents([
        { choices: [{ delta: { content: '<invoke name="read"><parameter name="path">b.txt</parameter></invoke>' } }] },
    ]), {
        label: 'leaked-tool-truncation',
        knownToolNames: new Set(['read']),
        onToolCall: (call) => truncatedCalls.push(call),
        parseToolCalls: () => undefined,
    }).then(() => null, (err) => err);
    assert.equal(truncatedCalls.length, 1);
    assert.equal(truncated.emittedToolCall, true);
    assert.equal(truncated.unsafeToRetry, true);
});

test('compat Chat/Responses metadata heartbeats stay transport-only and cannot rearm semantic idle', async () => {
    const chatKinds = [];
    await assert.rejects(
        consumeCompatChatCompletionStream(
            heartbeatOnlyStream(
                { choices: [{ delta: { role: 'assistant' } }] },
                { id: 'meta', model: 'gpt', choices: [] },
            ),
            {
                label: 'chat-heartbeat',
                semanticIdleTimeoutMs: 45,
                onStreamDelta: (kind) => chatKinds.push(kind),
            },
        ),
        (err) => err?.name === 'StreamStalledError',
    );
    assert.deepEqual(chatKinds.filter((kind) => kind !== 'transport'), ['semantic']);
    const chatSemanticIndex = chatKinds.indexOf('semantic');
    assert.ok(chatSemanticIndex >= 0);
    assert.ok(chatKinds.slice(chatSemanticIndex + 1).every((kind) => kind === 'transport'));

    const responseKinds = [];
    await assert.rejects(
        consumeCompatResponsesStream(
            heartbeatOnlyStream(
                { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
                { type: 'response.in_progress', response: { id: 'r1' } },
            ),
            {
                label: 'responses-heartbeat',
                semanticIdleTimeoutMs: 45,
                onStreamDelta: (kind) => responseKinds.push(kind),
                parseResponsesToolCalls: () => undefined,
                responseOutputText: () => '',
            },
        ),
        (err) => err?.name === 'StreamStalledError',
    );
    assert.deepEqual(responseKinds.filter((kind) => kind !== 'transport'), ['semantic']);
    const responseSemanticIndex = responseKinds.indexOf('semantic');
    assert.ok(responseSemanticIndex >= 0);
    assert.ok(responseKinds.slice(responseSemanticIndex + 1).every((kind) => kind === 'transport'));
});

test('OpenAI compat chat and Responses classify semantic progress without exposing reasoning', async () => {
    const chatKinds = [];
    const chat = await consumeCompatChatCompletionStream(asyncEvents([
        { choices: [{ delta: { reasoning_content: 'secret' } }] },
        { choices: [{ delta: { content: 'hello' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ]), {
        label: 'test',
        onStreamDelta: (kind) => chatKinds.push(kind),
        parseToolCalls: () => [{ id: 'call_1', name: 'read', arguments: {} }],
    });
    assert.ok(chatKinds.includes('transport'));
    assert.ok(chatKinds.includes('reasoning'));
    assert.ok(chatKinds.includes('text'));
    assert.ok(chatKinds.includes('tool'));
    assert.equal(chat.content, 'hello');
    assert.equal(chat.reasoningContent, 'secret');

    const responseKinds = [];
    await consumeCompatResponsesStream(asyncEvents([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.reasoning_text.delta', delta: 'secret' },
        { type: 'response.output_text.delta', delta: 'done' },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', output: [] } },
    ]), {
        label: 'test',
        onStreamDelta: (kind) => responseKinds.push(kind),
        parseResponsesToolCalls: () => undefined,
        responseOutputText: () => '',
    });
    assert.deepEqual(new Set(responseKinds), new Set(['transport', 'semantic', 'reasoning', 'text']));
});

const encoder = new TextEncoder();
function anthropicResponse(events) {
    const chunks = events.map((event) => encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ));
    let index = 0;
    return { body: { getReader: () => ({
        read: async () => index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true },
        cancel: async () => {},
        releaseLock: () => {},
    }) } };
}

test('Anthropic classifies message_start, reasoning, text, and tool protocol with transport separate', async () => {
    const kinds = [];
    await parseSSEStream(anthropicResponse([
        { type: 'message_start', message: { model: 'claude', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'read' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
    ]), null, () => {}, (kind) => kinds.push(kind), () => {}, {}, null);
    assert.ok(kinds.includes('transport'));
    assert.ok(kinds.includes('semantic'));
    assert.ok(kinds.includes('reasoning'));
    assert.ok(kinds.includes('text'));
    assert.ok(kinds.includes('tool'));
});

test('Anthropic redacted_thinking is private reasoning and never visible text', async () => {
    const kinds = [];
    const visible = [];
    const result = await parseSSEStream(anthropicResponse([
        { type: 'message_start', message: { model: 'claude', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-secret' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' },
    ]), null, () => {}, (kind) => kinds.push(kind), () => {}, {}, (text) => visible.push(text));
    assert.ok(kinds.includes('reasoning'));
    assert.equal(kinds.includes('text'), false);
    assert.deepEqual(visible, []);
    assert.equal(result.content, '');
    assert.deepEqual(result.thinkingBlocks, [{ type: 'redacted_thinking', data: 'opaque-secret' }]);
});

class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    close() {}
    ping() {}
    feed(events) { for (const event of events) this.emit('message', JSON.stringify(event)); }
}

function openAiHttpResponse(events) {
    const chunks = events.map((event) => encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ));
    let index = 0;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: { getReader: () => ({
            read: async () => index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true },
            cancel: async () => {},
            releaseLock: () => {},
        }) },
    };
}

test('OAuth HTTP retries refresh requesting-stage liveness for every attempt', async (t) => {
    const id = `liveness-oauth-http-retries-${Date.now()}`;
    t.after(() => _clearSessionRuntime(id));
    markSessionAskStart(id);
    const entry = _getRuntimeEntry(id);
    const stages = [];
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 1 });
    let fetchCalls = 0;

    const provider = wrapProviderAdmission({
        async send(_messages, _model, _tools, opts) {
            return sendViaHttpSse({
                auth: { type: 'openai-direct', apiKey: 'test' },
                body: {},
                opts: {},
                useModel: 'gpt',
                onStageChange: opts?.onStageChange,
                fetchFn: async () => {
                    fetchCalls += 1;
                    if (fetchCalls <= 4) throw new Error('transient request failure');
                    return openAiHttpResponse([
                        { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } },
                    ]);
                },
                _sleepFn: async () => {},
            });
        },
    }, 'liveness-oauth-http-retries', scheduler);
    await provider.send([], 'gpt', [], {
        onStageChange: (stage, detail) => {
            // Set a known stale value before the real ask-session liveness
            // update. The post-send assertion therefore fails if this callback
            // no longer refreshes lastProgressAt.
            entry.lastProgressAt = 1;
            updateSessionStage(id, stage);
            stages.push({ stage, detail, lastProgressAt: entry.lastProgressAt });
        },
    });

    assert.equal(fetchCalls, 5);
    // Admission emits the first requesting signal, followed by one from each
    // HTTP attempt. Keep the total explicit so stage-only consumers cannot
    // silently dedupe the retry heartbeats.
    const requestingStages = stages.filter(({ stage }) => stage === 'requesting');
    assert.equal(stages.length, 7);
    assert.deepEqual(requestingStages.map(({ stage }) => stage), Array(6).fill('requesting'));
    assert.ok(requestingStages.every(({ lastProgressAt }) => lastProgressAt > 1));
    assert.equal(requestingStages[0].detail, undefined);
    assert.deepEqual(requestingStages.slice(1).map(({ detail }) => detail), [
        { attempt: 1, maxAttempts: 5, retry: false },
        { attempt: 2, maxAttempts: 5, retry: true },
        { attempt: 3, maxAttempts: 5, retry: true },
        { attempt: 4, maxAttempts: 5, retry: true },
        { attempt: 5, maxAttempts: 5, retry: true },
    ]);
});

function wedgedOpenAiHttpResponse() {
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: { getReader: () => ({
            read: () => new Promise(() => {}),
            // Deliberately never settles: sendViaHttpSse must reject its own
            // pending read race rather than trusting cancel().
            cancel: () => new Promise(() => {}),
            releaseLock: () => {},
        }) },
    };
}

function firstEventThenWedgedOpenAiHttpResponse() {
    const first = encoder.encode(
        `event: response.created\ndata: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'r1', model: 'gpt' },
        })}\n\n`,
    );
    let emitted = false;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: { getReader: () => ({
            read: () => {
                if (!emitted) {
                    emitted = true;
                    return Promise.resolve({ done: false, value: first });
                }
                return new Promise(() => {});
            },
            cancel: () => new Promise(() => {}),
            releaseLock: () => {},
        }) },
    };
}

test('OAuth HTTP SSE actively rejects a wedged reader on external and semantic aborts', async () => {
    const keepAlive = setInterval(() => {}, 10);
    try {
    const startedAt = Date.now();
    const external = new AbortController();
    const externalReason = new Error('reviewer external abort');
    const externalRun = sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test' },
        body: {},
        opts: {},
        externalSignal: external.signal,
        useModel: 'gpt',
        fetchFn: async () => firstEventThenWedgedOpenAiHttpResponse(),
    });
    setTimeout(() => external.abort(externalReason), 10);
    await assert.rejects(externalRun, (err) => err === externalReason);

    const semanticRun = sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test' },
        body: {},
        opts: { _semanticIdleTimeoutMs: 25 },
        useModel: 'gpt',
        fetchFn: async () => firstEventThenWedgedOpenAiHttpResponse(),
    });
    await assert.rejects(semanticRun, (err) => (
        err?.name === 'StreamStalledError'
        && err?.streamStalled === true
    ));
    assert.ok(Date.now() - startedAt < 1_000, 'wedged reads must reject near their abort deadlines');
    } finally {
        clearInterval(keepAlive);
    }
});

test('OAuth HTTP SSE enforces first server event independently of response headers', async () => {
    const keepAlive = setInterval(() => {}, 10);
    try {
        const startedAt = Date.now();
        await assert.rejects(sendViaHttpSse({
            auth: { type: 'openai-direct', apiKey: 'test' },
            body: {},
            opts: { _firstServerEventTimeoutMs: 40, _semanticIdleTimeoutMs: 5 },
            useModel: 'gpt',
            fetchFn: async () => wedgedOpenAiHttpResponse(),
        }), (err) => err?.code === 'EPROVIDERTIMEOUT' && err?.firstByteTimeout === true);
        assert.ok(Date.now() - startedAt >= 30, 'semantic idle must not shorten the first-event deadline');
    } finally {
        clearInterval(keepAlive);
    }
});

test('completion bundles report actual reasoning/text/tool kinds across compat, WS, and OAuth SSE', async () => {
    const output = [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'final' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' },
    ];

    const compatKinds = [];
    await consumeCompatResponsesStream(asyncEvents([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output } },
    ]), {
        label: 'bundle-compat',
        onStreamDelta: (kind) => compatKinds.push(kind),
        parseResponsesToolCalls: () => undefined,
        responseOutputText: () => 'final',
    });
    for (const kind of ['reasoning', 'text', 'tool']) assert.ok(compatKinds.includes(kind), `compat missing ${kind}`);

    const wsKinds = [];
    const socket = new FakeSocket();
    const wsRun = _streamResponse({
        entry: { socket },
        state: {},
        onStreamDelta: (kind) => wsKinds.push(kind),
        _timeouts: { interChunkMs: 5_000, preResponseCreatedMs: 5_000, firstMeaningfulMs: 5_000 },
    });
    socket.feed([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', output } },
    ]);
    await wsRun;
    for (const kind of ['reasoning', 'text', 'tool']) assert.ok(wsKinds.includes(kind), `ws missing ${kind}`);

    const oauthKinds = [];
    await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test' },
        body: {},
        opts: {},
        useModel: 'gpt',
        onStreamDelta: (kind) => oauthKinds.push(kind),
        fetchFn: async () => openAiHttpResponse([
            { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
            { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output } },
        ]),
    });
    for (const kind of ['reasoning', 'text', 'tool']) assert.ok(oauthKinds.includes(kind), `oauth missing ${kind}`);
});

const PURE_LEAK = '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>';

test('synthesized leaked tools report tool progress without visible-text progress', async () => {
    const compatKinds = [];
    const compatVisible = [];
    await consumeCompatChatCompletionStream(asyncEvents([
        { choices: [{ delta: { content: PURE_LEAK } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]), {
        label: 'leak-compat',
        knownToolNames: new Set(['read']),
        onStreamDelta: (kind) => compatKinds.push(kind),
        onTextDelta: (text) => compatVisible.push(text),
        parseToolCalls: () => undefined,
    });
    assert.ok(compatKinds.includes('tool'));
    assert.equal(compatKinds.includes('text'), false);
    assert.deepEqual(compatVisible, []);

    const compatResponseKinds = [];
    const compatResponseVisible = [];
    await consumeCompatResponsesStream(asyncEvents([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.output_text.delta', delta: PURE_LEAK },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } },
    ]), {
        label: 'leak-compat-responses',
        knownToolNames: new Set(['read']),
        onStreamDelta: (kind) => compatResponseKinds.push(kind),
        onTextDelta: (text) => compatResponseVisible.push(text),
        parseResponsesToolCalls: () => undefined,
        responseOutputText: () => '',
    });
    assert.ok(compatResponseKinds.includes('tool'));
    assert.equal(compatResponseKinds.includes('text'), false);
    assert.deepEqual(compatResponseVisible, []);

    const anthropicKinds = [];
    const anthropicVisible = [];
    await parseSSEStream(anthropicResponse([
        { type: 'message_start', message: { model: 'claude', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PURE_LEAK } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
        { type: 'message_stop' },
    ]), null, () => {}, (kind) => anthropicKinds.push(kind), () => {}, {}, (text) => anthropicVisible.push(text), new Set(['read']));
    assert.ok(anthropicKinds.includes('tool'));
    assert.equal(anthropicKinds.includes('text'), false);
    assert.deepEqual(anthropicVisible, []);

    const wsKinds = [];
    const wsVisible = [];
    const socket = new FakeSocket();
    const wsRun = _streamResponse({
        entry: { socket },
        state: {},
        knownToolNames: new Set(['read']),
        onStreamDelta: (kind) => wsKinds.push(kind),
        onTextDelta: (text) => wsVisible.push(text),
        _timeouts: { interChunkMs: 5_000, preResponseCreatedMs: 5_000, firstMeaningfulMs: 5_000 },
    });
    socket.feed([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.output_text.delta', delta: PURE_LEAK },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', output: [] } },
    ]);
    await wsRun;
    assert.ok(wsKinds.includes('tool'));
    assert.equal(wsKinds.includes('text'), false);
    assert.deepEqual(wsVisible, []);

    const oauthKinds = [];
    const oauthVisible = [];
    await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test' },
        body: { tools: [{ name: 'read' }] },
        opts: {},
        useModel: 'gpt',
        onStreamDelta: (kind) => oauthKinds.push(kind),
        onTextDelta: (text) => oauthVisible.push(text),
        fetchFn: async () => openAiHttpResponse([
            { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
            { type: 'response.output_text.delta', delta: PURE_LEAK },
            { type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } },
        ]),
    });
    assert.ok(oauthKinds.includes('tool'));
    assert.equal(oauthKinds.includes('text'), false);
    assert.deepEqual(oauthVisible, []);
});

test('OpenAI WS reports transport plus semantic/reasoning/text classifications', async () => {
    const id = `liveness-ws-${Date.now()}`;
    const kinds = [];
    const socket = new FakeSocket();
    markSessionAskStart(id);
    const p = _streamResponse({
        entry: { socket },
        state: { sessionId: id },
        onStreamDelta: (kind) => kinds.push(kind),
        _timeouts: { interChunkMs: 5_000, preResponseCreatedMs: 5_000, firstMeaningfulMs: 5_000 },
    });
    socket.feed([
        { type: 'response.created', response: { id: 'r1', model: 'gpt' } },
        { type: 'response.reasoning_text.delta', delta: 'secret' },
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.completed', response: { id: 'r1', model: 'gpt', output: [] } },
    ]);
    await p;
    assert.ok(_getRuntimeEntry(id)?.lastTransportAt);
    assert.ok(kinds.includes('semantic'));
    assert.ok(kinds.includes('reasoning'));
    assert.ok(kinds.includes('text'));
    _clearSessionRuntime(id);
});
