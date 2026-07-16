#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    OpenAICompatProvider,
    OPENAI_COMPAT_PRESETS,
    applyCompatProviderChatOptions,
    parseToolCalls,
} from '../src/runtime/agent/orchestrator/providers/openai-compat.mjs';
import { consumeCompatChatCompletionStream } from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { GrokOAuthProvider } from '../src/runtime/agent/orchestrator/providers/grok-oauth.mjs';
import { sendViaWebSocket } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
    OpenCodeGoProvider,
    isAnthropicGoModel,
    openCodeGoEndpointForModel,
    resolveOpenCodeGoBaseURLs,
} from '../src/runtime/agent/orchestrator/providers/opencode-go.mjs';
import { uncachedInputTokensForProvider } from '../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs';
import { resolveTraceUsageInput } from '../src/runtime/agent/orchestrator/agent-trace.mjs';
import {
    billableInputTokensForProvider,
    isInclusiveProvider,
} from '../src/runtime/shared/llm/cost.mjs';

function stream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
    };
}

test('current vendor preset defaults and OpenCode Go protocol routes are pinned', () => {
    assert.equal(OPENAI_COMPAT_PRESETS.xai.defaultModel, 'grok-4.5');
    assert.equal(OPENAI_COMPAT_PRESETS.deepseek.defaultModel, 'deepseek-v4-pro');
    assert.equal(OPENAI_COMPAT_PRESETS['opencode-go'].defaultModel, 'glm-5.2');
    for (const model of ['minimax-m3', 'minimax-m2.7', 'qwen3.7-max', 'qwen3.6-plus']) {
        assert.equal(isAnthropicGoModel(model), true, model);
    }
    for (const model of ['glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'mimo-v2.5-pro']) {
        assert.equal(isAnthropicGoModel(model), false, model);
    }
    assert.deepEqual(resolveOpenCodeGoBaseURLs(), {
        openai: 'https://opencode.ai/zen/go/v1',
        anthropic: 'https://opencode.ai/zen/go',
    });
    assert.equal(
        openCodeGoEndpointForModel('minimax-m3'),
        'https://opencode.ai/zen/go/v1/messages',
    );
    assert.equal(
        openCodeGoEndpointForModel('glm-5.2'),
        'https://opencode.ai/zen/go/v1/chat/completions',
    );
});

test('provider-specific thinking fields do not leak across compat contracts', () => {
    const deepseek = applyCompatProviderChatOptions({}, 'deepseek', { effort: 'low' });
    assert.deepEqual(deepseek, {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
    });
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'deepseek', { effort: 'none' }),
        { thinking: { type: 'disabled' } },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'ollama', { effort: 'max' }),
        { reasoning_effort: 'max' },
    );
    const go = applyCompatProviderChatOptions(
        {},
        'opencode-go',
        { effort: 'high' },
        {},
        { reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
    );
    assert.deepEqual(go, { reasoning_effort: 'high' });
    assert.equal(go.thinking, undefined);
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'lmstudio', {}, { reasoningEffort: 'medium' }),
        { reasoning_effort: 'medium' },
    );
    assert.deepEqual(applyCompatProviderChatOptions({}, 'xai', { effort: 'none' }), {});
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'xai', { effort: 'high' }),
        { reasoning_effort: 'high' },
    );
    assert.deepEqual(applyCompatProviderChatOptions({}, 'deepseek'), {});
});

