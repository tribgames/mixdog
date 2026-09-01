import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _toXaiResponsesInputForTest,
  _buildRequestBodyForCacheSmoke,
  _anthropicApiKeyTest,
  _toAnthropicMessagesForTest,
  _anthropicOAuthTest,
  EFFORT_BETA_HEADER,
  LEGACY_EFFORT_BUDGET,
  effortValuesForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  normalizeAnthropicEffortInput,
  setModelEffortCapabilities,
  shouldIncludeEffortBeta,
  buildAnthropicBetaHeaders,
  _convertMessagesToResponsesInputForTest,
  anthropicSseResponse,
} from './_shared.mjs';


test('Anthropic API-key gates deferred beta to requests that carry deferred tools', async () => {
    const provider = Object.create((await import('../../src/runtime/agent/orchestrator/providers/anthropic.mjs')).AnthropicProvider.prototype);
    provider.name = 'anthropic';
    provider.config = {};
    provider.fastModeBetaHeaderLatched = false;
    const calls = [];
    provider.client = { messages: { create(params, options) {
        calls.push({ params, options });
        return { asResponse: async () => ({
            ...anthropicSseResponse([
                { type: 'message_start', message: { model: params.model, usage: { input_tokens: 1 } } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
                { type: 'message_stop' },
            ]),
            ok: true,
            status: 200,
            headers: new Map(),
        }) };
    } } };

    await provider._doSend([{ role: 'user', content: 'plain' }], 'claude-sonnet-4-6', [], {});
    assert.doesNotMatch(calls[0].options.headers['anthropic-beta'], /advanced-tool-use/);

    const active = [{ name: 'load_tool', description: 'load', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    await provider._doSend([{ role: 'user', content: 'load' }], 'claude-sonnet-4-6', active, {
        session: {
            deferredNativeTools: true,
            deferredDiscoveredTools: [deferred.name],
            deferredToolCatalog: [...active, deferred],
        },
    });
    assert.match(calls[1].options.headers['anthropic-beta'], /advanced-tool-use/);
    assert.equal(calls[1].params.tools.find((tool) => tool.name === deferred.name)?.defer_loading, true);
});

test('native deferred history normalizes per provider without leaking OpenAI variants to xAI', () => {
    const nativePayload = {
        provider: 'openai-oauth',
        toolReferences: ['mcp__demo__ping'],
        openaiTools: [{
            type: 'function',
            name: 'mcp__demo__ping',
            defer_loading: true,
            parameters: { type: 'object', properties: {} },
        }],
    };
    const history = [
        { role: 'user', content: 'load it' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'load-1', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] }, nativeType: 'tool_search_call' }],
        },
        { role: 'tool', toolCallId: 'load-1', content: 'Loaded', nativeToolSearch: nativePayload },
    ];
    const openai = _convertMessagesToResponsesInputForTest(history);
    assert.equal(openai[1].type, 'tool_search_call');
    assert.equal(openai[2].type, 'tool_search_output');
    assert.equal(openai[2].tools[0].name, 'mcp__demo__ping');

    const xai = _toXaiResponsesInputForTest(history, {
        xaiResponses: { previousResponseId: 'resp-1', seenMessageCount: 0, model: 'grok-4' },
    }, { model: 'grok-4' }).input;
    assert.equal(xai.some((item) => item.type === 'tool_search_call' || item.type === 'tool_search_output'), false);
    assert.equal(xai[1].type, 'function_call');
    assert.equal(xai[2].type, 'function_call_output');
});

test('Anthropic native deferred result retains tool_reference history and defer_loading declarations', () => {
    const base = [{ name: 'load_tool', description: 'loader', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    const session = {
        deferredNativeTools: true,
        deferredToolCatalog: [...base, deferred],
    };
    const firstBody = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'find ping' }],
        'claude-sonnet-4-6',
        base,
        { session },
    );
    assert.equal(firstBody.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);
    assert.deepEqual(_anthropicApiKeyTest.deferredAnthropicTools(base, [], { session }), []);
    const history = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'load-a1', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
        },
        {
            role: 'tool',
            toolCallId: 'load-a1',
            content: 'Loaded',
            nativeToolSearch: {
                provider: 'anthropic-oauth',
                toolReferences: ['mcp__demo__ping'],
                openaiTools: [],
            },
        },
    ];
    const body = _buildRequestBodyForCacheSmoke(history, 'claude-sonnet-4-6', base, { session });
    const result = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(result.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    assert.equal(body.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);
    const apiKeyHistory = history.map((message) => (
        message.nativeToolSearch
            ? { ...message, nativeToolSearch: { ...message.nativeToolSearch, provider: 'anthropic' } }
            : message
    ));
    const apiKeyDiscovered = _anthropicApiKeyTest.deferredAnthropicTools(base, apiKeyHistory, { session });
    assert.equal(apiKeyDiscovered.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
    session.deferredDiscoveredTools = ['mcp__demo__ping'];
    const compacted = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'continue after compact' }],
        'claude-sonnet-4-6',
        base,
        { session },
    );
    assert.equal(compacted.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);
    const apiKeyCompacted = _anthropicApiKeyTest.deferredAnthropicTools(base, [], { session });
    assert.equal(apiKeyCompacted.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
});

