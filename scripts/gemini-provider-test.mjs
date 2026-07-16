#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    convertSchema,
    normalizeGeminiParts,
    parseGeminiThinkingParts,
    parseGeminiTextPartMetadata,
    parseToolCalls,
    toGeminiContents,
} from '../src/runtime/agent/orchestrator/providers/gemini-schema.mjs';
import {
    GEMINI_GLOBAL_CACHE_MIN_LIVE_MS,
    _geminiCachePrefixHash,
    _geminiCredentialFingerprint,
    _geminiGlobalCacheKey,
    _invalidateGeminiCachesForCredentialFingerprint,
    _getGeminiGlobalCache,
    _setGeminiGlobalCache,
    geminiGlobalCaches,
} from '../src/runtime/agent/orchestrator/providers/gemini-cache.mjs';
import {
    aggregateGeminiStreamChunks,
    consumeGeminiRestStreamResponse,
    consumeGeminiSdkStream,
    geminiChunkText,
} from '../src/runtime/agent/orchestrator/providers/gemini-stream.mjs';
import {
    GeminiProvider,
    fetchGeminiModelPages,
} from '../src/runtime/agent/orchestrator/providers/gemini.mjs';
import { _toAnthropicMessagesForTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { classifyError } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import {
    enrichModels,
    loadCatalog,
    loadModelsDevCatalog,
} from '../src/runtime/agent/orchestrator/providers/model-catalog.mjs';

const networkDeny = async (url) => {
    throw new Error(`unexpected network: ${url}`);
};
const hermeticConfig = (extra = {}) => ({
    apiKey: 'test-key',
    fetchFn: networkDeny,
    preconnectFn: () => {},
    ...extra,
});

function assertForbiddenSchemaKeywordsAbsent(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
        assert.equal(['oneOf', 'allOf', 'not'].includes(key), false, `forbidden Gemini schema keyword: ${key}`);
        assertForbiddenSchemaKeywordsAbsent(nested);
    }
}

function assertRequiredSubsetOfProperties(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.required)) {
        assert.equal(value.properties && typeof value.properties === 'object', true);
        for (const name of value.required) {
            assert.equal(Object.hasOwn(value.properties, name), true, `missing required property schema: ${name}`);
        }
    }
    for (const nested of Object.values(value)) assertRequiredSubsetOfProperties(nested);
}

function assertSchemaConflict(schema, messagePattern = /could not be represented safely/) {
    assert.equal(schema.type, 'string');
    assert.deepEqual(schema.enum, ['__mixdog_unrepresentable_schema_conjunction__']);
    assert.match(schema.description, messagePattern);
}

function assertNoFileData(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
        assert.notEqual(key, 'fileData');
        assertNoFileData(nested);
    }
}

test('Gemini stream preserves thought metadata but never relays thought text', () => {
    const chunk = {
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'private reasoning', thought: true, thoughtSignature: 'sig-r' },
                    { text: 'visible answer' },
                ],
            },
            finishReason: 'STOP',
        }],
    };
    assert.equal(geminiChunkText(chunk), 'visible answer');
    const aggregated = aggregateGeminiStreamChunks([chunk]);
    assert.deepEqual(aggregated.candidates[0].content.parts[0], {
        text: 'private reasoning',
        thought: true,
        thoughtSignature: 'sig-r',
    });
    assert.deepEqual(parseGeminiThinkingParts(aggregated.candidates[0].content.parts), [{
        type: 'thinking',
        thinking: 'private reasoning',
        signature: 'sig-r',
    }]);
});

test('Gemini function-call thought signatures round-trip at Part level', () => {
    const contents = toGeminiContents([{
        role: 'assistant',
        content: '',
        toolCalls: [{
            id: 'call-1',
            name: 'read',
            arguments: { path: 'a' },
            thoughtSignature: 'opaque',
        }],
    }]);
    assert.deepEqual(contents[0].parts[0], {
        functionCall: { name: 'read', args: { path: 'a' }, id: 'call-1' },
        thoughtSignature: 'opaque',
    });
});

test('Gemini provider-scoped thought parts round-trip before text and function calls', () => {
    const contents = toGeminiContents([{
        role: 'assistant',
        content: 'answer',
        providerMetadata: { gemini: { thoughtParts: [{ text: 'reason', thoughtSignature: 'sig-r' }] } },
        toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'a' }, thoughtSignature: 'sig-f' }],
    }]);
    assert.deepEqual(contents[0].parts, [
        { text: 'reason', thought: true, thoughtSignature: 'sig-r' },
        { text: 'answer' },
        { functionCall: { name: 'read', args: { path: 'a' }, id: 'call-1' }, thoughtSignature: 'sig-f' },
    ]);
});

test('Gemini preserves native call ids and replays the same id in function responses', () => {
    const [call] = parseToolCalls([{ functionCall: { id: 'server/id: EXACT', name: 'read', args: { path: 'a' } } }]);
    assert.equal(call.id, 'server/id: EXACT');
    const contents = toGeminiContents([
        { role: 'assistant', content: '', toolCalls: [call] },
        { role: 'tool', toolCallId: call.id, content: 'ok' },
    ]);
    assert.equal(contents[0].parts[0].functionCall.id, 'server/id: EXACT');
    assert.equal(contents[1].parts[0].functionResponse.id, 'server/id: EXACT');
    assert.equal(contents[1].parts[0].functionResponse.name, 'read');
    const [fallbackA] = parseToolCalls([{ functionCall: { name: 'read', args: { path: 'a' } } }]);
    const [fallbackB] = parseToolCalls([{ functionCall: { name: 'read', args: { path: 'a' } } }]);
    assert.equal(fallbackA.id, fallbackB.id);
});