test('compat chat stream preserves LM Studio reasoning alias without mixing it into answer text', async () => {
    const result = await consumeCompatChatCompletionStream(stream([
        { id: 'r', model: 'local', choices: [{ delta: { reasoning: 'plan ' } }] },
        { id: 'r', model: 'local', choices: [{ delta: { reasoning: 'done', content: 'answer' } }] },
        { id: 'r', model: 'local', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]), {
        label: 'lmstudio',
        parseToolCalls,
    });
    assert.equal(result.reasoningContent, 'plan done');
    assert.equal(result.content, 'answer');
});

test('compat API-key auth retries 401 once but never retries entitlement 403', async () => {
    const forbidden = Object.create(OpenAICompatProvider.prototype);
    let forbiddenCalls = 0;
    let reloads = 0;
    forbidden._doSend = async () => {
        forbiddenCalls += 1;
        throw new Error('403 forbidden');
    };
    forbidden.reloadApiKey = () => { reloads += 1; };
    await assert.rejects(() => forbidden.send([], 'm'), /403/);
    assert.equal(forbiddenCalls, 1);
    assert.equal(reloads, 0);

    const unauthorized = Object.create(OpenAICompatProvider.prototype);
    let unauthorizedCalls = 0;
    unauthorized._doSend = async () => {
        unauthorizedCalls += 1;
        if (unauthorizedCalls === 1) throw new Error('401 unauthorized');
        return { content: 'ok' };
    };
    unauthorized.reloadApiKey = () => { reloads += 1; };
    assert.equal((await unauthorized.send([], 'm')).content, 'ok');
    assert.equal(unauthorizedCalls, 2);
    assert.equal(reloads, 1);

    const structuredUnauthorized = Object.create(OpenAICompatProvider.prototype);
    let structuredCalls = 0;
    let structuredReloads = 0;
    structuredUnauthorized._doSend = async () => {
        structuredCalls += 1;
        if (structuredCalls === 1) throw Object.assign(new Error('authentication rejected'), { status: 0, httpStatus: 401 });
        return { content: 'ok' };
    };
    structuredUnauthorized.reloadApiKey = () => { structuredReloads += 1; };
    assert.equal((await structuredUnauthorized.send([], 'm')).content, 'ok');
    assert.equal(structuredCalls, 2);
    assert.equal(structuredReloads, 1);

    const structuredForbidden = Object.create(OpenAICompatProvider.prototype);
    let structuredForbiddenCalls = 0;
    structuredForbidden._doSend = async () => {
        structuredForbiddenCalls += 1;
        throw Object.assign(new Error('policy denied'), { httpStatus: 403 });
    };
    structuredForbidden.reloadApiKey = () => { throw new Error('must not reload'); };
    await assert.rejects(() => structuredForbidden.send([], 'm'), /policy denied/);
    assert.equal(structuredForbiddenCalls, 1);
});

test('OpenCode Go normalizes both route families to inclusive provider usage', async () => {
    const anthropicRaw = {
        content: 'ok',
        usage: {
            inputTokens: 60,
            outputTokens: 5,
            cachedTokens: 35,
            cacheWriteTokens: 5,
            promptTokens: 100,
        },
    };
    const openaiRaw = {
        content: 'ok',
        usage: {
            inputTokens: 100,
            outputTokens: 5,
            cachedTokens: 40,
            cacheWriteTokens: 0,
            promptTokens: 100,
        },
    };
    const provider = Object.create(OpenCodeGoProvider.prototype);
    provider.anthropic = { send: async () => anthropicRaw };
    provider.openai = { send: async () => openaiRaw };
    const anthropic = await provider.send([], 'minimax-m3', [], {});
    assert.equal(OpenCodeGoProvider.inputExcludesCache, false);
    assert.equal(isInclusiveProvider('opencode-go'), true);
    assert.equal(anthropic.usage.inputTokens, 100);
    assert.equal(anthropic.usage.promptTokens, 100);
    assert.equal(uncachedInputTokensForProvider('opencode-go', anthropic.usage.inputTokens, 35, 5), 60);
    assert.equal(billableInputTokensForProvider('opencode-go', 100, 35, 5), 60);
    assert.deepEqual(resolveTraceUsageInput({
        provider: 'opencode-go',
        inputTokens: 60,
        cachedTokens: 35,
        cacheWriteTokens: 5,
        inputTokensInclusive: false,
    }), {
        uncachedInputTokens: 60,
        promptTokens: 100,
    });
    assert.equal(anthropic.usage.inputTokens, 100, 'context footprint is inclusive');

    const openai = await provider.send([], 'glm-5.2', [], {});
    assert.equal(openai, openaiRaw);
    assert.equal(uncachedInputTokensForProvider('opencode-go', openai.usage.inputTokens, 40, 0), 60);
    assert.equal(billableInputTokensForProvider('opencode-go', 100, 40, 0), 60);
    assert.deepEqual(resolveTraceUsageInput({
        provider: 'opencode-go',
        inputTokens: 100,
        cachedTokens: 40,
        cacheWriteTokens: 0,
    }), {
        uncachedInputTokens: 60,
        promptTokens: 100,
    });
    assert.equal(openai.usage.inputTokens, 100, 'context footprint remains inclusive');
});

test('OpenCode Go Anthropic delegation traces additive inner usage before inclusive outer normalization', (t) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mixdog-opencode-go-trace-'));
    const tracePath = join(tempDir, 'agent-trace.jsonl');
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const openCodeGoUrl = new URL('../src/runtime/agent/orchestrator/providers/opencode-go.mjs', import.meta.url).href;
    const anthropicUrl = new URL('../src/runtime/agent/orchestrator/providers/anthropic.mjs', import.meta.url).href;
    const traceUrl = new URL('../src/runtime/agent/orchestrator/agent-trace.mjs', import.meta.url).href;
    const fixture = `
        const { OpenCodeGoProvider } = await import(${JSON.stringify(openCodeGoUrl)});
        const { AnthropicProvider } = await import(${JSON.stringify(anthropicUrl)});
        const { drainAgentTrace } = await import(${JSON.stringify(traceUrl)});

        const encoder = new TextEncoder();
        const events = [
            { type: 'message_start', message: {
                model: 'minimax-m3',
                usage: {
                    input_tokens: 60,
                    cache_read_input_tokens: 35,
                    cache_creation_input_tokens: 5,
                },
            } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ];
        const chunks = events.map((event) => encoder.encode(
            'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n'
        ));
        let chunkIndex = 0;
        const response = {
            ok: true,
            status: 200,
            headers: new Map(),
            body: { getReader() {
                return {
                    read() {
                        return chunkIndex < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[chunkIndex++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            } },
        };

        const inner = Object.create(AnthropicProvider.prototype);
        inner.name = 'opencode-go';
        inner.config = { disableBetaHeaders: true };
        inner.fastModeBetaHeaderLatched = false;
        inner.client = { messages: { create() {
            return { asResponse: async () => response };
        } } };

        const outer = Object.create(OpenCodeGoProvider.prototype);
        outer.anthropic = inner;
        outer.openai = { send() { throw new Error('wrong OpenCode Go route'); } };
        const result = await outer.send(
            [{ role: 'user', content: 'fixture' }],
            'minimax-m3',
            [],
            { sessionId: 'opencode-go-additive-trace' },
        );
        await drainAgentTrace();
        process.stdout.write(JSON.stringify(result.usage));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: {
            ...process.env,
            MIXDOG_AGENT_TRACE_DISABLE: '0',
            MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '0',
            MIXDOG_AGENT_TRACE_PATH: tracePath,
        },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const outerUsage = JSON.parse(child.stdout);
    assert.deepEqual(outerUsage, {
        inputTokens: 100,
        outputTokens: 5,
        cachedTokens: 35,
        cacheWriteTokens: 5,
        promptTokens: 100,
    });
    const traceRows = readFileSync(tracePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    const innerUsage = traceRows.find((row) => (
        row.kind === 'usage_raw'
        && row.session_id === 'opencode-go-additive-trace'
    ));
    assert.ok(innerUsage, 'delegated Anthropic route must emit usage_raw');
    assert.equal(innerUsage.payload.provider, 'opencode-go');
    assert.equal(innerUsage.input_tokens, 60);
    assert.equal(innerUsage.cached_tokens, 35);
    assert.equal(innerUsage.cache_write_tokens, 5);
    assert.equal(innerUsage.uncached_input_tokens, 60);
    assert.equal(innerUsage.prompt_tokens, 100);
});

test('constructing Grok OAuth is network inert', () => {
    const provider = new GrokOAuthProvider({
        preconnectFn: () => { throw new Error('constructor attempted outbound preconnect'); },
    });
    assert.ok(provider);
});

test('Grok OAuth end-to-end HTTP Responses path is hermetic through inner compat', async (t) => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('global fetch attempted by hermetic Grok path');
    };
    t.after(() => { globalThis.fetch = priorFetch; });

    const provider = new GrokOAuthProvider({
        preconnect: false,
        preconnectFn: () => {
            throw new Error('preconnect/undici attempted by hermetic Grok path');
        },
        responsesTransport: 'http',
    });
    provider.ensureAuth = async () => ({ access_token: 'fixture-token' });
    const inner = provider._ensureInner('fixture-token', 'grok-4.5');
    assert.equal(inner.config.preconnect, false, 'Grok seam must propagate to inner compat');
    assert.equal(typeof inner.config.preconnectFn, 'function');
    inner.client = {
        responses: {
            create: async () => stream([
                { type: 'response.created', response: { id: 'resp_fixture', model: 'grok-4.5' } },
                { type: 'response.output_text.delta', delta: 'hermetic' },
                {
                    type: 'response.completed',
                    response: {
                        id: 'resp_fixture',
                        model: 'grok-4.5',
                        status: 'completed',
                        output: [],
                        usage: { input_tokens: 3, output_tokens: 1 },
                    },
                },
            ]),
        },
    };

    const result = await provider.send(
        [{ role: 'user', content: 'fixture' }],
        'grok-4.5',
        [],
        { sessionId: 'hermetic-grok-contract' },
    );
    assert.equal(result.content, 'hermetic');
    assert.equal(result.usage.inputTokens, 3);
});

test('Grok OAuth does not refresh/replay a 401 after visible tool dispatch', async () => {
    const provider = Object.create(GrokOAuthProvider.prototype);
    provider.config = { preconnect: false };
    let authCalls = 0;
    provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
        authCalls += 1;
        assert.equal(forceRefresh, false);
        return { access_token: 'fixture-token' };
    };
    const streamed401 = Object.assign(new Error('401 midstream'), {
        httpStatus: 401,
        emittedToolCall: true,
        unsafeToRetry: true,
    });
    let dispatched = 0;
    provider._ensureInner = () => ({
        _doSend: async (_messages, _model, _tools, opts) => {
            opts.onToolCall({ id: 'call-visible', name: 'write', arguments: { path: 'x' } });
            dispatched += 1;
            throw streamed401;
        },
    });
    await assert.rejects(() => provider.send([], 'grok-4.5', [], {
        onToolCall: () => {},
    }), (err) => err === streamed401);
    assert.equal(dispatched, 1);
    assert.equal(authCalls, 1);
});

test('xAI WS to HTTP fallback preserves completed warmup usage and cost ticks', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    const provider = new OpenAICompatProvider('xai', {
        apiKey: 'fixture',
        preconnect: false,
        responsesTransport: 'websocket',
    });
    const warmup = {
        requestBody: { generate: false },
        usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 4, promptTokens: 10, raw: { cost_in_usd_ticks: 100 } },
    };
    provider._doSendXaiResponsesWebSocket = async () => {
        const err = Object.assign(new Error('upgrade required'), { httpStatus: 426 });
        Object.defineProperty(err, '__warmup', { value: warmup });
        throw err;
    };
    provider._doSendXaiResponses = async () => ({
        content: 'fallback',
        usage: { inputTokens: 20, outputTokens: 2, cachedTokens: 5, promptTokens: 20, raw: { cost_in_usd_ticks: 200 }, costUsd: 0.00000002 },
    });
    const result = await provider._doSend([], 'grok-4.5', [], {});
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.mainInputTokens, 20);
    assert.equal(result.usage.raw.cost_in_usd_ticks, 300);
    assert.equal(result.usage.costUsd, 0.00000003);
});

test('xAI WS warmup billing exposes only main request usage as context', async () => {
    let streams = 0;
    const result = await sendViaWebSocket({
        auth: { type: 'xai', apiKey: 'fixture' },
        body: { model: 'grok-4.5', input: [{ role: 'user', content: 'main' }] },
        sendOpts: {},
        externalSignal: null,
        poolKey: 'xai-warmup-accounting',
        cacheKey: 'xai-warmup-accounting',
        iteration: 1,
        useModel: 'grok-4.5',
        traceProvider: 'xai',
        includeResponseId: true,
        warmupBody: { model: 'grok-4.5', input: [], generate: false },
        _acquireWithRetryFn: async () => ({ entry: { socket: { close() {} } }, reused: false }),
        _sendFrameFn: async () => {},
        _streamFn: async ({ state }) => {
            streams += 1;
            return state.warmup
                ? {
                    content: '',
                    model: 'grok-4.5',
                    toolCalls: [],
                    usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 4, promptTokens: 10, raw: { cost_in_usd_ticks: 100 } },
                    responseId: 'warm',
                    responseItems: [],
                }
                : {
                    content: 'done',
                    model: 'grok-4.5',
                    toolCalls: [],
                    usage: { inputTokens: 20, outputTokens: 2, cachedTokens: 5, promptTokens: 20, raw: { cost_in_usd_ticks: 200 } },
                    responseId: 'main',
                    responseItems: [],
                    closeSocket: true,
                };
        },
        _agentTraceFn: () => {},
        _sendSpanTraceFn: () => {},
    });
    assert.equal(streams, 2);
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.mainInputTokens, 20);
    assert.equal(result.usage.raw.cost_in_usd_ticks, 300);
});

test('xAI safe 401 replay carries completed warmup into the retry', async () => {
    const provider = new OpenAICompatProvider('xai', { apiKey: 'fixture', preconnect: false });
    const warmup = { usage: { inputTokens: 10 } };
    let attempts = 0;
    provider.reloadApiKey = () => {};
    provider._doSend = async (_messages, _model, _tools, opts) => {
        attempts += 1;
        if (attempts === 1) {
            const err = Object.assign(new Error('401'), { httpStatus: 401 });
            Object.defineProperty(err, '__warmup', { value: warmup });
            throw err;
        }
        assert.equal(opts._carriedWarmup, warmup);
        return { content: 'retried' };
    };
    assert.equal((await provider.send([], 'grok-4.5', [], {})).content, 'retried');
    assert.equal(attempts, 2);
});

test('Grok OAuth safe 401 replay carries completed warmup to refreshed xAI inner', async () => {
    const provider = Object.create(GrokOAuthProvider.prototype);
    provider.config = { preconnect: false };
    const warmup = { usage: { inputTokens: 10 } };
    let authCalls = 0;
    provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
        authCalls += 1;
        return { access_token: forceRefresh ? 'fresh' : 'stale' };
    };
    provider._ensureInner = (token) => ({
        _doSend: async (_messages, _model, _tools, opts) => {
            if (token === 'stale') {
                const err = Object.assign(new Error('401'), { httpStatus: 401 });
                Object.defineProperty(err, '__warmup', { value: warmup });
                throw err;
            }
            assert.equal(opts._carriedWarmup, warmup);
            return { content: 'retried' };
        },
    });
    assert.equal((await provider.send([], 'grok-4.5', [], {})).content, 'retried');
    assert.equal(authCalls, 2);
});