test('Anthropic drops tool_reference blocks whose tool no longer ships in the request', () => {
    const base = [{ name: 'load_tool', description: 'loader', inputSchema: { type: 'object', properties: {} } }];
    const shell = { name: 'shell', description: 'run', inputSchema: { type: 'object', properties: {} } };
    // `memory` was loaded earlier but has since left the deferred catalog
    // (feature toggle / surface rebuild / disconnected server). The reference
    // survives in history, so without filtering EVERY later turn 400s with
    // "Tool reference 'memory' not found in available tools".
    const session = {
        deferredNativeTools: true,
        deferredToolCatalog: [...base, shell],
    };
    const history = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'load-stale', name: 'load_tool', arguments: { names: ['memory'] } }],
        },
        {
            role: 'tool',
            toolCallId: 'load-stale',
            content: 'Loaded deferred tools: memory',
            nativeToolSearch: {
                provider: 'anthropic-oauth',
                toolReferences: ['memory'],
                openaiTools: [],
            },
        },
    ];
    const body = _buildRequestBodyForCacheSmoke(history, 'claude-sonnet-4-6', base, { session });
    const result = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.equal(body.tools.some((tool) => tool.name === 'memory'), false);
    assert.equal(JSON.stringify(body.messages).includes('tool_reference'), false);
    assert.equal(JSON.stringify(result.content).includes('Loaded deferred tools: memory'), true);

    // Partial resolution keeps the references the request can still back.
    const mixed = [
        history[0],
        {
            ...history[1],
            nativeToolSearch: { ...history[1].nativeToolSearch, toolReferences: ['memory', 'shell'] },
        },
    ];
    const mixedResult = _toAnthropicMessagesForTest(mixed, [...base, { name: 'shell' }])
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(mixedResult.content, [{ type: 'tool_reference', tool_name: 'shell' }]);

    // A blank stored result still needs non-empty tool_result content.
    const blank = _toAnthropicMessagesForTest([history[0], { ...history[1], content: '' }], base)
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.equal(blank.content[0].type, 'text');
    assert.match(blank.content[0].text, /memory/);

    // No tool list => every reference is kept verbatim (unchanged callers).
    const unfiltered = _toAnthropicMessagesForTest(history)
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(unfiltered.content, [{ type: 'tool_reference', tool_name: 'memory' }]);
});

test('Anthropic API-key and OAuth preserve root properties across compound schemas', () => {
    const properties = {
        pattern: { type: 'string' },
        path: { type: 'string' },
    };
    const branches = [
            { required: ['pattern'] },
            { required: ['path'] },
    ];
    for (const compoundKey of ['oneOf', 'anyOf', 'allOf']) {
        const schema = { type: 'object', properties, [compoundKey]: branches };
        const expected = { type: 'object', properties };
        const apiKey = _anthropicApiKeyTest.sanitizeInputSchema(schema, 'grep');
        const oauth = _anthropicOAuthTest.sanitizeInputSchema(schema, 'grep');

        assert.deepEqual(apiKey, expected, `API-key ${compoundKey}`);
        assert.deepEqual(oauth, expected, `OAuth ${compoundKey}`);
        assert.deepEqual(apiKey, oauth, `${compoundKey} parity`);
    }
});