test('Gemini rejects malformed or unsigned hidden metadata and ignores foreign thinking blocks', () => {
    const message = {
        role: 'assistant',
        content: 'visible',
        thinkingBlocks: [{ type: 'thinking', thinking: 'anthropic secret', signature: 'anthropic-sig' }],
        providerMetadata: {
            gemini: {
                thoughtParts: [
                    { text: 'valid-looking', thoughtSignature: 'gemini-sig' },
                    { text: 'unsigned injection' },
                ],
            },
        },
    };
    assert.deepEqual(toGeminiContents([message])[0].parts, [{ text: 'visible' }]);
    assert.equal(JSON.stringify(_toAnthropicMessagesForTest([message])).includes('valid-looking'), false);
});

test('Gemini ordinary signed text parts survive canonical history and remain provider-scoped', () => {
    const metadata = parseGeminiTextPartMetadata([
        { text: 'hello ', thoughtSignature: 'sig-text-1' },
        { text: 'world' },
    ]);
    const message = { role: 'assistant', content: 'hello world', providerMetadata: metadata };
    assert.deepEqual(toGeminiContents([message])[0].parts, [
        { text: 'hello ', thoughtSignature: 'sig-text-1' },
        { text: 'world' },
    ]);
    const persisted = JSON.parse(JSON.stringify(message));
    assert.deepEqual(toGeminiContents([persisted])[0].parts, [
        { text: 'hello ', thoughtSignature: 'sig-text-1' },
        { text: 'world' },
    ]);
    assert.equal(JSON.stringify(_toAnthropicMessagesForTest([message])).includes('sig-text-1'), false);
});

test('Gemini schema projects nullable unions, const, and invalid required names', () => {
    const schema = convertSchema({
        type: 'object',
        properties: {
            mode: { type: ['string', 'null'], const: 'fast' },
        },
        required: ['mode', 'missing'],
    });
    assert.deepEqual(schema.required, ['mode', 'missing']);
    assert.equal(schema.properties.mode.type, 'string');
    assert.equal(schema.properties.mode.nullable, true);
    assert.deepEqual(schema.properties.mode.enum, ['fast']);
    assert.equal('const' in schema.properties.mode, false);
    assertSchemaConflict(schema.properties.missing, /required property missing has no representable schema/);
    assertRequiredSubsetOfProperties(schema);
});

test('Gemini normalizes nullable arrays and numeric constraints before type-dependent validation', () => {
    const array = convertSchema({ type: ['array', 'null'] });
    assert.equal(array.type, 'array');
    assert.equal(array.nullable, true);
    assert.deepEqual(array.items, { type: 'string' });

    const numeric = convertSchema({
        type: ['integer', 'null'],
        enum: [1, 2],
        minimum: 1,
        maximum: 3,
    });
    assertSchemaConflict(numeric, /does not support integer enum conjunction/);
});

test('Gemini allOf conjunction merges representable constraints without broadening', () => {
    assert.deepEqual(convertSchema({
        allOf: [{ type: 'string', minLength: 2 }, { type: 'string', minLength: 5, maxLength: 9 }],
    }), { type: 'string', minLength: 5, maxLength: 9 });
    assert.deepEqual(convertSchema({
        type: 'number',
        minimum: 0,
        maximum: 100,
        allOf: [{ minimum: 10 }, { maximum: 20 }],
    }), { type: 'number', minimum: 10, maximum: 20 });
    assert.deepEqual(convertSchema({
        type: 'integer',
        allOf: [{ exclusiveMinimum: 2 }, { exclusiveMaximum: 8 }],
    }), { type: 'integer', minimum: 3, maximum: 7 });
    assert.deepEqual(convertSchema({
        type: 'object',
        properties: { nested: { type: 'object', properties: { value: { type: 'string', minLength: 2 } } } },
        allOf: [{
            properties: { nested: { properties: { value: { type: 'string', maxLength: 8 } } } },
        }],
    }).properties.nested.properties.value, {
        type: 'string',
        minLength: 2,
        maxLength: 8,
    });
    assert.deepEqual(convertSchema({
        type: 'string',
        enum: ['a', 'b', 'c'],
        allOf: [{ enum: ['b', 'c', 'd'] }],
    }).enum, ['b', 'c']);
});

test('Gemini allOf conflicts produce an explicit valid safe fallback', () => {
    for (const schema of [
        { allOf: [{ type: 'string' }, { type: 'number' }] },
        { type: 'string', allOf: [{ minLength: 10 }, { maxLength: 2 }] },
        { type: 'string', allOf: [{ enum: ['a'] }, { enum: ['b'] }] },
        { type: 'string', allOf: [{ pattern: '^a' }, { pattern: 'b$' }] },
    ]) {
        const converted = convertSchema(schema);
        assert.equal(converted.type, 'string');
        assert.deepEqual(converted.enum, ['__mixdog_unrepresentable_schema_conjunction__']);
        assert.match(converted.description, /could not be represented safely/);
    }
});

test('Gemini const/enum and nested numeric allOf conflicts never broaden', () => {
    assertSchemaConflict(convertSchema({
        type: 'string',
        const: 'a',
        enum: ['b'],
    }), /empty enum intersection/);
    const nested = convertSchema({
        type: 'object',
        properties: {
            value: {
                type: 'integer',
                allOf: [{ enum: [1] }, { minimum: 0 }],
            },
        },
    });
    assertSchemaConflict(nested.properties.value, /does not support integer enum conjunction/);
});

test('Gemini required-only root and allOf branches retain conservative property schemas', () => {
    const root = convertSchema({ type: 'object', required: ['b', 'b', null, 3] });
    assert.deepEqual(root.required, ['b']);
    assertSchemaConflict(root.properties.b, /required property b has no representable schema/);

    const conjunction = convertSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        allOf: [{ required: ['b'] }],
    });
    assert.deepEqual(conjunction.required, ['a', 'b']);
    assertSchemaConflict(conjunction.properties.b, /required property b has no representable schema/);
    assertRequiredSubsetOfProperties({ root, conjunction });
});

