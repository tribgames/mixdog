import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  parse,
  analyze,
  OpenAICompatProvider,
  _toResponsesToolsForTest,
  _toXaiResponsesInputForTest,
  compatParseToolCalls,
  compatParseResponsesToolCalls,
  consumeCompatResponsesStream,
  isInvalidToolArgsMarker,
  PATCH_TOOL_DEFS,
  compatResponsesEventStream,
} from './_shared.mjs';


// === 1. openai-compat ======================================================
// Chat path:      parseToolCalls(choice, label)         openai-compat.mjs:957
// Responses path: parseResponsesToolCalls(response,...) openai-compat.mjs:972
// Both exported (added `export` keyword only).

test('openai-compat (chat): native tool_calls → canonical toolCalls', () => {
    const choice = {
        message: {
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'grep', arguments: '{"pattern":"x"}' },
            }],
        },
        finish_reason: 'tool_calls',
    };
    const out = compatParseToolCalls(choice, 'test');
    assert.deepEqual(out, [{ id: 'call_1', name: 'grep', arguments: { pattern: 'x' } }]);
});

test('openai-compat (chat): no tool_calls → undefined', () => {
    assert.equal(compatParseToolCalls({ message: { content: 'hi' }, finish_reason: 'stop' }, 'test'), undefined);
    assert.equal(compatParseToolCalls({ message: { tool_calls: [] } }, 'test'), undefined);
});

test('openai-compat (responses): native function_call → canonical toolCalls', () => {
    const response = {
        status: 'completed',
        output: [{
            type: 'function_call',
            call_id: 'fc_1',
            name: 'read',
            arguments: '{"path":"a"}',
        }],
    };
    const out = compatParseResponsesToolCalls(response, 'test');
    assert.deepEqual(out, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

test('openai-compat (responses): no function_call → undefined', () => {
    assert.equal(compatParseResponsesToolCalls({ status: 'completed', output: [] }, 'test'), undefined);
    assert.equal(compatParseResponsesToolCalls({ output: [{ type: 'message', content: [] }] }, 'test'), undefined);
});

// Native convergence: a completed function tool_call whose arguments JSON is
// malformed must NOT make the provider layer throw or swallow to {}. The parse
// failure rides through on the call's `arguments` slot as an invalid-args
// marker so the dispatch loop can return an is_error tool_result and let the
// model self-correct in the same turn.
test('openai-compat (chat): malformed tool_calls args → invalid-args marker (provider does not throw)', () => {
    const choice = {
        message: {
            tool_calls: [{
                id: 'call_bad',
                type: 'function',
                function: { name: 'grep', arguments: '{"pattern": dispatchAiWrapped}' },
            }],
        },
        finish_reason: 'tool_calls',
    };
    const out = compatParseToolCalls(choice, 'test');
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'call_bad');
    assert.equal(out[0].name, 'grep');
    assert.equal(isInvalidToolArgsMarker(out[0].arguments), true);
});

test('openai-compat (responses): malformed function_call args → invalid-args marker (no throw)', () => {
    const response = {
        status: 'completed',
        output: [{
            type: 'function_call',
            call_id: 'fc_bad',
            name: 'read',
            arguments: '{path:}',
        }],
    };
    const out = compatParseResponsesToolCalls(response, 'test');
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'fc_bad');
    assert.equal(out[0].name, 'read');
    assert.equal(isInvalidToolArgsMarker(out[0].arguments), true);
});

test('openai-compat/xai Responses stream: response.completed salvages deferred function_call id/name', async () => {
    const captured = [];
    const out = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_1', model: 'grok' } },
        {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_item_1',
            arguments: '{"path":"a"}',
        },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                model: 'grok',
                status: 'completed',
                output: [{
                    type: 'function_call',
                    id: 'fc_item_1',
                    call_id: 'fc_1',
                    name: 'read',
                    arguments: '{"path":"a"}',
                }],
            },
        },
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onToolCall: (call) => captured.push(call),
    });
    assert.deepEqual(out.toolCalls, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
    assert.deepEqual(captured, [{ id: 'fc_1', name: 'read', arguments: { path: 'a' } }]);
});

