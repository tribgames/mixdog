#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    __cursorModelInternals,
    CursorApiProvider,
    CursorOAuthProvider,
} from '../src/runtime/agent/orchestrator/providers/cursor.mjs';
import {
    exchangeCursorToken,
    generateCursorOAuthParams,
} from '../src/runtime/agent/orchestrator/providers/cursor-auth.mjs';
import { __cursorWireInternals } from '../src/runtime/agent/orchestrator/providers/cursor-wire.mjs';
import { providerDisplayName } from '../src/tui/app/model-options.mjs';
import { fastCapableFor } from '../src/session-runtime/model-capabilities.mjs';
import { providerModelCacheRow } from '../src/session-runtime/model-recency.mjs';
import { retryAfterMsFromError } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { parseScheduleModelRef } from '../src/runtime/shared/schedule-model-ref.mjs';

function sseResponse(events, onCancel = () => {}) {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
        cancel: onCancel,
    }), { headers: { 'content-type': 'text/event-stream' } });
}

test('Cursor account login wraps the browser deep-link contract', () => {
    const params = generateCursorOAuthParams();
    const url = new URL(params.loginUrl);
    assert.equal(url.origin, 'https://cursor.com');
    assert.equal(url.pathname, '/loginDeepControl');
    assert.equal(url.searchParams.get('challenge'), params.challenge);
    assert.equal(url.searchParams.get('uuid'), params.uuid);
    assert.equal(url.searchParams.get('redirectTarget'), 'cli');
    assert.notEqual(params.verifier, params.challenge);
});

test('Cursor OAuth is the user-facing provider identity', () => {
    assert.equal(providerDisplayName('cursor-oauth'), 'Cursor OAuth');
});

