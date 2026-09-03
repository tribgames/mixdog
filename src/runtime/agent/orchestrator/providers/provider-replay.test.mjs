import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    createProviderReplay,
    providerReplayItems,
} from './lib/provider-replay.mjs';
import { toAnthropicMessages } from './lib/anthropic-request-utils.mjs';
import { parseSSEStream as parseAnthropicSSEStream } from './anthropic-sse.mjs';
import { toGeminiContents } from './gemini-schema.mjs';
import { convertMessagesToResponsesInput } from './openai-responses-payload.mjs';
import { toOpenAIMessages, toXaiResponsesInput } from './openai-compat-wire.mjs';
import { estimateMessagesTokens } from '../session/context-utils.mjs';
import { _sessionForDisk } from '../session/store/serialize.mjs';
import { freshContextCompactMessages } from '../session/compact.mjs';

function interleavedAnthropicBlocks() {
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig-a' }];
    for (let index = 1; index <= 10; index += 1) {
        blocks.push({
            type: 'tool_use',
            id: `toolu_${index}`,
            name: 'read',
            input: { index },
        });
    }
    blocks.push({ type: 'thinking', thinking: '', signature: 'sig-b' });
    blocks.push({
        type: 'tool_use',
        id: 'toolu_11',
        name: 'read',
        input: { index: 11 },
    });
    return blocks;
}

function interleavedResponsesItems() {
    const items = [{
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'cipher-a',
        summary: [],
    }];
    for (let index = 1; index <= 10; index += 1) {
        items.push({
            type: 'function_call',
            call_id: `call_${index}`,
            name: 'read',
            arguments: JSON.stringify({ index }),
        });
    }
    items.push({
        type: 'reasoning',
        id: 'rs_2',
        encrypted_content: 'cipher-b',
        summary: [],
    });
    items.push({
        type: 'function_call',
        call_id: 'call_11',
        name: 'read',
        arguments: '{"index":11}',
    });
    // Paired outputs: wire builders now synthesize results for unpaired
    // calls, so the order fixtures carry outputs to keep asserting the
    // interleaved reasoning positions (input[11]) on the no-op path.
    for (let index = 1; index <= 11; index += 1) {
        items.push({
            type: 'function_call_output',
            call_id: `call_${index}`,
            output: `result-${index}`,
        });
    }
    return items;
}

