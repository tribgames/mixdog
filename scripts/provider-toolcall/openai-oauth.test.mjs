import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PATCH_TOOL_DEFS,
  BUILTIN_TOOLS,
  sendViaHttpSse,
  buildCodexStartupPrewarmBody,
  buildOpenAIOAuthRequestBody,
  _convertMessagesToResponsesInputForTest,
  httpSseResponse,
  customToolCallFromResponseItem,
} from './_shared.mjs';


test('OpenAI native provider-tag switches keep tool_search call/output paired', () => {
    const history = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'native-pair', name: 'load_tool', arguments: {}, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'native-pair',
            content: 'Loaded',
            nativeToolSearch: {
                provider: 'openai',
                toolReferences: ['read'],
                openaiTools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
            },
        },
    ];
    const oauth = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai-oauth' });
    assert.deepEqual(oauth.map((item) => item.type), ['tool_search_call', 'tool_search_output']);
    history[1].nativeToolSearch.provider = 'openai-oauth';
    const direct = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai' });
    assert.deepEqual(direct.map((item) => item.type), ['tool_search_call', 'tool_search_output']);
});

// Reviewer fix (HTTP/SSE): a max_output_tokens cutoff while a function call is
// still in flight (added + partial args, no output_item.done) must NOT mark a
// clean length completion — the tool arguments were truncated. Mirror compat:
// throw a stream-stalled pendingToolUse error so the loop gates/retries.
test('openai-oauth HTTP/SSE Responses: max-output cutoff with function call in flight → stream-stalled pendingToolUse', async () => {
    const rejected = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [] },
        useModel: 'gpt',
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'r', model: 'gpt' } },
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fi_1', delta: '{"path":' },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
        ]),
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated-tool cutoff to reject');
    assert.equal(rejected.streamStalled, true);
    assert.equal(rejected.pendingToolUse, true);
});

// Reviewer fix (HTTP/SSE): function output_item.done must delete pendingCalls[id]
// before recomputing _toolInFlight — otherwise the completed call keeps
// pendingCalls.size > 0 and a later max-output cutoff is misread as a truncated
// tool. A fully-completed call before the cutoff must be a clean length result.
test('openai-oauth HTTP/SSE Responses: completed function call clears pendingCalls so max-output cutoff is clean length', async () => {
    const out = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [] },
        useModel: 'gpt',
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'r', model: 'gpt' } },
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
            { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"path":"a"}' },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fc_1', name: 'read', arguments: '{"path":"a"}' } },
            { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
        ]),
    });
    assert.equal(out.stopReason, 'length');
    assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

test('openai-oauth request allows one mixed custom-patch/function-shell batch', () => {
    const shellTool = BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
    const body = buildOpenAIOAuthRequestBody(
        [{ role: 'user', content: 'patch then verify' }],
        'gpt-5.6-sol',
        [PATCH_TOOL_DEFS[0], shellTool],
        {},
    );
    const patch = body.tools.find((tool) => tool.name === 'apply_patch');
    const shell = body.tools.find((tool) => tool.name === 'shell');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(patch.type, 'custom');
    assert.equal(shell.type, 'function');
    assert.ok(typeof shell.description === 'string' && shell.description.length > 0);
    assert.doesNotMatch(shell.description, /verification|PowerShell:/i);
});

test('openai-oauth reasoning replay defaults on and honors its kill switch', () => {
    const encrypted = {
        type: 'reasoning',
        id: 'rs_replay_1',
        encrypted_content: 'opaque-reasoning',
        summary: [],
    };
    const history = [
        { role: 'user', content: 'inspect it' },
        {
            role: 'assistant',
            content: '',
            reasoningItems: [encrypted],
            toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'contents' },
    ];
    const defaultInput = _convertMessagesToResponsesInputForTest(history);
    assert.equal(defaultInput.some((item) => item.type === 'reasoning'), false);

    const replayInput = _convertMessagesToResponsesInputForTest(history, {
        replayEncryptedReasoning: true,
    });
    assert.deepEqual(replayInput.map((item) => item.type), [
        undefined,
        'reasoning',
        'function_call',
        'function_call_output',
    ]);
    assert.deepEqual(replayInput[1], encrypted);

    const defaultBody = buildOpenAIOAuthRequestBody(history, 'gpt-5.6-sol', [], {});
    assert.equal('context' in defaultBody.reasoning, false);
    assert.equal(defaultBody.reasoning.summary, 'auto');
    assert.deepEqual(defaultBody.stream_options, {
        reasoning_summary_delivery: 'sequential_cutoff',
    });
    assert.deepEqual(defaultBody.input.find((item) => item.type === 'reasoning'), encrypted);
    process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY = '1';
    try {
        const killedBody = buildOpenAIOAuthRequestBody(history, 'gpt-5.6-sol', [], {
            replayEncryptedReasoning: true,
        });
        assert.equal('context' in killedBody.reasoning, false);
        assert.equal(killedBody.reasoning.summary, 'auto');
        assert.equal(killedBody.input.some((item) => item.type === 'reasoning'), false);
    } finally {
        delete process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY;
    }
});