test('Cursor token exchange refuses redirects carrying a bearer token', async () => {
    let options = null;
    await exchangeCursorToken('refresh-token', {
        fetchFn: async (_url, next) => {
            options = next;
            return new Response(JSON.stringify({ accessToken: 'access-token' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });
    assert.equal(options.redirect, 'error');
});

test('Cursor catalog folds raw effort, Fast, and duplicate Auto variants', () => {
    const raw = [
        { id: 'auto', name: 'Auto' },
        { id: 'default', name: 'Auto' },
        { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol 1M High' },
        { id: 'gpt-5.6-sol-high-fast', name: 'GPT-5.6 Sol High Fast' },
        { id: 'gpt-5.6-sol-low', name: 'GPT-5.6 Sol 1M Low' },
        { id: 'gpt-5.6-sol-low-fast', name: 'GPT-5.6 Sol Low Fast' },
    ];
    const catalog = __cursorModelInternals.normalizeCursorCatalog(raw, 'cursor-oauth');
    assert.deepEqual(catalog.models.map((model) => model.id), ['auto', 'gpt-5.6-sol']);
    const sol = catalog.models[1];
    assert.deepEqual(sol.reasoningLevels, ['low', 'high']);
    assert.equal(sol.fastCapable, true);
    assert.deepEqual(sol.fastEfforts.sort(), ['high', 'low']);
    assert.equal(
        __cursorModelInternals.selectCursorVariant(catalog.groups.get(sol.id), { effort: 'high', fast: true }).id,
        'gpt-5.6-sol-high-fast',
    );
});

test('Cursor catalog rejects a Fast combination absent from the native catalog', () => {
    const catalog = __cursorModelInternals.normalizeCursorCatalog([
        { id: 'gpt-5.4-low', name: 'GPT-5.4 1M Low' },
        { id: 'gpt-5.4-high', name: 'GPT-5.4 1M High' },
        { id: 'gpt-5.4-high-fast', name: 'GPT-5.4 High Fast' },
    ], 'cursor-oauth');
    assert.throws(
        () => __cursorModelInternals.selectCursorVariant(
            catalog.groups.get('gpt-5.4'),
            { effort: 'low', fast: true },
        ),
        /does not offer low effort in Fast mode/,
    );
    const model = catalog.models[0];
    assert.equal(fastCapableFor('cursor-oauth', model, 'high'), true);
    assert.equal(fastCapableFor('cursor-oauth', model, 'low'), false);
    const cached = providerModelCacheRow('cursor-oauth', model, () => false);
    assert.deepEqual(cached.fastEfforts, ['high']);
});

test('Cursor parameterized catalog preserves model options and sends RequestedModel parameters', async () => {
    const raw = [{
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        contextWindow: 300_000,
        supportsVision: true,
        description: '**Claude Opus 5**<br />Difficult tasks.<br /><br />300k context window',
        parameterDefinitions: [{
            id: 'thinking', name: 'Thinking', kind: 'boolean',
            values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }],
        }, {
            id: 'context', name: 'Context', kind: 'enum',
            values: [{ value: '300k', label: '300K' }, { value: '1m', label: '1M' }],
        }, {
            id: 'effort', name: 'Effort', kind: 'enum',
            values: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
        }, {
            id: 'fast', name: 'Fast', kind: 'boolean',
            values: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }],
        }],
        variants: [{
            parameters: { thinking: 'false', context: '300k', effort: 'high', fast: 'false' },
            default: true,
            legacySlug: 'claude-opus-5-high',
        }, {
            parameters: { thinking: 'true', context: '1m', effort: 'low', fast: 'false' },
        }],
        aliases: ['claude-opus-5-high'],
    }];
    const catalog = __cursorModelInternals.normalizeCursorCatalog(raw, 'cursor-oauth');
    const model = catalog.models.find((entry) => entry.id === 'claude-opus-5');
    assert.equal(catalog.models.length, 2);
    assert.equal(model.supportsVision, true);
    assert.equal(model.description, 'Difficult tasks. · 300k context window');
    assert.deepEqual(model.reasoningLevels, ['low', 'high']);
    assert.deepEqual(model.defaultModelParameters, { thinking: 'false', context: '300k' });
    assert.equal(model.contextWindow, 300_000);
    const selection = __cursorModelInternals.selectParameterizedCursorVariant(
        catalog.parameterGroups.get('claude-opus-5'),
        { baseId: 'claude-opus-5' },
        { effort: 'low', fast: false, modelParameters: { thinking: 'true', context: '1m' } },
    );
    assert.deepEqual(selection, {
        modelId: 'claude-opus-5',
        parameters: [
            { id: 'thinking', value: 'true' },
            { id: 'context', value: '1m' },
            { id: 'effort', value: 'low' },
            { id: 'fast', value: 'false' },
        ],
    });
    const request = __cursorWireInternals.decodeMessage('AgentClientMessage',
        __cursorWireInternals.buildRunRequest({
            model: selection.modelId,
            modelParameters: selection.parameters,
            systems: [],
            history: [],
            userText: 'hello',
            tools: [],
            conversation: { id: 'parameter-test', checkpoint: null, blobs: new Map() },
        }));
    assert.deepEqual(request.runRequest.requestedModel.parameters, selection.parameters);
    assert.equal(request.runRequest.modelDetails, undefined);
    assert.deepEqual(request.runRequest.action.userMessageAction.userMessage.selectedContext, {});

    const bodies = [];
    const provider = new CursorOAuthProvider({
        accessToken: 'cursor-oauth-access',
        runtime: {
            async getCursorModels() { return raw; },
            async handleChatCompletion(body) {
                bodies.push(body);
                return sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
            },
        },
    });
    await provider.send(
        [{ role: 'user', content: 'hello' }],
        'claude-opus-5',
        [],
        { effort: 'low', modelParameters: { thinking: 'true', context: '1m' } },
    );
    assert.deepEqual(bodies[0].mixdog_model_parameters, selection.parameters);
});

test('Cursor developer messages retain system precedence', () => {
    const parsed = __cursorWireInternals.parseMessages([
        { role: 'developer', content: 'developer rule' },
        { role: 'user', content: 'hello' },
    ]);
    assert.deepEqual(parsed.systems, ['developer rule']);
    assert.equal(parsed.history.length, 0);
    assert.equal(parsed.userText, 'hello');
});

test('Cursor request controls preserve exact models, tool choice, and parameter values', async () => {
    assert.deepEqual(__cursorModelInternals.toCursorToolChoice({ name: 'read' }), {
        type: 'function',
        function: { name: 'read' },
    });
    const tools = [
        { function: { name: 'read' } },
        { function: { name: 'grep' } },
    ];
    assert.deepEqual(__cursorWireInternals.selectToolsForChoice(tools, 'none'), []);
    assert.deepEqual(
        __cursorWireInternals.selectToolsForChoice(tools, { type: 'function', function: { name: 'grep' } }),
        [tools[1]],
    );
    assert.deepEqual(__cursorWireInternals.requestModelParameters({
        mixdog_model_parameters: [{ id: 'effort', value: 'high' }, { id: '', value: 'ignored' }],
    }), [{ id: 'effort', value: 'high' }]);

    let body = null;
    const provider = new CursorOAuthProvider({
        accessToken: 'cursor-oauth-access',
        runtime: {
            async getCursorModels() {
                return [
                    { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol High' },
                    { id: 'gpt-5.6-sol-low', name: 'GPT-5.6 Sol Low' },
                ];
            },
            async handleChatCompletion(nextBody) {
                body = nextBody;
                return sseResponse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
            },
        },
    });
    await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gpt-5.6-sol-high',
        [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
        { toolChoice: 'none' },
    );
    assert.equal(body.model, 'gpt-5.6-sol-high');
    assert.equal(body.tool_choice, 'none');
});

test('Cursor route parameters survive automation refs and constrain Fast', () => {
    assert.deepEqual(
        parseScheduleModelRef('cursor-oauth/claude-opus-5@high+fast?thinking=false&context=300k'),
        {
            provider: 'cursor-oauth',
            model: 'claude-opus-5',
            effort: 'high',
            fast: true,
            modelParameters: { thinking: 'false', context: '300k' },
        },
    );
    const model = {
        fastCapable: true,
        parameterVariants: [{
            effort: 'high', fast: 'true', thinking: 'false', context: '300k',
        }, {
            effort: 'high', fast: 'false', thinking: 'false', context: '1m',
        }],
    };
    assert.equal(fastCapableFor('cursor-oauth', model, 'high', { thinking: 'false', context: '300k' }), true);
    assert.equal(fastCapableFor('cursor-oauth', model, 'high', { thinking: 'false', context: '1m' }), false);
});

test('Cursor account usage converts dashboard cents into Mixdog quota windows', () => {
    const snapshot = __cursorWireInternals.normalizeCursorUsage({
        billingCycleStart: 1_786_731_503_000,
        billingCycleEnd: 1_789_409_903_000,
        enabled: true,
        displayMessage: '25% used',
        planUsage: {
            totalSpend: 10_000,
            remaining: 30_000,
            limit: 40_000,
            autoPercentUsed: 20,
            apiPercentUsed: 25,
        },
    }, {
        planInfo: {
            planName: 'Ultra',
            includedAmountCents: 40_000,
            price: '$200/mo',
            billingCycleEnd: 1_789_409_903_000,
        },
    });
    assert.deepEqual(snapshot.balance, {
        source: 'cursor-dashboard',
        remainingUsd: 300,
        usedUsd: 100,
        limitUsd: 400,
    });
    assert.deepEqual(snapshot.quotaWindows, [{
        label: 'Basic',
        source: 'cursor-dashboard',
        usedPct: 20,
        resetAt: 1_789_409_903_000,
    }, {
        label: 'API',
        source: 'cursor-dashboard',
        usedPct: 25,
        resetAt: 1_789_409_903_000,
    }]);
    assert.deepEqual(snapshot.plan, {
        name: 'Ultra',
        price: '$200/mo',
        includedUsd: 400,
        resetAt: 1_789_409_903_000,
    });
});

test('Cursor account usage preserves dashboard percentage points', () => {
    const snapshot = __cursorWireInternals.normalizeCursorUsage({
        planUsage: {
            totalSpend: 76,
            remaining: 39_924,
            limit: 40_000,
            autoPercentUsed: 0.0085,
            apiPercentUsed: 0.118,
        },
    });
    assert.deepEqual(snapshot.quotaWindows.map((window) => [window.label, window.usedPct]), [
        ['Basic', 0.0085],
        ['API', 0.118],
    ]);
});

test('Cursor API exchanges its key and streams text through the provider contract', async () => {
    let receivedBody = null;
    let receivedToken = null;
    const runtime = {
        async handleChatCompletion(body, token) {
            receivedBody = body;
            receivedToken = token;
            return sseResponse([
                { id: 'cursor-1', model: body.model, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
                { id: 'cursor-1', model: body.model, choices: [{ delta: { content: 'hello' }, finish_reason: null }] },
                { id: 'cursor-1', model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
            ]);
        },
        async getCursorModels() { return []; },
    };
    const provider = new CursorApiProvider({
        apiKey: 'cursor-api-key',
        exchangeFn: async () => ({ access_token: 'cursor-access', expires_at: Date.now() + 60_000 }),
        runtime,
    });
    const deltas = [];
    const result = await provider.send(
        [{ role: 'user', content: 'hi' }],
        'composer-1.5',
        [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
        { onTextDelta: (text) => deltas.push(text) },
    );
    assert.equal(receivedToken, 'cursor-access');
    assert.equal(receivedBody.tools[0].function.name, 'read');
    assert.equal(result.content, 'hello');
    assert.deepEqual(deltas, ['hello']);
    assert.equal(result.usage.inputTokens, 7);
});

test('Cursor preserves paired tool history, error state, media, and isolated fallback scope', async () => {
    const internal = [{
        role: 'user',
        content: 'inspect',
    }, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-image', name: 'inspect_image', arguments: { path: 'a.png' } }],
    }, {
        role: 'tool',
        toolCallId: 'call-image',
        toolKind: 'error',
        content: [
            { type: 'text', text: '' },
            { type: 'image', data: 'AQID', mimeType: 'image/png' },
        ],
    }, {
        role: 'user',
        content: [
            { type: 'text', text: 'continue' },
            { type: 'image', data: 'BAUG', mimeType: 'image/png' },
        ],
    }];
    const wireMessages = __cursorModelInternals.toCursorMessages(internal, 'cursor-oauth');
    const parsed = __cursorWireInternals.parseMessages(wireMessages);
    assert.deepEqual(parsed.history[1].content[0], {
        type: 'tool-call',
        toolCallId: 'call-image',
        toolName: 'inspect_image',
        args: { path: 'a.png' },
    });
    assert.equal(parsed.history[2].content[0].isError, true);
    assert.equal(parsed.toolResults[0].isError, true);
    assert.equal(parsed.toolResults[0].media[0].mimeType, 'image/png');
    assert.equal(parsed.userText, 'continue');
    assert.equal(parsed.userImages[0].mimeType, 'image/png');
    const request = __cursorWireInternals.decodeMessage(
        'AgentClientMessage',
        __cursorWireInternals.buildRunRequest({
            model: 'auto',
            systems: [],
            history: parsed.history,
            userText: parsed.userText,
            userImages: parsed.userImages,
            tools: [],
            conversation: { id: 'image-conversation', checkpoint: null, blobs: new Map() },
        }),
    );
    assert.deepEqual(
        [...request.runRequest.action.userMessageAction.userMessage.selectedContext.selectedImages[0].data],
        [4, 5, 6],
    );

    const writes = [];
    const pending = {
        exec: { id: 77, execId: 'exec-media' },
        toolCallId: 'call-image',
        toolName: 'inspect_image',
    };
    __cursorWireInternals.sendToolResult({ write(bytes) { writes.push(bytes); } }, pending, {
        content: '',
        media: [{ mimeType: 'image/png', data: Uint8Array.from([1, 2, 3]) }],
    }, true);
    const frames = [];
    __cursorWireInternals.createFrameParser((bytes) => frames.push(bytes), () => {})(writes[0]);
    const mediaResult = __cursorWireInternals.decodeMessage('AgentClientMessage', frames[0]);
    const imageContent = mediaResult.execClientMessage.mcpResult.success.content.find((entry) => entry.image);
    assert.deepEqual(
        [...imageContent.image.data],
        [1, 2, 3],
    );
    writes.length = 0;
    __cursorWireInternals.sendToolResult({ write(bytes) { writes.push(bytes); } }, pending, {
        content: '',
        media: [],
        isError: true,
    }, false);
    frames.length = 0;
    __cursorWireInternals.createFrameParser((bytes) => frames.push(bytes), () => {})(writes[0]);
    const errorResult = __cursorWireInternals.decodeMessage('AgentClientMessage', frames[0]);
    assert.ok(errorResult.execClientMessage.mcpResult.error);

    const bodies = [];
    const provider = new CursorOAuthProvider({
        accessToken: 'token',
        runtime: {
            async getCursorModels() { return []; },
            async handleChatCompletion(body) {
                bodies.push(body);
                return sseResponse([
                    { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
                    { choices: [{ delta: {}, finish_reason: 'stop' }] },
                ]);
            },
        },
    });
    await provider.send([{ role: 'user', content: 'same' }], 'auto', [], {});
    await provider.send([{ role: 'user', content: 'same' }], 'auto', [], {});
    assert.notEqual(bodies[0].mixdog_session_id, bodies[1].mixdog_session_id);
});

test('Cursor account provider surfaces native tool calls to the Mixdog harness', async () => {
    const runtime = {
        async handleChatCompletion() {
            return sseResponse([
                {
                    id: 'cursor-tool',
                    model: 'composer-1.5',
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: 'call_cursor_1',
                                type: 'function',
                                function: { name: 'read', arguments: '{"file_path":"README.md"}' },
                            }],
                        },
                        finish_reason: null,
                    }],
                },
                { id: 'cursor-tool', model: 'composer-1.5', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]);
        },
        async getCursorModels() {
            return [{ id: 'composer-1.5', name: 'Composer 1.5', reasoning: true, contextWindow: 200000, maxTokens: 64000 }];
        },
    };
    const provider = new CursorOAuthProvider({ accessToken: 'cursor-oauth-access', runtime });
    const result = await provider.send(
        [{ role: 'user', content: 'read it' }],
        'composer-1.5',
        [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }],
        {},
    );
    assert.deepEqual(result.toolCalls, [{
        id: 'call_cursor_1',
        name: 'read',
        arguments: { file_path: 'README.md' },
    }]);
    const models = await provider.listModels();
    assert.equal(models[0].provider, 'cursor-oauth');
    assert.equal(models[0].contextWindow, 200000);
});