function anthropicSseResponse(events) {
    const body = events
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('provider replay is detached and scoped to its originating provider', () => {
    const source = [{ type: 'thinking', thinking: 'plan', signature: 'sig' }];
    const replay = createProviderReplay('anthropic', source);
    source[0].signature = 'mutated';

    assert.equal(replay.items[0].signature, 'sig');
    assert.deepEqual(providerReplayItems({ providerReplay: replay }, 'anthropic'), replay.items);
    assert.equal(providerReplayItems({ providerReplay: replay }, 'gemini'), undefined);
});

test('Anthropic keeps interleaved thinking at content[11]', () => {
    const blocks = interleavedAnthropicBlocks();
    const message = {
        role: 'assistant',
        content: '',
        toolCalls: blocks
            .filter((block) => block.type === 'tool_use')
            .map((block) => ({
                id: block.id,
                name: block.name,
                arguments: block.input,
            })),
        providerReplay: createProviderReplay('anthropic', blocks),
    };
    const lowered = toAnthropicMessages([message]);

    assert.deepEqual(lowered[0].content, blocks);
    assert.equal(lowered[0].content[11].type, 'thinking');
    assert.equal(lowered[0].content[11].signature, 'sig-b');
});

test('Anthropic SSE parse to next-request replay keeps content[11] unchanged', async () => {
    const events = [
        { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-a' } },
        { type: 'content_block_stop', index: 0 },
    ];
    for (let index = 1; index <= 10; index += 1) {
        events.push(
            {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: `toolu_${index}`, name: 'read' },
            },
            {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify({ index }) },
            },
            { type: 'content_block_stop', index },
        );
    }
    events.push(
        { type: 'content_block_start', index: 11, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 11, delta: { type: 'signature_delta', signature: 'sig-b' } },
        { type: 'content_block_stop', index: 11 },
        {
            type: 'content_block_start',
            index: 12,
            content_block: { type: 'tool_use', id: 'toolu_11', name: 'read' },
        },
        {
            type: 'content_block_delta',
            index: 12,
            delta: { type: 'input_json_delta', partial_json: '{"index":11}' },
        },
        { type: 'content_block_stop', index: 12 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    );
    const parsed = await parseAnthropicSSEStream(
        anthropicSseResponse(events),
        null,
        () => {},
        () => {},
        () => {},
        {},
        null,
        new Set(['read']),
    );
    const lowered = toAnthropicMessages([{
        role: 'assistant',
        content: parsed.content || '',
        toolCalls: parsed.toolCalls,
        providerReplay: parsed.providerReplay,
    }]);

    assert.equal(parsed.providerReplay.items[11].type, 'thinking');
    assert.deepEqual(lowered[0].content, parsed.providerReplay.items);
});

test('Gemini keeps signed thought Parts interleaved with function calls', () => {
    const parts = [{ text: 'plan-a', thought: true, thoughtSignature: 'sig-a' }];
    for (let index = 1; index <= 10; index += 1) {
        parts.push({ functionCall: { id: `call_${index}`, name: 'read', args: { index } } });
    }
    parts.push({ text: 'plan-b', thought: true, thoughtSignature: 'sig-b' });
    parts.push({ functionCall: { id: 'call_11', name: 'read', args: { index: 11 } } });
    const contents = toGeminiContents([{
        role: 'assistant',
        content: '',
        toolCalls: [],
        providerReplay: createProviderReplay('gemini', parts),
    }], 'gemini-3-pro');

    assert.deepEqual(contents[0].parts, parts);
    assert.equal(contents[0].parts[11].thoughtSignature, 'sig-b');
});

test('OpenAI Responses recovery keeps reasoning between function calls', () => {
    const items = interleavedResponsesItems();
    const input = convertMessagesToResponsesInput([{
        role: 'assistant',
        content: '',
        toolCalls: [],
        providerReplay: createProviderReplay('openai-responses', items),
    }], { replayEncryptedReasoning: true });

    assert.deepEqual(input, items);
    assert.equal(input[11].type, 'reasoning');
    assert.equal(input[11].id, 'rs_2');
});

test('xAI stateless recovery keeps encrypted reasoning output order', () => {
    const items = interleavedResponsesItems();
    const result = toXaiResponsesInput([{
        role: 'assistant',
        content: '',
        toolCalls: [],
        providerReplay: createProviderReplay('xai-responses', items),
    }], null);

    assert.deepEqual(result.input, items);
    assert.equal(result.input[11].type, 'reasoning');
});

test('OpenRouter reasoning_details remains an unmodified assistant field', () => {
    const reasoningDetails = [
        { type: 'reasoning.text', text: 'plan', signature: 'opaque' },
        { type: 'reasoning.encrypted', data: 'ciphertext' },
    ];
    const wire = toOpenAIMessages([{
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }],
        providerMetadata: { openrouter: { reasoning_details: reasoningDetails } },
    }], 'openrouter');

    assert.equal(wire[0].reasoning_details, reasoningDetails);
});

test('provider replay survives disk projection and contributes to context size', () => {
    const providerReplay = createProviderReplay('openai-responses', interleavedResponsesItems());
    const message = { role: 'assistant', content: '', providerReplay };
    const stored = _sessionForDisk({ id: 's', messages: [message] });

    assert.deepEqual(stored.messages[0].providerReplay, providerReplay);
    assert.ok(
        estimateMessagesTokens([message])
        > estimateMessagesTokens([{ role: 'assistant', content: '' }]),
    );
});

test('fresh-context projection removes native calls whose tool outputs were removed', () => {
    const callId = 'call_compact_replay_orphan';
    const compacted = freshContextCompactMessages([
        { role: 'system', content: 'system rules stay mandatory' },
        { role: 'user', content: 'older retained request' },
        {
            role: 'assistant',
            content: 'running the older shell command',
            toolCalls: [{ id: callId, name: 'shell', arguments: { command: 'node old-test.mjs' } }],
            providerReplay: createProviderReplay('openai-responses', [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'running the older shell command' }],
                },
                {
                    type: 'function_call',
                    call_id: callId,
                    name: 'shell',
                    arguments: '{"command":"node old-test.mjs"}',
                },
            ]),
        },
        { role: 'tool', toolCallId: callId, content: 'background task started' },
        { role: 'user', content: 'newest request remains live' },
        { role: 'assistant', content: 'newest answer remains live' },
    ], 20_000, {
        force: true,
        handoffText: 'Memory hit: older retained request',
        query: 'provider replay projection',
        querySha: 'providerreplayprojection',
    });

    const projectedAssistant = compacted.messages.find(
        (message) => message?.role === 'assistant'
            && message.content === 'running the older shell command',
    );
    assert.equal(projectedAssistant, undefined);
    assert.equal(JSON.stringify(compacted.messages).includes('providerReplay'), false);

    const wire = convertMessagesToResponsesInput(
        compacted.messages,
        { replayEncryptedReasoning: true },
    );
    assert.equal(
        wire.some((item) => item?.type === 'function_call' && item.call_id === callId),
        false,
    );
});