test('Gemini dangerous property names remain own serialized data properties recursively', () => {
    const objectPrototype = Object.getPrototypeOf({});
    const objectPrototypeKeys = Object.getOwnPropertyNames(Object.prototype);
    const schema = convertSchema(JSON.parse(`{
        "type": "object",
        "properties": {
            "__proto__": { "type": "string" },
            "child": {
                "type": "object",
                "required": ["__proto__", "constructor", "prototype"]
            }
        },
        "required": ["__proto__", "prototype"],
        "allOf": [{ "required": ["constructor"] }]
    }`));

    for (const properties of [schema.properties, schema.properties.child.properties]) {
        assert.equal(Object.getPrototypeOf(properties), Object.prototype);
        for (const name of ['__proto__', 'constructor', 'prototype']) {
            assert.equal(Object.hasOwn(properties, name), true, `${name} must be an own schema property`);
            const descriptor = Object.getOwnPropertyDescriptor(properties, name);
            assert.equal(descriptor.enumerable, true);
            assert.equal(descriptor.writable, true);
            assert.equal(descriptor.configurable, true);
        }
    }
    assert.equal(Object.getPrototypeOf({}), objectPrototype);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), objectPrototypeKeys);
    const serialized = JSON.stringify(schema);
    for (const name of ['__proto__', 'constructor', 'prototype']) {
        assert.equal(serialized.includes(`"${name}"`), true);
        assert.equal(Object.hasOwn(JSON.parse(serialized).properties, name), true);
    }
    assertRequiredSubsetOfProperties(schema);
});

test('Gemini compound schemas use only supported anyOf and preserve root fields', () => {
    const properties = {
        pattern: { type: 'string' },
        path: { type: 'string' },
        options: {
            type: 'object',
            properties: { hidden: { type: 'boolean' } },
            not: { required: ['hidden'] },
        },
    };
    const schema = convertSchema({
        type: 'object',
        properties,
        required: ['options'],
        oneOf: [{ required: ['pattern'] }, { required: ['path'] }],
        allOf: [{ properties: { limit: { type: 'integer' } }, required: ['limit'] }],
    });
    assert.deepEqual(Object.keys(schema.properties).sort(), ['limit', 'options', 'path', 'pattern']);
    assert.deepEqual(schema.required.sort(), ['limit', 'options']);
    assert.equal(Array.isArray(schema.anyOf), true);
    assert.deepEqual(schema.anyOf.map((branch) => branch.required), [['pattern'], ['path']]);
    assertForbiddenSchemaKeywordsAbsent(schema);
    assertRequiredSubsetOfProperties(schema);
});

test('Gemini schema projection drops unknown JSON Schema and extension keywords recursively', () => {
    const schema = convertSchema({
        type: 'object',
        additionalProperties: false,
        unevaluatedProperties: false,
        'x-custom': true,
        properties: {
            value: {
                type: 'string',
                description: 'kept',
                examples: ['drop'],
                contentEncoding: 'base64',
            },
        },
        required: ['value'],
    });
    assert.deepEqual(schema, {
        type: 'object',
        properties: { value: { type: 'string', description: 'kept' } },
        required: ['value'],
    });
});

test('Gemini function-response media is nested, referenced, and MIME-safe', () => {
    assert.deepEqual(normalizeGeminiParts([
        { inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } },
        { fileData: { mimeType: 'video/mp4', fileUri: 'https://files.example/video' } },
    ]), [
        { inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } },
        { fileData: { mimeType: 'video/mp4', fileUri: 'https://files.example/video' } },
    ]);
    const tool = toGeminiContents([{
        role: 'tool',
        toolCallId: 'inspect_media',
        content: [
            { text: 'clip' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
            { fileData: { mimeType: 'application/pdf', fileUri: 'files/report' } },
            { inlineData: { mimeType: 'audio/wav', data: 'YXVkaW8=' } },
        ],
    }]);
    assert.deepEqual(tool[0], {
        role: 'user',
        parts: [{
            functionResponse: {
                name: 'inspect_media',
                id: 'inspect_media',
                response: {
                    result: 'clip',
                    media: [{ $ref: 'tool_media_1' }],
                    externalMedia: [{ mimeType: 'application/pdf', fileUri: 'files/report' }],
                    omittedMediaTypes: ['audio/wav'],
                },
                parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=', displayName: 'tool_media_1' } },
                ],
            },
        }],
    });
    assert.equal(tool[0].parts.length, 1, 'media must not escape functionResponse as sibling Content parts');
    assertNoFileData(tool[0].parts[0].functionResponse);
});

test('Gemini global cache accepts a fresh default-five-minute entry', () => {
    assert.equal(GEMINI_GLOBAL_CACHE_MIN_LIVE_MS, 75_000);
    geminiGlobalCaches.clear();
    const now = Date.now();
    _setGeminiGlobalCache('k', {
        cacheName: 'cachedContents/fresh',
        cacheExpiresAt: now + 5 * 60_000,
    });
    assert.equal(_getGeminiGlobalCache('k', now)?.cacheName, 'cachedContents/fresh');
});

test('Gemini global cache rejects entries inside first-byte headroom', () => {
    geminiGlobalCaches.clear();
    const now = Date.now();
    _setGeminiGlobalCache('near-expiry', {
        cacheName: 'cachedContents/near-expiry',
        cacheExpiresAt: now + 70_000,
    });
    assert.equal(_getGeminiGlobalCache('near-expiry', now), null);
});