test('Cursor stream cancellation reaches the wire response body', async () => {
    let cancelled = false;
    const runtime = {
        async handleChatCompletion() {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
                },
                cancel() { cancelled = true; },
            }));
        },
        async getCursorModels() { return []; },
    };
    const provider = new CursorOAuthProvider({ accessToken: 'cursor-oauth-access', runtime });
    const controller = new AbortController();
    const pending = provider.send([{ role: 'user', content: 'wait' }], 'auto', [], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancel fixture')), 5);
    await assert.rejects(pending, /cancel fixture/);
    assert.equal(cancelled, true);
});

test('Cursor retries a rejected credential once but never after visible output', async () => {
    const authCalls = [];
    let attempts = 0;
    const provider = new CursorOAuthProvider({
        runtime: {
            async getCursorModels() { return []; },
            async handleChatCompletion() {
                attempts += 1;
                if (attempts === 1) {
                    return new Response(new ReadableStream({
                        start(controller) {
                            controller.error(Object.assign(new Error('expired'), { httpStatus: 401 }));
                        },
                    }));
                }
                return sseResponse([
                    { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
                    { choices: [{ delta: {}, finish_reason: 'stop' }] },
                ]);
            },
        },
    });
    provider._accessToken = async ({ forceRefresh = false } = {}) => {
        authCalls.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'stale-token';
    };
    assert.equal((await provider.send([{ role: 'user', content: 'hi' }], 'auto', [], {})).content, 'ok');
    assert.deepEqual(authCalls, [false, true]);
    assert.equal(attempts, 2);

    authCalls.length = 0;
    attempts = 0;
    provider._accessToken = async ({ forceRefresh = false } = {}) => {
        authCalls.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'stale-token';
    };
    provider.config.runtime.handleChatCompletion = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"visible"},"finish_reason":null}]}\n\n'));
            setTimeout(() => {
                controller.error(Object.assign(new Error('expired after output'), { httpStatus: 401 }));
            }, 0);
        },
    }));
    await assert.rejects(
        provider.send([{ role: 'user', content: 'hi' }], 'auto', [], {}),
        (error) => error.httpStatus === 401 && error.unsafeToRetry === true,
    );
    assert.deepEqual(authCalls, [false]);

    authCalls.length = 0;
    provider.config.runtime.handleChatCompletion = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"visible reasoning"},"finish_reason":null}]}\n\n'));
            setTimeout(() => {
                controller.error(Object.assign(new Error('expired after reasoning'), { httpStatus: 403 }));
            }, 0);
        },
    }));
    await assert.rejects(
        provider.send([{ role: 'user', content: 'hi' }], 'auto', [], {}),
        (error) => error.httpStatus === 403 && error.unsafeToRetry === true,
    );
    assert.deepEqual(authCalls, [false]);
});