// Missing-terminal + partial-tool gate (shared tool-stream-state.mjs tracker):
// a Responses stream that streams a CUSTOM tool call's input then truncates
// before response.output_item.done / response.completed. The call never lands
// in pendingCalls or toolCalls, so the truncation error must be gated as
// pendingToolUse via the shared active tool-item tracker (activeToolItems),
// NOT accepted as a text-only partial-final that would drop the in-flight tool.
test('openai-compat/xai Responses stream: mid custom-tool-input truncation is gated pendingToolUse via shared tracker', async () => {
    const rejected = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_ct', model: 'grok' } },
        { type: 'response.output_text.delta', delta: 'partial ' },
        { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ct_item_1' } },
        { type: 'response.custom_tool_call_input.delta', item_id: 'ct_item_1', delta: '{"x":' },
        // stream truncates here: no output_item.done, no response.completed.
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onTextDelta: () => {},
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated stream to reject');
    assert.equal(rejected.streamStalled, true);
    // The in-flight custom tool must gate partial-final success even though it
    // never reached pendingCalls/toolCalls — the active tracker carries it.
    assert.equal(rejected.pendingToolUse, true);
    assert.equal(rejected.partialContent, 'partial ');
});

// Precision half of the same tracker: once the tool call fully COMPLETES
// (output_item.done clears the active item) and text keeps streaming, a later
// truncation is a plain text-only partial — the tracker having been cleared is
// what lets pendingToolUse fall back to the real emit/pending state.
test('openai-compat/xai Responses stream: completed tool then trailing-text truncation clears active tracker', async () => {
    let emitted = 0;
    const rejected = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_done', model: 'grok' } },
        { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ct_done_1' } },
        { type: 'response.custom_tool_call_input.delta', item_id: 'ct_done_1', delta: '{"x":1}' },
        { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ct_done_1', name: 'load_tool', input: '{"x":1}' } },
        { type: 'response.output_text.delta', delta: 'after tool ' },
        // truncates before response.completed.
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
        onTextDelta: () => {},
        onToolCall: () => { emitted += 1; },
    }).then(() => null, (e) => e);
    assert.ok(rejected, 'expected the truncated stream to reject');
    assert.equal(rejected.streamStalled, true);
    // A tool WAS emitted this turn, so the turn is still unsafe/tool-bearing —
    // pendingToolUse stays true off the emit state, not a stale active latch.
    assert.ok(emitted >= 1);
    assert.equal(rejected.pendingToolUse, true);
});

// Reviewer fix: function output_item.done must delete the pendingCalls itemId
// before recomputing toolInFlight — otherwise a fully-completed function call
// keeps pendingCalls.size > 0 forever, and a later max-output cutoff on trailing
// text is misclassified as a truncated tool-in-flight stall instead of a clean
// length completion.
test('openai-compat/xai Responses stream: completed function call clears pendingCalls so max-output cutoff is clean length', async () => {
    const out = await consumeCompatResponsesStream(compatResponsesEventStream([
        { type: 'response.created', response: { id: 'resp_len', model: 'grok' } },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_len', name: 'read', call_id: 'fc_len' } },
        { type: 'response.function_call_arguments.done', item_id: 'fi_len', arguments: '{"path":"a"}' },
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_len', call_id: 'fc_len', name: 'read', arguments: '{"path":"a"}' } },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    ]), {
        label: 'test',
        parseResponsesToolCalls: compatParseResponsesToolCalls,
        responseOutputText: () => '',
    });
    // The completed call drained pendingCalls + the active tracker, so the
    // max-output cutoff is a clean length truncation (no in-flight-tool stall).
    assert.equal(out.stopReason, 'length');
    assert.deepEqual(out.toolCalls, [{ id: 'fc_len', name: 'read', arguments: { path: 'a' } }]);
});

test('openai-compat/xai Responses: freeform apply_patch downgrades to function schema', () => {
    const tools = _toResponsesToolsForTest(PATCH_TOOL_DEFS);
    const patch = tools.find((tool) => tool.name === 'apply_patch');
    assert.equal(patch.type, 'function');
    assert.equal(patch.format, undefined);
    assert.equal(patch.parameters?.properties?.patch?.type, 'string');
    assert.equal(patch.parameters?.properties?.patch?.minLength, 1);
    assert.deepEqual(patch.parameters?.required, ['patch']);
    // `root` was intentionally dropped with the out-of-session Root: line
    // (a2ae023e); the JSON fallback carries the single `patch` argument.
    assert.deepEqual(Object.keys(patch.parameters?.properties || {}), ['patch']);
    assert.equal(patch.description, 'Edit files with one complete V4A patch in `patch`.');
    assert.doesNotMatch(JSON.stringify(patch), /Begin Patch|Add File|Delete File|Update File|exact current context|roll ?back/i);
});

test('openai-compat/xai Responses: load_tool downgrades from tool_search to function schema', () => {
    const loadTool = {
        name: 'load_tool',
        description: 'load tools',
        inputSchema: {
            type: 'object',
            properties: { names: { type: 'array', items: { type: 'string' } } },
        },
    };
    const [xaiTool] = _toResponsesToolsForTest([loadTool], { provider: 'xai' });
    assert.equal(xaiTool.type, 'function');
    assert.equal(xaiTool.name, 'load_tool');
    assert.equal(xaiTool.execution, undefined);
    assert.equal(xaiTool.parameters, loadTool.inputSchema);

    const [openaiTool] = _toResponsesToolsForTest([loadTool], { provider: 'openai' });
    assert.equal(openaiTool.type, 'tool_search');
    assert.equal(openaiTool.execution, 'client');
    assert.equal(openaiTool.name, undefined);
});

test('openai-compat/xai Responses: load_tool history replays as function_call', () => {
    const { input } = _toXaiResponsesInputForTest([
        { role: 'user', content: 'load a tool' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'load_tool', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        {
            role: 'tool',
            toolCallId: 'call_load_1',
            content: '{}',
            nativeToolSearch: { openaiTools: [{ name: 'read' }] },
        },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_same',
            seenMessageCount: 0,
            model: 'grok-4.5',
        },
    }, { model: 'grok-4.5' });
    assert.equal(input.some((item) => item.type === 'tool_search_call'), false);
    assert.equal(input.some((item) => item.type === 'tool_search_output'), false);
    const call = input.find((item) => item.type === 'function_call' && item.name === 'load_tool');
    assert.equal(call.call_id, 'call_load_1');
    assert.deepEqual(JSON.parse(call.arguments), { names: ['read'] });
    assert.equal(input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_load_1'), true);
});

test('openai-compat/xai store=false continuation replays the full conversation with encrypted reasoning', () => {
    const encrypted = {
        type: 'reasoning',
        id: 'reasoning_1',
        encrypted_content: 'opaque-ciphertext',
        summary: [],
    };
    const { input, previousResponseId, startIndex } = _toXaiResponsesInputForTest([
        { role: 'user', content: 'call read' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'contents' },
    ], {
        xaiResponses: {
            previousResponseId: null,
            responseId: 'resp_unstored',
            store: false,
            encryptedReasoningItems: [encrypted],
            seenMessageCount: 1,
            model: 'grok-4.5',
        },
    }, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(startIndex, 0);
    assert.equal(input[0].role, 'user');
    assert.deepEqual(input[1], encrypted);
    assert.equal(input[2].call_id, 'call_1');
    assert.equal(input[3].call_id, 'call_1');
});

test('openai-compat/xai store=false second tool round retains original system/user and both tool results', () => {
    const firstReasoning = {
        type: 'reasoning',
        id: 'reasoning_1',
        encrypted_content: 'opaque-first',
        summary: [],
    };
    const secondReasoning = {
        type: 'reasoning',
        id: 'reasoning_2',
        encrypted_content: 'opaque-second',
        summary: [],
    };
    const { input, previousResponseId, startIndex } = _toXaiResponsesInputForTest([
        { role: 'system', content: 'original system' },
        { role: 'user', content: 'original user request' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
        { role: 'tool', toolCallId: 'call_1', content: 'first tool result' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_2', name: 'grep', arguments: { pattern: 'x' } }] },
        { role: 'tool', toolCallId: 'call_2', content: 'second tool result' },
    ], {
        xaiResponses: {
            previousResponseId: null,
            responseId: 'resp_unstored_2',
            store: false,
            encryptedReasoningHistory: [
                { messageIndex: 2, items: [firstReasoning] },
                { messageIndex: 4, items: [secondReasoning] },
            ],
            seenMessageCount: 4,
            model: 'grok-4.5',
        },
    }, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(startIndex, 0);
    assert.equal(input[0].role, 'system');
    assert.equal(input[0].content[0].text, 'original system');
    assert.equal(input[1].role, 'user');
    assert.equal(input[1].content[0].text, 'original user request');
    assert.deepEqual(input.filter((item) => item.type === 'reasoning'), [firstReasoning, secondReasoning]);
    assert.deepEqual(
        input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
        ['call_1', 'call_2'],
    );
    assert.deepEqual(
        input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
        ['first tool result', 'second tool result'],
    );
});

test('openai-compat/xai Responses: model switch drops prior tool transcript history', () => {
    const { input, previousResponseId, continuationResetReason } = _toXaiResponsesInputForTest([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'before switch' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_load_1', name: 'load_tool', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }],
        },
        { role: 'tool', toolCallId: 'call_load_1', content: '{"loaded":["read"]}' },
        { role: 'user', content: 'after switch' },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_old',
            seenMessageCount: 4,
            model: 'grok-4.20',
        },
    }, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(continuationResetReason, 'model_changed');
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('tool_search'), false);
    assert.equal(serialized.includes('function_call'), false);
    assert.equal(serialized.includes('function_call_output'), false);
    assert.deepEqual(input.map((item) => item.role), ['system', 'user', 'user']);
});

test('openai-compat/xai Responses: first Grok request after provider switch drops prior tool transcript history', () => {
    const { input, previousResponseId, continuationResetReason } = _toXaiResponsesInputForTest([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'before switch' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** End Patch\n' } }],
        },
        { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
        { role: 'user', content: 'after switch' },
    ], {}, { model: 'grok-4.5' });
    assert.equal(previousResponseId, null);
    assert.equal(continuationResetReason, null);
    const serialized = JSON.stringify(input);
    assert.equal(serialized.includes('function_call'), false);
    assert.equal(serialized.includes('function_call_output'), false);
    assert.deepEqual(input.map((item) => item.role), ['system', 'user', 'user']);
});

test('openai-compat/xai Responses: custom_tool_call history replays as function_call', () => {
    const rawPatch = '*** Begin Patch\n*** Add File: xai-history.txt\n+ok\n*** End Patch\n';
    const { input } = _toXaiResponsesInputForTest([
        { role: 'user', content: 'patch please' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: rawPatch }, nativeType: 'custom_tool_call' }],
        },
        { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
    ], {
        xaiResponses: {
            previousResponseId: 'resp_same',
            seenMessageCount: 0,
            model: 'grok-composer-2.5-fast',
        },
    }, { model: 'grok-composer-2.5-fast' });
    assert.equal(input.some((item) => item.type === 'custom_tool_call'), false);
    assert.equal(input.some((item) => item.type === 'custom_tool_call_output'), false);
    const call = input.find((item) => item.type === 'function_call' && item.name === 'apply_patch');
    assert.equal(call.call_id, 'call_patch_1');
    assert.deepEqual(JSON.parse(call.arguments), { patch: rawPatch });
    const output = input.find((item) => item.type === 'function_call_output');
    assert.equal(output.call_id, 'call_patch_1');
    assert.equal(output.output, 'OK');
});

test('openai-compat/xai: constructor and HTTP send use only the injected preconnect seam', async () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    const prevFetch = globalThis.fetch;
    let outboundFetchAttempts = 0;
    let injectedPreconnectCalls = 0;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        globalThis.fetch = async () => {
            outboundFetchAttempts += 1;
            throw new Error('provider transport test attempted outbound fetch');
        };

        // Resolve the actual imported binding and inspect _doSend before
        // invoking any outbound-capable provider path. AST traversal naturally
        // excludes comments/strings and catches direct, aliased, parenthesized,
        // optional, or assigned references.
        const compatSource = readFileSync(
            new URL('../../src/runtime/agent/orchestrator/providers/openai-compat.mjs', import.meta.url),
            'utf8',
        );
        const compatAst = parse(compatSource, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: true,
            ranges: true,
        });
        const preconnectImport = compatAst.body
            .filter(node => node.type === 'ImportDeclaration')
            .flatMap(node => node.specifiers)
            .find(specifier =>
                specifier.type === 'ImportSpecifier'
                && specifier.imported.name === 'preconnect',
            );
        assert.ok(preconnectImport, 'shared preconnect import binding must be resolvable');
        const scopeManager = analyze(compatAst, { ecmaVersion: 2022, sourceType: 'module' });
        const moduleScope = scopeManager.scopes.find(scope => scope.type === 'module');
        const preconnectBinding = moduleScope?.set.get(preconnectImport.local.name);
        assert.ok(preconnectBinding, 'shared preconnect source binding must be resolvable');

        const providerClass = compatAst.body
            .map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
            .find(node =>
                node?.type === 'ClassDeclaration'
                && node.id?.name === 'OpenAICompatProvider',
            );
        assert.ok(providerClass, 'OpenAICompatProvider class must be resolvable');
        const doSendMethod = providerClass.body.body.find(node =>
            node.type === 'MethodDefinition'
            && node.key?.type === 'Identifier'
            && node.key.name === '_doSend',
        );
        assert.ok(doSendMethod, 'OpenAICompatProvider._doSend must be resolvable');

        let callsInjectedInstanceMember = false;
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (
                node.type === 'CallExpression'
                && node.callee?.type === 'MemberExpression'
                && node.callee.object?.type === 'ThisExpression'
                && node.callee.computed === false
                && node.callee.property?.name === '_preconnectFn'
            ) {
                callsInjectedInstanceMember = true;
            }
            for (const [key, value] of Object.entries(node)) {
                if (key === 'start' || key === 'end') continue;
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === 'object') visit(value);
            }
        };
        visit(doSendMethod.value.body);
        const importedBindingReferences = preconnectBinding.references.filter(reference =>
            reference.identifier.start >= doSendMethod.value.body.start
            && reference.identifier.end <= doSendMethod.value.body.end,
        );
        assert.equal(
            importedBindingReferences.length,
            0,
            '_doSend must not reference the shared preconnect import binding',
        );
        assert.equal(
            callsInjectedInstanceMember,
            true,
            '_doSend must call the instance preconnect seam',
        );

        const provider = new OpenAICompatProvider('xai', {
            apiKey: 'xai-test',
            responsesTransport: 'http',
            preconnect: true,
            preconnectFn: () => {
                injectedPreconnectCalls += 1;
            },
        });
        assert.equal(injectedPreconnectCalls, 1, 'constructor must start the origin warmup');
        let httpCalled = false;
        provider._doSendXaiResponses = async () => {
            httpCalled = true;
            return { content: 'ok' };
        };
        provider._doSendXaiResponsesWebSocket = async () => {
            throw new Error('explicit HTTP transport should not use WS');
        };
        const result = await provider._doSend([{ role: 'user', content: 'hi' }], 'grok-build', [], {});
        assert.equal(result.content, 'ok');
        assert.equal(httpCalled, true);
        assert.equal(injectedPreconnectCalls, 2, 'send must re-enter the injected TTL-gated warmup seam');
        assert.equal(outboundFetchAttempts, 0, 'stubbed provider test must remain network hermetic');
    } finally {
        globalThis.fetch = prevFetch;
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});