test('Gemini cache identity includes toolConfig', () => {
    const base = {
        model: 'gemini-2.5-flash',
        systemInstruction: 'system',
        geminiTools: [{ functionDeclarations: [{ name: 'read' }] }],
        contents: [{ role: 'user', parts: [{ text: 'x' }] }],
        prefixCount: 0,
    };
    const auto = _geminiCachePrefixHash({
        ...base,
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    const none = _geminiCachePrefixHash({
        ...base,
        toolConfig: { functionCallingConfig: { mode: 'NONE' } },
    });
    assert.notEqual(auto, none);
});

test('Gemini cache identity is credential-bound and invalidatable without raw keys', () => {
    geminiGlobalCaches.clear();
    const rawKey = 'super-secret-key';
    const fingerprint = _geminiCredentialFingerprint(rawKey);
    assert.notEqual(fingerprint, rawKey);
    assert.equal(fingerprint.includes(rawKey), false);
    const key = _geminiGlobalCacheKey({
        credentialFingerprint: fingerprint,
        model: 'gemini-2.5-flash',
        cachePrefixHash: 'prefix',
        cachePrefixContentCount: 1,
    });
    _setGeminiGlobalCache(key, {
        cacheName: 'cachedContents/credential',
        cacheExpiresAt: Date.now() + 60_000,
        cacheCredentialFingerprint: fingerprint,
    });
    assert.equal(_invalidateGeminiCachesForCredentialFingerprint(fingerprint), 1);
    assert.equal(geminiGlobalCaches.size, 0);
    assert.equal(JSON.stringify([...geminiGlobalCaches]).includes(rawKey), false);
});

test('Gemini cachedContents creation carries toolConfig with the tool schema', async () => {
    geminiGlobalCaches.clear();
    let injectedRequests = 0;
    let capturedBody;
    const provider = new GeminiProvider(hermeticConfig({ fetchFn: async (_url, init) => {
        injectedRequests += 1;
        capturedBody = JSON.parse(init.body);
        return {
            ok: true,
            async json() {
                return {
                    name: 'cachedContents/tool-choice',
                    usageMetadata: { totalTokenCount: 3000 },
                };
            },
        };
    } }));
    try {
        const toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } };
        const name = await provider._ensureGeminiCache({
            apiKey: 'test-key',
            model: 'gemini-2.5-flash',
            systemInstruction: 'x'.repeat(9000),
            geminiTools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'object' } }] }],
            toolConfig,
            contents: [
                { role: 'user', parts: [{ text: 'prefix' }] },
                { role: 'user', parts: [{ text: 'latest' }] },
            ],
            opts: { providerState: {}, iteration: 1 },
        });
        assert.equal(name, 'cachedContents/tool-choice');
        assert.deepEqual(capturedBody.toolConfig, toolConfig);
        assert.equal(capturedBody.tools[0].functionDeclarations[0].name, 'read');
        assert.equal(injectedRequests, 1);
    } finally {
        geminiGlobalCaches.clear();
    }
});

test('Gemini cachedContents creation retries transient failures within policy', async () => {
    geminiGlobalCaches.clear();
    let calls = 0;
    const provider = new GeminiProvider(hermeticConfig({ fetchFn: async () => {
        calls += 1;
        if (calls === 1) {
            return {
                ok: false,
                status: 503,
                headers: new Headers({ 'Retry-After': '0' }),
                async text() { return '{"error":{"message":"temporarily unavailable"}}'; },
            };
        }
        return {
            ok: true,
            async json() {
                return {
                    name: 'cachedContents/retried',
                    usageMetadata: { totalTokenCount: 3000 },
                };
            },
        };
    } }));
    try {
        const name = await provider._ensureGeminiCache({
            apiKey: 'test-key',
            model: 'gemini-2.5-flash',
            systemInstruction: 'x'.repeat(9000),
            contents: [
                { role: 'user', parts: [{ text: 'prefix' }] },
                { role: 'user', parts: [{ text: 'latest' }] },
            ],
            opts: { providerState: {}, iteration: 1 },
        });
        assert.equal(name, 'cachedContents/retried');
        assert.equal(calls, 2);
    } finally {
        geminiGlobalCaches.clear();
    }
});

test('Gemini constructor and send are network-hermetic through injected transports', async () => {
    let preconnectCalls = 0;
    let fetchCalls = 0;
    const provider = new GeminiProvider(hermeticConfig({
        preconnectFn: () => { preconnectCalls += 1; },
        fetchFn: async (url) => {
            fetchCalls += 1;
            return networkDeny(url);
        },
        genAI: {
            getGenerativeModel() {
                return {
                    async generateContentStream() {
                        return sdkStream([{
                            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
                        }]);
                    },
                };
            },
        },
    }));
    provider._ensureGeminiCache = async () => null;
    const result = await provider.send([{ role: 'user', content: 'x' }], 'gemini-2.5-flash', [], {});
    assert.equal(result.content, 'ok');
    assert.equal(preconnectCalls, 2);
    assert.equal(fetchCalls, 0);
});

test('Gemini model listing follows nextPageToken deterministically', async () => {
    const urls = [];
    const pages = [
        { models: [{ name: 'models/gemini-a' }], nextPageToken: 'next token' },
        { models: [{ name: 'models/gemini-b' }] },
    ];
    const items = await fetchGeminiModelPages('key value', async (url) => {
        urls.push(url);
        return {
            ok: true,
            async json() { return pages.shift(); },
        };
    });
    assert.deepEqual(items.map((item) => item.name), ['models/gemini-a', 'models/gemini-b']);
    assert.match(urls[0], /pageSize=1000/);
    assert.match(urls[1], /pageToken=next\+token/);
    assert.equal(urls.every((url) => url.includes('key=key+value')), true);
});