test('Cursor refreshes a stale catalog only when not_found changes the routed model id', async () => {
    let catalogReads = 0;
    const sentModels = [];
    const runtime = {
        clearModelCache() {},
        async getCursorModels() {
            catalogReads += 1;
            return catalogReads === 1
                ? [{ id: 'gpt-5.4-mini-low', name: 'GPT-5.4 Mini Low' }]
                : [{ id: 'gpt-5.4-mini-medium', name: 'GPT-5.4 Mini Medium' }];
        },
        async handleChatCompletion(body) {
            sentModels.push(body.model);
            if (body.model.endsWith('-low')) {
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.error(Object.assign(new Error('missing model'), { httpStatus: 404 }));
                    },
                }));
            }
            return sseResponse([
                { choices: [{ delta: { content: 'fresh' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
            ]);
        },
    };
    const provider = new CursorOAuthProvider({ accessToken: 'token', runtime });
    assert.equal((await provider.send(
        [{ role: 'user', content: 'hi' }],
        'gpt-5.4-mini',
        [],
        {},
    )).content, 'fresh');
    assert.deepEqual(sentModels, ['gpt-5.4-mini-low', 'gpt-5.4-mini-medium']);
    assert.equal(catalogReads, 2);

    let unchangedAttempts = 0;
    const unchanged = new CursorOAuthProvider({
        accessToken: 'token',
        runtime: {
            clearModelCache() {},
            async getCursorModels() {
                return [{ id: 'gpt-5.4-mini-low', name: 'GPT-5.4 Mini Low' }];
            },
            async handleChatCompletion() {
                unchangedAttempts += 1;
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.error(Object.assign(new Error('still missing'), { httpStatus: 404 }));
                    },
                }));
            },
        },
    });
    await assert.rejects(
        unchanged.send([{ role: 'user', content: 'hi' }], 'gpt-5.4-mini', [], {}),
        (error) => error.httpStatus === 404,
    );
    assert.equal(unchangedAttempts, 1);
});