test('Anthropic native provider-tag switches preserve tool_reference and loaded schema bidirectionally', () => {
    const base = [{ name: 'load_tool', description: 'loader', inputSchema: { type: 'object', properties: {} } }];
    const deferred = { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object', properties: {} } };
    const session = {
        deferredNativeTools: true,
        deferredToolCatalog: [...base, deferred],
    };
    const history = (provider) => [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'anthropic-family-pair', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
        },
        {
            role: 'tool',
            toolCallId: 'anthropic-family-pair',
            content: 'Loaded deferred tools: mcp__demo__ping',
            nativeToolSearch: {
                provider,
                toolReferences: ['mcp__demo__ping'],
                openaiTools: [],
            },
        },
    ];
    const apiKeyToOauth = _buildRequestBodyForCacheSmoke(
        history('anthropic'),
        'claude-sonnet-4-6',
        base,
        { session },
    );
    const oauthResult = apiKeyToOauth.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(oauthResult.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    assert.equal(apiKeyToOauth.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);

    const oauthHistory = history('anthropic-oauth');
    const oauthToApiKeyMessages = _toAnthropicMessagesForTest(oauthHistory);
    const apiKeyResult = oauthToApiKeyMessages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block.type === 'tool_result');
    assert.deepEqual(apiKeyResult.content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
    const apiKeyTools = _anthropicApiKeyTest.deferredAnthropicTools(base, oauthHistory, { session });
    assert.equal(apiKeyTools.find((tool) => tool.name === 'mcp__demo__ping')?.deferLoading, true);
});

test('anthropic API-key and OAuth lower plain signed thinkingBlocks before text without tool calls', () => {
    const thinkingBlocks = [
        { type: 'thinking', thinking: 'resume state', signature: 'sig-recovery-1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED_RECOVERY_STATE' },
    ];
    const history = [
        { role: 'user', content: 'write the answer' },
        { role: 'assistant', content: 'partial answer', thinkingBlocks },
        { role: 'user', content: 'resume directly' },
    ];
    const expectedAssistantContent = [
        ...thinkingBlocks,
        { type: 'text', text: 'partial answer' },
    ];

    const apiKeyMessages = _toAnthropicMessagesForTest(history);
    const oauthMessages = _buildRequestBodyForCacheSmoke(
        history,
        'claude-sonnet-4-6',
        [],
        {},
    ).messages;

    for (const lowered of [apiKeyMessages, oauthMessages]) {
        const assistant = lowered.find((message) => message.role === 'assistant');
        assert.ok(assistant, 'plain recovery assistant turn must survive lowering');
        assert.deepEqual(assistant.content, expectedAssistantContent);
        assert.equal(assistant.content.some((block) => block.type === 'tool_use'), false);
    }
});

test('anthropic API-key and OAuth lower interrupted tool results with is_error', () => {
    const history = [
        { role: 'user', content: 'run a tool' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'toolu_interrupted_1', name: 'read', arguments: { path: 'x' } }],
        },
        {
            role: 'tool',
            content: 'Cancelled',
            toolCallId: 'toolu_interrupted_1',
            toolKind: 'error',
        },
        { role: 'user', content: '[Request interrupted by user]' },
    ];
    const apiKeyMessages = _toAnthropicMessagesForTest(history);
    const oauthMessages = _buildRequestBodyForCacheSmoke(
        history,
        'claude-sonnet-4-6',
        [],
        {},
    ).messages;

    for (const lowered of [apiKeyMessages, oauthMessages]) {
        const toolResult = lowered
            .flatMap((message) => Array.isArray(message.content) ? message.content : [])
            .find((block) => (
                block?.type === 'tool_result'
                && block.tool_use_id === 'toolu_interrupted_1'
            ));
        assert.ok(toolResult);
        assert.equal(toolResult.is_error, true);
        assert.equal(JSON.stringify(lowered).includes('[Request interrupted by user]'), true);
    }
});

test('anthropic effort: legacy claude-3-7-sonnet gets NO adaptive thinking / effort beta', () => {
    const model = 'claude-3-7-sonnet-20250219';
    assert.equal(modelSupportsEffort(model), false);
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'high' },
    );
    assert.equal(body.output_config, undefined);
    // Legacy path uses the budget_tokens shape, never thinking:adaptive.
    assert.notEqual(body.thinking?.type, 'adaptive');
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'high' }), false);
});

// === 8. Anthropic effort (output_config vs legacy thinking budget) ==========

test('anthropic effort: sonnet-4-6 uses output_config + effort beta, not thinking', () => {
    const model = 'claude-sonnet-4-6';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'high' },
    );
    assert.deepEqual(body.output_config, { effort: 'high' });
    // Adaptive-thinking models also carry thinking:{type:'adaptive'} — the
    // legacy budget_tokens shape 400s on these models.
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'high' }), true);
    const beta = buildAnthropicBetaHeaders({ effort: true });
    assert.ok(beta.includes(EFFORT_BETA_HEADER));
});