test('Gemini listModels routes native and enrichment catalog fetches through the injected transport', async () => {
    const urls = [];
    let saved = null;
    const originalGlobalFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = async () => {
        globalFetchCalls += 1;
        throw new Error('global fetch must not run');
    };
    try {
    const provider = new GeminiProvider(hermeticConfig({
        catalogForceRefresh: true,
        modelCache: {
            loadSync: () => null,
            save: (models) => { saved = models; },
        },
        fetchFn: async (url) => {
            urls.push(String(url));
            if (String(url).includes('generativelanguage.googleapis.com')) {
                return {
                    ok: true,
                    async json() {
                        return {
                            models: [{
                                name: 'models/gemini-hermetic',
                                displayName: 'Hermetic',
                                supportedGenerationMethods: ['generateContent'],
                            }],
                        };
                    },
                };
            }
            if (String(url).includes('model_prices_and_context_window.json')) {
                return {
                    ok: true,
                    async json() {
                        return {
                            'gemini/gemini-hermetic': {
                                litellm_provider: 'gemini',
                                input_cost_per_token: 1e-6,
                            },
                        };
                    },
                };
            }
            if (String(url).includes('models.dev/api.json')) {
                return { ok: true, async json() { return { google: { models: {} } }; } };
            }
            throw new Error(`unexpected injected URL: ${url}`);
        },
    }));
    const models = await provider.listModels();
    assert.deepEqual(models.map((model) => model.id), ['gemini-hermetic']);
    assert.deepEqual(saved, models);
    assert.equal(urls.some((url) => url.includes('generativelanguage.googleapis.com')), true);
    assert.equal(urls.some((url) => url.includes('model_prices_and_context_window.json')), true);
    assert.equal(urls.some((url) => url.includes('models.dev/api.json')), true);
    assert.equal(globalFetchCalls, 0);
    } finally {
        globalThis.fetch = originalGlobalFetch;
    }
});

test('injected models.dev results are request-local and used exactly for enrichment', async () => {
    const injected = {
        google: {
            models: {
                'gemini-injected-only': {
                    cost: { input: 7, output: 11 },
                    limit: { context: 12345, output: 678 },
                },
            },
        },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() { return { global: { models: {} } }; },
    });
    try {
        await loadModelsDevCatalog({ force: true });
        const models = await enrichModels(
            [{ id: 'gemini-injected-only', provider: 'gemini' }],
            {
                fetchFn: async (url) => ({
                    ok: true,
                    async json() {
                        return String(url).includes('models.dev/api.json') ? injected : {};
                    },
                }),
            },
        );
        assert.equal(models[0].inputCostPerM, 7);
        assert.equal(models[0].outputCostPerM, 11);
        assert.equal(models[0].contextWindow, 12345);
        assert.equal(models[0].outputTokens, 678);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('injected LiteLLM results are request-local and used exactly for enrichment', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        async json() { return { 'global-only': { input_cost_per_token: 1e-6 } }; },
    });
    try {
        await loadCatalog({ force: true });
        const models = await enrichModels([{ id: 'litellm-injected-only' }], {
            fetchFn: async (url) => {
                if (!String(url).includes('model_prices_and_context_window.json')) {
                    throw new Error(`unexpected injected URL: ${url}`);
                }
                return {
                    ok: true,
                    async json() {
                        return {
                            'litellm-injected-only': {
                                input_cost_per_token: 7e-6,
                                output_cost_per_token: 11e-6,
                                max_input_tokens: 12345,
                                max_output_tokens: 678,
                            },
                        };
                    },
                };
            },
        });
        assert.equal(models[0].inputCostPerM, 7);
        assert.equal(models[0].outputCostPerM, 11);
        assert.equal(models[0].contextWindow, 12345);
        assert.equal(models[0].outputTokens, 678);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('injected LiteLLM failure does not prevent a subsequent normal refresh', async () => {
    assert.deepEqual(await loadCatalog({
        force: true,
        fetchFn: async () => { throw new Error('injected failure'); },
    }), {});
    const originalFetch = globalThis.fetch;
    let normalCalls = 0;
    globalThis.fetch = async () => {
        normalCalls += 1;
        return { ok: true, async json() { return { normal: {} }; } };
    };
    try {
        assert.deepEqual(await loadCatalog({ force: true }), { normal: {} });
        assert.equal(normalCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('injected LiteLLM load neither joins nor overwrites a concurrent global singleflight', async () => {
    const originalFetch = globalThis.fetch;
    let resolveGlobal;
    let resolveInjected;
    let globalCalls = 0;
    globalThis.fetch = async () => {
        globalCalls += 1;
        return new Promise((resolve) => { resolveGlobal = resolve; });
    };
    try {
        const globalLoad = loadCatalog({ force: true });
        await Promise.resolve();
        const localLoad = loadCatalog({
            force: true,
            fetchFn: async () => new Promise((resolve) => { resolveInjected = resolve; }),
        });
        assert.equal(globalCalls, 1);
        resolveGlobal({ ok: true, async json() { return { global: {} }; } });
        assert.deepEqual(await globalLoad, { global: {} });
        resolveInjected({ ok: true, async json() { return { injected: {} }; } });
        assert.deepEqual(await localLoad, { injected: {} });
        assert.deepEqual(await loadCatalog(), { global: {} });
        assert.equal(globalCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('injected models.dev failure does not prevent a subsequent normal refresh', async () => {
    const failed = await loadModelsDevCatalog({
        force: true,
        fetchFn: async () => { throw new Error('injected failure'); },
    });
    assert.deepEqual(failed, {});

    const originalFetch = globalThis.fetch;
    let normalCalls = 0;
    globalThis.fetch = async () => {
        normalCalls += 1;
        return { ok: true, async json() { return { normal: { models: {} } }; } };
    };
    try {
        const normal = await loadModelsDevCatalog({ force: true });
        assert.deepEqual(normal, { normal: { models: {} } });
        assert.equal(normalCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('injected models.dev load neither joins nor overwrites a concurrent global singleflight', async () => {
    const originalFetch = globalThis.fetch;
    let resolveGlobal;
    let resolveInjected;
    let globalCalls = 0;
    globalThis.fetch = async () => {
        globalCalls += 1;
        return new Promise((resolve) => { resolveGlobal = resolve; });
    };
    try {
        const globalLoad = loadModelsDevCatalog({ force: true });
        await Promise.resolve();
        const localLoad = loadModelsDevCatalog({
            force: true,
            fetchFn: async () => new Promise((resolve) => { resolveInjected = resolve; }),
        });
        assert.equal(globalCalls, 1);
        resolveGlobal({
            ok: true,
            async json() { return { global: { models: {} } }; },
        });
        assert.deepEqual(await globalLoad, { global: { models: {} } });
        resolveInjected({
            ok: true,
            async json() { return { injected: { models: {} } }; },
        });
        assert.deepEqual(await localLoad, { injected: { models: {} } });
        assert.deepEqual(await loadModelsDevCatalog(), { global: { models: {} } });
        assert.equal(globalCalls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

function sdkStream(chunks) {
    return {
        stream: {
            async *[Symbol.asyncIterator]() {
                for (const chunk of chunks) yield chunk;
            },
        },
    };
}

function finalizingToolGuard() {
    let finalized = false;
    return {
        feedText() {},
        finalize() { finalized = true; },
        getVisibleText() { return ''; },
        getLeakedToolCalls() {
            return finalized ? [{ id: 'gemini_leaked_final', name: 'read', arguments: {} }] : [];
        },
    };
}

test('Gemini REST EOF finalizes buffered leaked tools before classifying truncation', async () => {
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"<invoke"}]}}]}\n',
            ));
            controller.close();
        },
    });
    const error = await consumeGeminiRestStreamResponse(
        { body },
        { label: 'REST EOF leak', textLeakGuard: finalizingToolGuard() },
    ).then(() => null, (caught) => caught);
    assert.equal(error.code, 'TRUNCATED_STREAM');
    assert.equal(error.emittedToolCall, true);
    assert.equal(error.unsafeToRetry, true);
    assert.equal(error.streamStalled, undefined);
    assert.equal(error.partialContent, undefined);
    assert.equal(classifyError(error), 'permanent');
});

test('Gemini REST malformed SSE is retryable corruption even before a later STOP', async () => {
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode([
                'data: {not-json}',
                'data: {"candidates":[{"finishReason":"STOP"}]}',
                '',
            ].join('\n')));
            controller.close();
        },
    });
    const error = await consumeGeminiRestStreamResponse(
        { body },
        { label: 'REST corrupt SSE' },
    ).then(() => null, (caught) => caught);
    assert.equal(error.streamCorruption, true);
    assert.equal(error.code, 'TRUNCATED_STREAM');
    assert.equal(classifyError(error), 'transient');
});

test('Gemini REST already-aborted signal does not lock the response body', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already closed'));
    const body = new ReadableStream({ start() {} });
    await assert.rejects(
        consumeGeminiRestStreamResponse(
            { body },
            { label: 'REST pre-abort', signal: controller.signal },
        ),
        /already closed/,
    );
    assert.equal(body.locked, false);
});

test('Gemini SDK first-byte timeout cancels generation before rejecting', async () => {
    let cancelled = false;
    let returned = false;
    const streamResult = {
        stream: {
            [Symbol.asyncIterator]() {
                return {
                    next() { return new Promise(() => {}); },
                    async return() {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                        returned = true;
                        return { done: true };
                    },
                };
            },
        },
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        label: 'SDK timeout cancellation',
        firstByteTimeoutMs: 5,
        cancelGeneration: () => { cancelled = true; },
    }).then(() => null, (caught) => caught);
    assert.equal(error.code, 'EGEMINITIMEOUT');
    assert.equal(cancelled, true);
    assert.equal(returned, true);
});

test('Gemini SDK timeout is bounded when iterator return never settles', async () => {
    let cancelled = false;
    const startedAt = Date.now();
    const streamResult = {
        stream: {
            [Symbol.asyncIterator]() {
                return {
                    next() { return new Promise(() => {}); },
                    return() { return new Promise(() => {}); },
                };
            },
        },
        response: new Promise(() => {}),
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        label: 'SDK stuck cancellation',
        firstByteTimeoutMs: 5,
        cancellationGraceMs: 20,
        cancelGeneration: () => { cancelled = true; },
    }).then(() => null, (caught) => caught);
    assert.equal(error.code, 'EGEMINITIMEOUT');
    assert.equal(cancelled, true);
    assert.ok(Date.now() - startedAt < 200, 'stuck iterator.return must not deadlock timeout rejection');
});