test('Cursor preserves rate-limit evidence without replaying the turn', async () => {
    let attempts = 0;
    const provider = new CursorOAuthProvider({
        runtime: {
            async getCursorModels() { return []; },
            async handleChatCompletion() {
                attempts += 1;
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.error(Object.assign(new Error('limited'), {
                            httpStatus: 429,
                            status: 429,
                            retryAfter: '7',
                            headers: { 'retry-after': '7' },
                            response: { status: 429, headers: { 'retry-after': '7' } },
                        }));
                    },
                }));
            },
        },
    });
    let authCalls = 0;
    provider._accessToken = async () => {
        authCalls += 1;
        return 'token';
    };
    await assert.rejects(
        provider.send([{ role: 'user', content: 'hi' }], 'auto', [], {}),
        (error) => error.httpStatus === 429
            && error.retryAfter === '7'
            && retryAfterMsFromError(error) === 7_000,
    );
    assert.equal(attempts, 1);
    assert.equal(authCalls, 1);
});

test('Cursor wire codec round-trips the Mixdog-facing protocol subset', () => {
    const original = {
        execServerMessage: {
            id: 17,
            execId: 'exec-17',
            mcpArgs: {
                name: 'read',
                toolName: 'read',
                toolCallId: 'call-17',
                args: {
                    file_path: __cursorWireInternals.encodeJsonValue('README.md'),
                    limit: __cursorWireInternals.encodeJsonValue(25),
                },
            },
        },
    };
    const encoded = __cursorWireInternals.encodeMessage('AgentServerMessage', original);
    const decoded = __cursorWireInternals.decodeMessage('AgentServerMessage', encoded);
    assert.equal(decoded.execServerMessage.id, 17);
    assert.equal(decoded.execServerMessage.mcpArgs.toolCallId, 'call-17');
    assert.equal(
        __cursorWireInternals.decodeJsonValue(decoded.execServerMessage.mcpArgs.args.file_path),
        'README.md',
    );
    assert.equal(
        __cursorWireInternals.decodeJsonValue(decoded.execServerMessage.mcpArgs.args.limit),
        25,
    );
    const schemaDefaults = {
        additionalProperties: false,
        minimum: 0,
        default: null,
    };
    assert.deepEqual(
        __cursorWireInternals.decodeJsonValue(__cursorWireInternals.encodeJsonValue(schemaDefaults)),
        schemaDefaults,
    );
    assert.deepEqual(
        __cursorWireInternals.decodeMessage('AgentServerMessage', Buffer.from('0a026a00', 'hex')),
        { interactionUpdate: {} },
    );
    const samePrompt = [{ role: 'user', content: 'hello' }];
    assert.notEqual(
        __cursorWireInternals.conversationKey(samePrompt, 'session-a'),
        __cursorWireInternals.conversationKey(samePrompt, 'session-b'),
    );
    const checkpoint = Buffer.concat([
        Buffer.from([0x0a, 0x03, 0x6f, 0x6c, 0x64]),
        Buffer.from([0x98, 0x06, 0x07]),
        Buffer.from([0x42, 0x01, 0x78]),
    ]);
    const rewritten = __cursorWireInternals.rewriteConversationState(
        checkpoint,
        [new TextEncoder().encode('new')],
    );
    const rewrittenDecoded = __cursorWireInternals.decodeMessage('ConversationStateStructure', rewritten);
    assert.deepEqual([...rewrittenDecoded.rootPromptMessagesJson[0]], [...new TextEncoder().encode('new')]);
    assert.deepEqual(rewrittenDecoded.turns || [], []);
    assert.equal(Buffer.from(rewritten).includes(Buffer.from([0x98, 0x06, 0x07])), true);
});