test('openai-oauth always builds the standard Responses payload', () => {
    const body = buildOpenAIOAuthRequestBody(
        [
            { role: 'system', content: 'stable instructions' },
            { role: 'system', content: 'session environment', cacheTier: 'env' },
            { role: 'user', content: 'hello' },
        ],
        'gpt-5.6-sol',
        [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
        {
            turnId: '019fc135-f07a-7880-8767-ec3b7be1de64',
        },
    );
    assert.equal(body.instructions, 'stable instructions');
    assert.equal(body.tools[0].name, 'read');
    assert.equal(body.parallel_tool_calls, true);
    assert.equal('context' in body.reasoning, false);
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[1].role, 'user');
    assert.deepEqual(body.input[0].internal_chat_message_metadata_passthrough, {
        turn_id: '019fc135-f07a-7880-8767-ec3b7be1de64',
    });
    assert.deepEqual(body.input[1].internal_chat_message_metadata_passthrough, {
        turn_id: '019fc135-f07a-7880-8767-ec3b7be1de64',
    });

    const warmup = buildCodexStartupPrewarmBody(body);
    assert.equal(warmup.generate, false);
    assert.deepEqual(warmup.input, []);
});

test('openai-oauth HTTP/SSE stateless experiment omits conversation anchor headers', async () => {
    let capturedHeaders = null;
    await sendViaHttpSse({
        auth: { access_token: 'token', account_id: 'account' },
        body: { model: 'gpt-5.6-sol', tools: [] },
        opts: { statelessConversation: true },
        cacheKey: 'stable-cache-key',
        useModel: 'gpt-5.6-sol',
        fetchFn: async (_url, init) => {
            capturedHeaders = init.headers;
            return httpSseResponse([
                { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } },
                { type: 'response.completed', response: { id: 'r', model: 'gpt-5.6-sol', output: [] } },
            ]);
        },
    });
    assert.equal(capturedHeaders.session_id, undefined);
    assert.equal(capturedHeaders['session-id'], undefined);
    assert.equal(capturedHeaders['thread-id'], undefined);
});

test('openai-oauth HTTP/SSE preserves mixed custom-patch/function-shell call order', async () => {
    const rawPatch = '*** Begin Patch\n*** Add File: mixed.txt\n+ok\n*** End Patch\n';
    const emitted = [];
    const out = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt', tools: [{ name: 'apply_patch' }, { name: 'shell' }] },
        useModel: 'gpt',
        onToolCall: (call) => emitted.push(call),
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'r', model: 'gpt' } },
            { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ci_1', call_id: 'cp_1', name: 'apply_patch' } },
            { type: 'response.custom_tool_call_input.delta', item_id: 'ci_1', delta: rawPatch },
            { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ci_1', call_id: 'cp_1', name: 'apply_patch', input: rawPatch } },
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', call_id: 'fs_1', name: 'shell' } },
            { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"command":"npm test"}' },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fs_1', name: 'shell', arguments: '{"command":"npm test"}' } },
            { type: 'response.completed', response: { id: 'r', model: 'gpt', output: [] } },
        ]),
    });
    const expected = [
        { id: 'cp_1', name: 'apply_patch', arguments: { patch: rawPatch }, nativeType: 'custom_tool_call' },
        { id: 'fs_1', name: 'shell', arguments: { command: 'npm test' } },
    ];
    assert.deepEqual(out.toolCalls, expected);
    assert.deepEqual(emitted, expected);
});

test('openai-oauth Responses: load_tool uses native tool_search history', () => {
    const loadTool = {
        name: 'load_tool',
        description: 'load tools',
        inputSchema: {
            type: 'object',
            properties: { names: { type: 'array', items: { type: 'string' } } },
        },
    };
    const body = buildOpenAIOAuthRequestBody([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'load a tool' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'tool_search', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'call_load_1',
            content: 'Loaded deferred tools: read',
            nativeToolSearch: {
                provider: 'openai-oauth',
                toolReferences: ['read'],
                openaiTools: [{
                    type: 'function',
                    name: 'read',
                    description: 'read',
                    defer_loading: true,
                    parameters: { type: 'object', properties: {} },
                }],
            },
        },
    ], 'gpt-5.5', [loadTool], {});
    assert.equal(JSON.stringify(body).includes('tool_search'), true);
    assert.deepEqual(body.tools, [{
        type: 'tool_search',
        execution: 'client',
        description: loadTool.description,
        parameters: loadTool.inputSchema,
    }]);
    const call = body.input.find((item) => item.type === 'tool_search_call');
    assert.deepEqual(call, {
        type: 'tool_search_call',
        call_id: 'call_load_1',
        execution: 'client',
        arguments: { names: ['read'] },
    });
    const output = body.input.find((item) => item.type === 'tool_search_output' && item.call_id === 'call_load_1');
    assert.deepEqual(output, {
        type: 'tool_search_output',
        call_id: 'call_load_1',
        status: 'completed',
        execution: 'client',
        tools: [{
            type: 'function',
            name: 'read',
            description: 'read',
            defer_loading: true,
            parameters: { type: 'object', properties: {} },
        }],
    });
});

test('openai-oauth (shared custom-tool-wire): custom_tool_call item → canonical call', () => {
    const item = { type: 'custom_tool_call', call_id: 'ctc_1', name: 'apply_patch', input: '*** patch ***' };
    const call = customToolCallFromResponseItem(item);
    assert.equal(call.id, 'ctc_1');
    assert.equal(call.name, 'apply_patch');
    assert.deepEqual(call.arguments, { patch: '*** patch ***' });
    assert.equal(call.nativeType, 'custom_tool_call');
});

test('openai-oauth (shared custom-tool-wire): non custom_tool_call → null', () => {
    assert.equal(customToolCallFromResponseItem({ type: 'function_call' }), null);
    assert.equal(customToolCallFromResponseItem(null), null);
});