test('Gemini SDK parser errors are retryable stream corruption', async () => {
    const parseFailure = Object.assign(
        new Error('[GoogleGenerativeAI Error]: Error parsing JSON response: Unexpected end of JSON input'),
        { name: 'GoogleGenerativeAIError' },
    );
    const streamResult = {
        stream: {
            [Symbol.asyncIterator]() {
                return {
                    async next() { throw parseFailure; },
                    async return() { return { done: true }; },
                };
            },
        },
        response: Promise.reject(parseFailure),
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        label: 'SDK corrupt SSE',
    }).then(() => null, (caught) => caught);
    assert.equal(error.streamCorruption, true);
    assert.equal(error.code, 'TRUNCATED_STREAM');
    assert.equal(classifyError(error), 'transient');
});

test('Gemini native function call is retry-safe until provider dispatch', async () => {
    const streamResult = {
        stream: {
            async *[Symbol.asyncIterator]() {
                yield { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {} } }] } }] };
                throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
            },
        },
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        label: 'SDK pre-dispatch function call',
    }).then(() => null, (caught) => caught);
    assert.equal(error.emittedToolCall, undefined);
    assert.equal(error.unsafeToRetry, undefined);
    assert.equal(classifyError(error), 'transient');
});

test('Gemini SDK failure finalizes buffered leaked tools before retry-safety stamps', async () => {
    const streamResult = {
        stream: {
            async *[Symbol.asyncIterator]() {
                yield { candidates: [{ content: { parts: [{ text: '<invoke' }] } }] };
                throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
            },
        },
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        label: 'SDK stalled leak',
        textLeakGuard: finalizingToolGuard(),
    }).then(() => null, (caught) => caught);
    assert.equal(error.emittedToolCall, true);
    assert.equal(error.unsafeToRetry, true);
    assert.equal(error.streamStalled, undefined);
    assert.equal(error.partialContent, undefined);
    assert.equal(classifyError(error), 'permanent');
});