test('Cursor request context exposes tools without duplicating root prompt instructions', () => {
    const writes = [];
    const tools = [{
        name: 'read',
        inputSchemaObject: { type: 'object', properties: { file_path: { type: 'string' } } },
    }];
    __cursorWireInternals.handleExecMessage({
        write(bytes) { writes.push(bytes); },
    }, {
        id: 18,
        execId: 'exec-context',
        requestContextArgs: {},
    }, tools, 'mixdog rule', () => {});
    const frames = [];
    __cursorWireInternals.createFrameParser((bytes) => frames.push(bytes), () => {})(writes[0]);
    const result = __cursorWireInternals.decodeMessage('AgentClientMessage', frames[0]);
    const context = result.execClientMessage.requestContextResult.success.requestContext;
    assert.equal(context.tools.length, 1);
    assert.equal(context.tools[0].name, 'read');
    // The Mixdog system prompt must reach Cursor's rules channel; an empty
    // cloudRule leaves the server-side agent governed only by its own harness.
    assert.equal(context.cloudRule, 'mixdog rule');
    assert.equal(context.mcpInstructions, undefined);
});

test('Cursor Connect parser handles split frames without losing protobuf bytes', () => {
    const payload = __cursorWireInternals.encodeMessage('AgentServerMessage', {
        interactionUpdate: { textDelta: { text: 'hello' }, tokenDelta: { tokens: 3 } },
    });
    const frame = __cursorWireInternals.connectFrame(payload);
    const received = [];
    const parser = __cursorWireInternals.createFrameParser((bytes) => received.push(bytes), () => {});
    parser(frame.subarray(0, 4));
    parser(frame.subarray(4, 9));
    parser(frame.subarray(9));
    assert.equal(received.length, 1);
    const decoded = __cursorWireInternals.decodeMessage('AgentServerMessage', received[0]);
    assert.equal(decoded.interactionUpdate.textDelta.text, 'hello');
    assert.equal(decoded.interactionUpdate.tokenDelta.tokens, 3);
    const truncated = __cursorWireInternals.createFrameParser(() => {}, () => {});
    truncated(frame.subarray(0, 4));
    assert.throws(() => truncated.finish(), /truncated frame/);
    assert.throws(
        () => __cursorWireInternals.createFrameParser(() => {}, () => {})(Buffer.from([1, 0, 0, 0, 0])),
        /unsupported compressed frame/,
    );
    assert.throws(
        () => __cursorWireInternals.createFrameParser(() => {}, () => {})(Buffer.from([4, 0, 0, 0, 0])),
        /unsupported frame flags/,
    );
    assert.throws(
        () => __cursorWireInternals.createFrameParser(() => {}, () => {})(Buffer.from([0, 4, 0, 0, 1])),
        /exceeds 67108864 bytes/,
    );
});