test('anthropic-oauth: foreign native references normalize to ordinary tool_result after provider switches', () => {
    const body = _buildRequestBodyForCacheSmoke(
        [
            { role: 'user', content: 'load a tool' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'toolu_load_1', name: 'load_tool', arguments: { names: ['read'] } }],
            },
            {
                role: 'tool',
                toolCallId: 'toolu_load_1',
                content: '{"loaded":["read"]}',
                nativeToolSearch: { provider: 'openai-oauth', toolReferences: ['read'] },
            },
        ],
        'claude-opus-4-8',
        [],
        { effort: 'high' },
    );
    const serialized = JSON.stringify(body.messages);
    assert.equal(serialized.includes('tool_reference'), false);
    const toolResult = body.messages
        .flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .find((block) => block?.type === 'tool_result' && block.tool_use_id === 'toolu_load_1');
    assert.ok(toolResult);
    assert.equal(toolResult.content, '{"loaded":["read"]}');
});

test('anthropic effort: legacy sonnet-4-5 maps effort to thinking budget', () => {
    const model = 'claude-sonnet-4-5-20250514';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'medium' },
    );
    assert.equal(body.output_config, undefined);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: LEGACY_EFFORT_BUDGET.medium });
    assert.equal(modelSupportsEffort(model), false);
});

test('anthropic effort: xhigh on opus-4-8 is a first-class level (not downgraded to max)', () => {
    // Opus 4.8 supports xhigh (modelSupportsXhighEffort), so xhigh is kept
    // verbatim as a first-class effort level — the effort ladder lists xhigh
    // between high and max. Only models WITHOUT xhigh
    // support clamp it down to high.
    const model = 'claude-opus-4-8';
    assert.equal(modelSupportsMaxEffort(model), true);
    assert.equal(normalizeAnthropicEffortInput('xhigh', model), 'xhigh');
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'xhigh' },
    );
    assert.deepEqual(body.output_config, { effort: 'xhigh' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
});

test('anthropic effort: explicit thinkingBudgetTokens wins over effort', () => {
    const model = 'claude-sonnet-4-6';
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'low', thinkingBudgetTokens: 2048 },
    );
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(body.output_config, undefined);
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'low', thinkingBudgetTokens: 2048 }), false);
});

test('anthropic effort: bare version id claude-opus-5 gets effort + adaptive thinking', () => {
    // The catalog mints version-tier ids WITHOUT a dated suffix, which the old
    // `/^claude-opus-5-/` gate missed — every request silently fell back to a
    // fixed 16K legacy thinking budget.
    setModelEffortCapabilities([]);
    const model = 'claude-opus-5';
    assert.equal(modelSupportsEffort(model), true);
    assert.equal(shouldIncludeEffortBeta(model, { effort: 'high' }), true);
    const body = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: 'hi' }],
        model,
        [],
        { effort: 'high' },
    );
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    assert.equal(body.temperature, undefined);
});

test('anthropic effort: bare pre-5 aliases stay on the legacy budget path', () => {
    setModelEffortCapabilities([]);
    assert.equal(modelSupportsEffort('claude-opus-4'), false);
    assert.equal(modelSupportsEffort('claude-sonnet-4'), false);
    assert.equal(modelSupportsEffort('claude-haiku-5'), false);
});

test('anthropic effort: catalog capabilities outrank the regex ladder', () => {
    setModelEffortCapabilities([
        { id: 'claude-mythos-9-20260401', reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        { id: 'claude-opus-5', reasoningOptions: [{ type: 'budget_tokens', min: 1024 }] },
        // No reasoningOptions at all = unknown record: the regex fallback must
        // still decide (offline/static lists carry no capability data).
        { id: 'claude-fable-5' },
    ]);
    try {
        // Unknown to every regex, but advertised by the catalog — the dated id
        // and its bare alias resolve to the same record.
        assert.equal(modelSupportsEffort('claude-mythos-9'), true);
        assert.equal(modelSupportsMaxEffort('claude-mythos-9-20260401'), true);
        assert.equal(modelSupportsXhighEffort('claude-mythos-9'), false);
        // Catalog says budget_tokens only → no effort, regex opinion ignored.
        assert.equal(modelSupportsEffort('claude-opus-5'), false);
        assert.equal(modelSupportsEffort('claude-fable-5'), true);
    } finally {
        setModelEffortCapabilities([]);
    }
});

test('anthropic effort: catalog normalization drops control keys from levels', () => {
    // `supported` is a control flag on capabilities.effort, not a level; it
    // leaked into the persisted catalog and into the effort picker.
    assert.deepEqual(
        effortValuesForModel({ effort: { supported: true, low: true, high: true, max: true } }, 'claude-opus-5'),
        ['low', 'high', 'max'],
    );
});