function providerForChunks(chunks) {
    const provider = new GeminiProvider(hermeticConfig());
    provider._ensureGeminiCache = async () => null;
    provider.genAI = {
        getGenerativeModel() {
            return {
                async generateContentStream() {
                    return sdkStream(chunks);
                },
            };
        },
    };
    return provider;
}

test('Gemini provider excludes thought text and returns provider-scoped replay metadata', async () => {
    const provider = providerForChunks([{
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'reason', thought: true, thoughtSignature: 'sig' },
                    { text: 'answer' },
                ],
            },
            finishReason: 'STOP',
        }],
        usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 3,
        },
    }]);
    const deltas = [];
    const result = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        { onTextDelta: (text) => deltas.push(text) },
    );
    assert.equal(result.content, 'answer');
    assert.equal(deltas.join(''), 'answer');
    assert.deepEqual(result.providerMetadata, {
        gemini: {
            thoughtParts: [{ text: 'reason', thoughtSignature: 'sig' }],
        },
    });
    assert.equal(result.usage.outputTokens, 5);
});

test('Gemini MAX_TOKENS error retains signed provider metadata for continuation', async () => {
    const provider = providerForChunks([{
        candidates: [{
            content: {
                role: 'model',
                parts: [
                    { text: 'private', thought: true, thoughtSignature: 'sig-private' },
                    { text: 'partial' },
                ],
            },
            finishReason: 'MAX_TOKENS',
        }],
    }]);
    const error = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        {},
    ).then(() => null, (caught) => caught);
    assert.deepEqual(error.providerMetadata, {
        gemini: { thoughtParts: [{ text: 'private', thoughtSignature: 'sig-private' }] },
    });
});

test('Gemini stream truncation after signed thought/text attaches validated replay metadata', async () => {
    const streamResult = {
        stream: {
            [Symbol.asyncIterator]() {
                let emitted = false;
                return {
                    async next() {
                        if (emitted) throw Object.assign(new Error('stream truncated'), { code: 'TRUNCATED_STREAM', truncatedStream: true });
                        emitted = true;
                        return {
                            done: false,
                            value: {
                                candidates: [{
                                    content: {
                                        role: 'model',
                                        parts: [
                                            { text: 'private', thought: true, thoughtSignature: 'sig-private' },
                                            { text: 'partial', thoughtSignature: 'sig-text' },
                                        ],
                                    },
                                }],
                            },
                        };
                    },
                    async return() { return { done: true }; },
                };
            },
        },
    };
    const error = await consumeGeminiSdkStream(streamResult, {
        onTextDelta: () => {},
        label: 'test Gemini SDK stream',
    }).then(() => null, (caught) => caught);
    assert.equal(error.partialContent, 'partial');
    assert.deepEqual(error.providerMetadata, {
        gemini: {
            thoughtParts: [{ text: 'private', thoughtSignature: 'sig-private' }],
            textParts: [{ text: 'partial', thoughtSignature: 'sig-text' }],
        },
    });
});

for (const finishReason of [
    'MAX_TOKENS',
    'SAFETY',
    'IMAGE_SAFETY',
    'UNEXPECTED_TOOL_CALL',
    'TOO_MANY_TOOL_CALLS',
    'MALFORMED_RESPONSE',
]) {
    test(`Gemini ${finishReason} is provider-incomplete`, async () => {
        const provider = providerForChunks([{
            candidates: [{
                content: { role: 'model', parts: [{ text: 'partial' }] },
                finishReason,
            }],
        }]);
        const error = await provider.send(
            [{ role: 'user', content: 'hello' }],
            'gemini-2.5-flash',
            [],
            {},
        ).then(() => null, (caught) => caught);
        assert.equal(error?.code, 'PROVIDER_INCOMPLETE');
        assert.equal(error?.finishReason, finishReason);
        assert.equal(error?.partialContent, 'partial');
    });
}

test('Gemini prompt safety block is incomplete instead of a truncated stream', async () => {
    const provider = providerForChunks([{
        promptFeedback: { blockReason: 'SAFETY' },
    }]);
    const error = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        {},
    ).then(() => null, (caught) => caught);
    assert.equal(error?.code, 'PROVIDER_INCOMPLETE');
    assert.equal(error?.finishReason, 'PROMPT_SAFETY');
});

test('Gemini auth reload retries a status-coded 401 exactly once', async () => {
    const oldFingerprint = _geminiCredentialFingerprint('old');
    const provider = new GeminiProvider(hermeticConfig({ apiKey: 'old' }));
    let sends = 0;
    let reloads = 0;
    provider._doSend = async () => {
        sends += 1;
        if (sends === 1) throw Object.assign(new Error('unauthorized'), { status: 401 });
        return { content: 'ok' };
    };
    provider.reloadApiKey = () => { reloads += 1; return 'replacement'; };
    const opts = {
        providerState: {
            gemini: {
                cacheName: 'cachedContents/old',
                cacheCredentialFingerprint: oldFingerprint,
            },
        },
    };
    const result = await provider.send([], 'gemini-2.5-flash', [], opts);
    assert.equal(result.content, 'ok');
    assert.equal(sends, 2);
    assert.equal(reloads, 1);
    assert.equal(opts.providerState.gemini, undefined);
});