test('Cursor rejects unregistered tools and deduplicates repeated tool ids', async () => {
    const writes = [];
    let dispatched = 0;
    __cursorWireInternals.handleExecMessage({
        write(bytes) { writes.push(bytes); },
    }, {
        id: 9,
        execId: 'exec-missing',
        mcpArgs: {
            name: 'unknown_tool',
            toolName: 'unknown_tool',
            toolCallId: 'call-missing',
            args: {},
        },
    }, [], undefined, () => { dispatched += 1; });
    assert.equal(dispatched, 0);
    const writtenFrames = [];
    __cursorWireInternals.createFrameParser((bytes) => writtenFrames.push(bytes), () => {})(writes[0]);
    const rejection = __cursorWireInternals.decodeMessage('AgentClientMessage', writtenFrames[0]);
    assert.match(rejection.execClientMessage.mcpResult.error.error, /Tool not available/);
    let malformed = null;
    __cursorWireInternals.handleExecMessage({ write() {} }, {
        id: 11,
        execId: 'exec-malformed',
        mcpArgs: {
            name: 'echo_value',
            toolName: 'echo_value',
            toolCallId: 'call-malformed',
            args: { value: Uint8Array.from([0x80]) },
        },
    }, [{ name: 'echo_value' }], undefined, (pending) => { malformed = pending; });
    assert.equal(malformed.toolName, 'echo_value');
    assert.doesNotThrow(() => JSON.parse(malformed.decodedArgs));

    let dataHandler = null;
    let closeHandler = null;
    const bridge = {
        alive: true,
        writes: [],
        onData(handler) { dataHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        write(bytes) { this.writes.push(bytes); },
        close(error = null) {
            if (!this.alive) return;
            this.alive = false;
            closeHandler?.(error);
        },
        emit(bytes) { dataHandler?.(bytes); },
    };
    const key = __cursorWireInternals.runKey(
        'composer-2.5',
        [{ role: 'user', content: 'tool test' }],
        'tool-session',
    );
    const response = __cursorWireInternals.createStreamResponse({
        bridge,
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [{
            name: 'echo_value',
            inputSchemaObject: { type: 'object', properties: { value: { type: 'string' } } },
        }],
        cloudRule: undefined,
        model: 'composer-2.5',
        key,
    });
    const toolMessage = __cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            execServerMessage: {
                id: 10,
                execId: 'exec-echo',
                mcpArgs: {
                    name: 'echo_value',
                    toolName: 'echo_value',
                    toolCallId: 'call-echo',
                    args: { value: __cursorWireInternals.encodeJsonValue('ok') },
                },
            },
        }),
    );
    for (const interactionUpdate of [{
        toolCallStarted: {
            callId: 'call-echo',
            modelCallId: 'model-call-1',
            toolCall: {
                mcpToolCall: {
                    args: {
                        name: 'echo_value',
                        toolName: 'echo_value',
                        toolCallId: 'call-echo',
                        args: { value: __cursorWireInternals.encodeJsonValue('ok') },
                    },
                },
            },
        },
    }, {
        partialToolCall: {
            callId: 'call-echo',
            modelCallId: 'model-call-1',
            argsTextDelta: '{"value":"ok"}',
        },
    }, {
        toolCallCompleted: {
            callId: 'call-echo',
            modelCallId: 'model-call-1',
            toolCall: {
                mcpToolCall: {
                    args: {
                        name: 'echo_value',
                        toolName: 'echo_value',
                        toolCallId: 'call-echo',
                        args: { value: __cursorWireInternals.encodeJsonValue('ok') },
                    },
                },
            },
        },
    }]) {
        bridge.emit(__cursorWireInternals.connectFrame(
            __cursorWireInternals.encodeMessage('AgentServerMessage', { interactionUpdate }),
        ));
    }
    bridge.emit(toolMessage);
    bridge.emit(toolMessage);
    bridge.emit(__cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            execServerMessage: {
                id: 11,
                execId: 'exec-second',
                mcpArgs: {
                    name: 'echo_value',
                    toolName: 'echo_value',
                    toolCallId: 'call-second',
                    args: { value: __cursorWireInternals.encodeJsonValue('second') },
                },
            },
        }),
    ));
    const batchBoundary = __cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            interactionUpdate: { stepCompleted: {} },
        }),
    );
    const trailingFrame = __cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            interactionUpdate: { tokenDelta: { tokens: 1 } },
        }),
    );
    bridge.emit(Buffer.concat([batchBoundary, trailingFrame.subarray(0, 4)]));
    bridge.emit(trailingFrame.subarray(4));
    const text = await response.text();
    assert.equal((text.match(/call-echo/g) || []).length, 1);
    assert.equal((text.match(/call-second/g) || []).length, 1);
    assert.equal(__cursorWireInternals.activeRunPendingCount(key), 2);
    bridge.close();
    assert.equal(__cursorWireInternals.activeRunPendingCount(key), 0);

    const missingWrites = [];
    let missingData = null;
    let missingClose = null;
    const missingBridge = {
        alive: true,
        write(bytes) { missingWrites.push(bytes); },
        onData(handler) { missingData = handler; },
        onClose(handler) { missingClose = handler; },
        close(error = null) {
            if (!this.alive) return;
            this.alive = false;
            missingClose?.(error);
        },
    };
    const partialActive = {
        bridge: missingBridge,
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [],
        cloudRule: undefined,
        pending: [
            {
                exec: { id: 12, execId: 'exec-done' },
                toolCallId: 'call-done',
                toolName: 'echo_value',
                decodedArgs: '{}',
            },
            {
                exec: { id: 13, execId: 'exec-no-result' },
                toolCallId: 'call-no-result',
                toolName: 'echo_value',
                decodedArgs: '{}',
            },
        ],
    };
    const missingResponse = __cursorWireInternals.resumeRun(
        partialActive,
        [{ toolCallId: 'call-done', content: 'done', media: [], isError: false }],
        '',
        'composer-2.5',
        'missing-result-key',
    );
    const missingFrames = [];
    __cursorWireInternals.createFrameParser((bytes) => missingFrames.push(bytes), () => {})(missingWrites[0]);
    const firstResult = __cursorWireInternals.decodeMessage('AgentClientMessage', missingFrames[0]);
    assert.ok(firstResult.execClientMessage.mcpResult.success);
    const replayText = await missingResponse.text();
    assert.match(replayText, /call-no-result/);
    assert.equal(partialActive.pending.length, 1);
    assert.equal(missingWrites.length, 1);

    const finalResponse = __cursorWireInternals.resumeRun(
        partialActive,
        [{ toolCallId: 'call-no-result', content: 'recovered', media: [], isError: false }],
        '',
        'composer-2.5',
        'missing-result-key',
    );
    const finalFrames = [];
    __cursorWireInternals.createFrameParser((bytes) => finalFrames.push(bytes), () => {})(missingWrites[1]);
    const finalResult = __cursorWireInternals.decodeMessage('AgentClientMessage', finalFrames[0]);
    assert.ok(finalResult.execClientMessage.mcpResult.success);
    missingData(__cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            interactionUpdate: { turnEnded: {} },
        }),
    ));
    missingData(__cursorWireInternals.connectFrame(new TextEncoder().encode('{}'), 2));
    await finalResponse.text();
});

test('Cursor native shell redirects omit unsupported workingDirectory', () => {
    const tools = [{
        name: 'shell',
        inputSchemaObject: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                timeout_ms: { type: 'number' },
            },
        },
    }];
    for (const [caseName, resultType] of [
        ['shellArgs', 'shellResult'],
        ['shellStreamArgs', 'shellStreamResult'],
    ]) {
        let pending = null;
        __cursorWireInternals.handleExecMessage({ write() {} }, {
            id: caseName === 'shellArgs' ? 21 : 22,
            execId: `exec-${caseName}`,
            [caseName]: {
                command: 'npm test',
                workingDirectory: 'C:\\Project\\mixdog\\apps\\desktop',
                timeout: 30_000,
                toolCallId: `call-${caseName}`,
            },
        }, tools, undefined, (value) => { pending = value; });
        assert.ok(pending);
        assert.equal(pending.native.resultType, resultType);
        assert.deepEqual(JSON.parse(pending.decodedArgs), {
            command: 'npm test',
            timeout_ms: 30_000,
        });
    }
});

test('Cursor clean end-stream flushes pending tool calls as a recoverable batch', async () => {
    let dataHandler = null;
    let closeHandler = null;
    const bridge = {
        alive: true,
        onData(handler) { dataHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        write() {},
        close(error = null) {
            if (!this.alive) return;
            this.alive = false;
            closeHandler?.(error);
        },
        emit(bytes) { dataHandler?.(bytes); },
    };
    const key = 'end-stream-pending-fixture';
    const response = __cursorWireInternals.createStreamResponse({
        bridge,
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [{ name: 'echo_value', inputSchemaObject: { type: 'object' } }],
        cloudRule: undefined,
        model: 'composer-2.5',
        key,
    });
    bridge.emit(__cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            execServerMessage: {
                id: 14,
                execId: 'exec-end-stream',
                mcpArgs: {
                    name: 'echo_value',
                    toolName: 'echo_value',
                    toolCallId: 'call-end-stream',
                    args: {},
                },
            },
        }),
    ));
    bridge.emit(__cursorWireInternals.connectFrame(new TextEncoder().encode('{}'), 2));
    const text = await response.text();
    assert.match(text, /call-end-stream/);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.equal(__cursorWireInternals.activeRunPendingCount(key), 1);
    bridge.close();
    assert.equal(__cursorWireInternals.activeRunPendingCount(key), 0);
});

test('Cursor clean end-stream closes both SSE and its transport', async () => {
    let dataHandler = null;
    let closeHandler = null;
    let closeCount = 0;
    const bridge = {
        alive: true,
        onData(handler) { dataHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        write() {},
        close(error = null) {
            if (!this.alive) return;
            this.alive = false;
            closeCount += 1;
            closeHandler?.(error);
        },
        emit(bytes) { dataHandler?.(bytes); },
    };
    const heartbeat = setInterval(() => {}, 10_000);
    heartbeat.unref?.();
    const response = __cursorWireInternals.createStreamResponse({
        bridge,
        heartbeat,
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [],
        cloudRule: undefined,
        model: 'composer-1.5',
        key: 'clean-end-fixture',
    });
    bridge.emit(__cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            interactionUpdate: { textDelta: { text: 'hello' } },
        }),
    ));
    bridge.emit(__cursorWireInternals.connectFrame(
        __cursorWireInternals.encodeMessage('AgentServerMessage', {
            interactionUpdate: { turnEnded: {} },
        }),
    ));
    bridge.emit(__cursorWireInternals.connectFrame(new TextEncoder().encode('{}'), 2));
    const text = await response.text();
    assert.match(text, /"content":"hello"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(closeCount, 1);
    assert.equal(bridge.alive, false);
});

test('Cursor stream rejects protocol errors instead of rendering them as assistant text', async () => {
    let dataHandler = null;
    let closeHandler = null;
    const bridge = {
        alive: true,
        onData(handler) { dataHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        write() {},
        close(error = null) {
            if (!this.alive) return;
            this.alive = false;
            closeHandler?.(error);
        },
        emit(bytes) { dataHandler?.(bytes); },
        end() {
            if (!this.alive) return;
            this.alive = false;
            closeHandler?.(null);
        },
    };
    const response = __cursorWireInternals.createStreamResponse({
        bridge,
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [],
        cloudRule: undefined,
        model: 'auto',
        key: 'error-fixture',
    });
    bridge.emit(__cursorWireInternals.connectFrame(
        new TextEncoder().encode(JSON.stringify({ error: { code: 'not_found', message: 'missing' } })),
        2,
    ));
    await assert.rejects(response.text(), (error) => error.httpStatus === 404 && error.code === 'not_found');

    const premature = __cursorWireInternals.createStreamResponse({
        bridge: {
            alive: true,
            onData() {},
            onClose(handler) { queueMicrotask(() => handler(null)); },
            write() {},
            close() {},
        },
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [],
        cloudRule: undefined,
        model: 'auto',
        key: 'premature-fixture',
    });
    await assert.rejects(premature.text(), /closed before its end frame/);
    const limited = __cursorWireInternals.parseEndStream(new TextEncoder().encode(JSON.stringify({
        error: { code: 'resource_exhausted', message: 'slow down' },
        metadata: { 'retry-after': '2' },
    })));
    assert.equal(limited.httpStatus, 429);
    assert.equal(retryAfterMsFromError(limited), 2_000);

    let malformedClose = null;
    const malformedEnd = __cursorWireInternals.createStreamResponse({
        bridge: {
            alive: true,
            onData(handler) {
                queueMicrotask(() => handler(__cursorWireInternals.connectFrame(
                    new TextEncoder().encode('{broken'),
                    2,
                )));
            },
            onClose(handler) { malformedClose = handler; },
            write() {},
            close(error = null) {
                if (!this.alive) return;
                this.alive = false;
                malformedClose?.(error);
            },
        },
        heartbeat: setInterval(() => {}, 10_000),
        conversation: { blobs: new Map(), checkpoint: null },
        tools: [],
        cloudRule: undefined,
        model: 'auto',
        key: 'malformed-end-fixture',
    });
    await assert.rejects(malformedEnd.text(), /invalid end-stream frame/);
});