test('Gemini evicted cachedContent is invalidated and retried uncached', async () => {
    geminiGlobalCaches.clear();
    _setGeminiGlobalCache('evicted-key', {
        cacheName: 'cachedContents/evicted',
        cacheExpiresAt: Date.now() + 5 * 60_000,
    });
    let cacheChecks = 0;
    let restCalls = 0;
    let sdkCalls = 0;
    const provider = new GeminiProvider(hermeticConfig({
        fetchFn: async () => {
            restCalls += 1;
            return {
                ok: false,
                status: 404,
                headers: new Headers(),
                async text() {
                    return JSON.stringify({ error: { message: 'Cached content not found', status: 'NOT_FOUND' } });
                },
            };
        },
        genAI: {
            getGenerativeModel() {
                return {
                    async generateContentStream() {
                        sdkCalls += 1;
                        return sdkStream([{
                            candidates: [{ content: { role: 'model', parts: [{ text: 'uncached ok' }] }, finishReason: 'STOP' }],
                        }]);
                    },
                };
            },
        },
    }));
    provider._ensureGeminiCache = async ({ skipExplicitCache }) => {
        cacheChecks += 1;
        return skipExplicitCache ? null : 'cachedContents/evicted';
    };
    const opts = {
        providerState: { gemini: { cacheName: 'cachedContents/evicted', cachePrefixContentCount: 0 } },
    };
    const result = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        opts,
    );
    assert.equal(result.content, 'uncached ok');
    assert.equal(restCalls, 1);
    assert.equal(sdkCalls, 1);
    assert.equal(cacheChecks, 2);
    assert.equal(opts.providerState.gemini, undefined);
    assert.equal(geminiGlobalCaches.size, 0);
});

test('Gemini REST rate-limit response preserves Retry-After for request retry', async () => {
    let calls = 0;
    let firstCallAt = 0;
    let secondCallAt = 0;
    const provider = new GeminiProvider(hermeticConfig({
        fetchFn: async () => {
            calls += 1;
            if (calls === 1) {
                firstCallAt = Date.now();
                return {
                    ok: false,
                    status: 429,
                    headers: new Headers({ 'Retry-After': '0.05' }),
                    async text() {
                        return JSON.stringify({
                            error: {
                                status: 'RESOURCE_EXHAUSTED',
                                message: 'resource exhausted; retry after the capacity window',
                                details: [{
                                    '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                                    retryDelay: '0s',
                                }],
                            },
                        });
                    },
                };
            }
            secondCallAt = Date.now();
            return {
                ok: true,
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(
                            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"retried"}]},"finishReason":"STOP"}]}\n',
                        ));
                        controller.close();
                    },
                }),
            };
        },
    }));
    provider._ensureGeminiCache = async () => 'cachedContents/live';
    const result = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        { providerState: { gemini: { cachePrefixContentCount: 0 } } },
    );
    assert.equal(result.content, 'retried');
    assert.equal(calls, 2);
    assert.ok(secondCallAt - firstCallAt >= 40, 'Retry-After must set the retry delay');
});

test('Gemini structured RetryInfo outranks resource-exhausted permanence', async () => {
    let calls = 0;
    let firstCallAt = 0;
    let secondCallAt = 0;
    const provider = new GeminiProvider(hermeticConfig({
        fetchFn: async () => {
            calls += 1;
            if (calls === 1) {
                firstCallAt = Date.now();
                return {
                    ok: false,
                    status: 429,
                    headers: new Headers(),
                    async text() {
                        return JSON.stringify({
                            error: {
                                status: 'RESOURCE_EXHAUSTED',
                                message: 'resource exhausted',
                                details: [{
                                    '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                                    retryDelay: '0.05s',
                                }],
                            },
                        });
                    },
                };
            }
            secondCallAt = Date.now();
            return {
                ok: true,
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(
                            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"retry-info"}]},"finishReason":"STOP"}]}\n',
                        ));
                        controller.close();
                    },
                }),
            };
        },
    }));
    provider._ensureGeminiCache = async () => 'cachedContents/live';
    const result = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        { providerState: { gemini: { cachePrefixContentCount: 0 } } },
    );
    assert.equal(result.content, 'retry-info');
    assert.equal(calls, 2);
    assert.ok(secondCallAt - firstCallAt >= 40, 'RetryInfo.retryDelay must set the retry delay');
});

test('Gemini RESOURCE_EXHAUSTED without Retry-After remains permanent', async () => {
    let calls = 0;
    const provider = new GeminiProvider(hermeticConfig({
        fetchFn: async () => {
            calls += 1;
            return {
                ok: false,
                status: 429,
                headers: new Headers(),
                async text() {
                    return JSON.stringify({
                        error: {
                            status: 'RESOURCE_EXHAUSTED',
                            message: 'capacity quota exhausted',
                            details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }],
                        },
                    });
                },
            };
        },
    }));
    provider._ensureGeminiCache = async () => 'cachedContents/live';
    const error = await provider.send(
        [{ role: 'user', content: 'hello' }],
        'gemini-2.5-flash',
        [],
        { providerState: { gemini: { cachePrefixContentCount: 0 } } },
    ).then(() => null, (caught) => caught);
    assert.equal(calls, 1);
    assert.equal(error.code, 'RESOURCE_EXHAUSTED');
    assert.equal(error.geminiStatus, 'RESOURCE_EXHAUSTED');
    assert.equal(error.details[0]['@type'], 'type.googleapis.com/google.rpc.QuotaFailure');
    assert.equal(classifyError(error), 'permanent');
});

test('Gemini availability probe rejects an unresolved generation within its bound', async () => {
    let receivedSignal = null;
    const startedAt = Date.now();
    const provider = new GeminiProvider(hermeticConfig({
        genAI: {
            getGenerativeModel() {
                return {
                    async generateContent(_input, options) {
                        receivedSignal = options?.signal;
                        return new Promise(() => {});
                    },
                };
            },
        },
    }));
    assert.equal(await provider.isAvailable(), false);
    assert.equal(receivedSignal instanceof AbortSignal, true);
    assert.equal(receivedSignal.aborted, true);
    assert.ok(Date.now() - startedAt < 1_500, 'availability probe must be bounded');
});
