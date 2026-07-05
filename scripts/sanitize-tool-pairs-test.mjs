import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { repairTranscriptBeforeProviderSend } from '../src/runtime/agent/orchestrator/session/loop.mjs';

const TOOL_MISSING_STUB = '[Older tool result unavailable after context compaction]';

const assistantA = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_a', name: 'grep', arguments: {} }],
};

const toolA = {
    role: 'tool',
    toolCallId: 'call_a',
    content: 'grep output',
    toolKind: 'normal',
};

test('reattaches interleaved tool result immediately after assistant toolCalls', () => {
    const user = { role: 'user', content: 'continue' };
    const input = [assistantA, user, toolA];
    const out = sanitizeToolPairs(input);

    assert.deepEqual(out, [assistantA, toolA, user]);
    assert.equal(out.filter((m) => m.role === 'tool').length, 1);
});

test('contiguous block for multiple toolCalls when results were separated', () => {
    const assistant = {
        role: 'assistant',
        content: '',
        toolCalls: [
            { id: 'call_a', name: 'read', arguments: {} },
            { id: 'call_b', name: 'grep', arguments: {} },
        ],
    };
    const user = { role: 'user', content: 'next' };
    const input = [
        assistant,
        { role: 'tool', toolCallId: 'call_a', content: 'a', toolKind: 'normal' },
        user,
        { role: 'tool', toolCallId: 'call_b', content: 'b', toolKind: 'normal' },
    ];
    const out = sanitizeToolPairs(input);

    assert.equal(out.length, 4);
    assert.equal(out[0], assistant);
    assert.equal(out[1].toolCallId, 'call_a');
    assert.equal(out[1].content, 'a');
    assert.equal(out[2].toolCallId, 'call_b');
    assert.equal(out[3], user);
});

test('inserts stub when assistant toolCall has no matching tool message', () => {
    const out = sanitizeToolPairs([assistantA, { role: 'user', content: 'hi' }]);

    assert.equal(out.length, 3);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].toolCallId, 'call_a');
    assert.equal(out[1].content, TOOL_MISSING_STUB);
});

test('drops tool messages with no surviving assistant tool_call', () => {
    const orphan = { role: 'tool', toolCallId: 'orphan', content: 'gone' };
    const out = sanitizeToolPairs([orphan, { role: 'user', content: 'hi' }]);

    assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
});

test('drops malformed tool messages without toolCallId', () => {
    const malformed = { role: 'tool', content: 'no id' };
    const out = sanitizeToolPairs([malformed, assistantA, toolA]);

    assert.equal(out.length, 2);
    assert.equal(out[0], assistantA);
    assert.equal(out[1].toolCallId, 'call_a');
});

test('duplicate same-id prefers valid result after assistant over stale before', () => {
    const stale = { role: 'tool', toolCallId: 'call_a', content: 'stale', toolKind: 'normal' };
    const valid = { role: 'tool', toolCallId: 'call_a', content: 'valid', toolKind: 'normal' };
    const out = sanitizeToolPairs([stale, assistantA, { role: 'user', content: 'x' }, valid]);

    assert.equal(out.length, 3);
    assert.equal(out[1].content, 'valid');
});

test('duplicate same-id in contiguous block after assistant keeps first there', () => {
    const first = { role: 'tool', toolCallId: 'call_a', content: 'first', toolKind: 'normal' };
    const second = { role: 'tool', toolCallId: 'call_a', content: 'second', toolKind: 'normal' };
    const out = sanitizeToolPairs([assistantA, first, { role: 'user', content: 'x' }, second]);

    assert.equal(out.length, 3);
    assert.equal(out[1].content, 'first');
});

test('debugger06: assistantBlocks + role tool keeps REAL_BODY after sanitizeToolPairs', () => {
    const REAL_BODY = 'REAL_BODY from debugger06 fixture';
    const assistant = {
        role: 'assistant',
        content: '',
        assistantBlocks: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_use', id: 'call_blocks', name: 'read', input: { path: 'x' } },
        ],
    };
    const toolMsg = {
        role: 'tool',
        toolCallId: 'call_blocks',
        content: REAL_BODY,
        toolKind: 'normal',
    };
    const user = { role: 'user', content: 'next' };
    const out = sanitizeToolPairs([assistant, user, toolMsg]);

    assert.equal(out.length, 3);
    assert.equal(out[0], assistant);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].toolCallId, 'call_blocks');
    assert.equal(out[1].content, REAL_BODY);
    assert.equal(out[2], user);
});

test('debugger06: assistant content tool_use + role tool keeps REAL_BODY after sanitizeToolPairs', () => {
    const REAL_BODY = 'REAL_BODY content-array fixture';
    const assistant = {
        role: 'assistant',
        content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'call_content', name: 'grep', input: {} },
        ],
    };
    const toolMsg = {
        role: 'tool',
        toolCallId: 'call_content',
        content: REAL_BODY,
    };
    const out = sanitizeToolPairs([assistant, toolMsg]);

    assert.equal(out.length, 2);
    assert.equal(out[1].content, REAL_BODY);
});

test('sanitizeAnthropicContentPairs reorders tool_result before user text for multi-tool assistant', () => {
    const assistant = {
        role: 'assistant',
        content: [
            { type: 'tool_use', id: 'call_a', name: 'read', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'grep', input: {} },
        ],
    };
    const user = {
        role: 'user',
        content: [
            { type: 'text', text: 'continue after tools' },
            { type: 'tool_result', tool_use_id: 'call_a', content: 'a out' },
            { type: 'tool_result', tool_use_id: 'call_b', content: 'b out' },
        ],
    };
    const out = sanitizeAnthropicContentPairs([assistant, user]);

    assert.equal(out.length, 2);
    assert.equal(out[1].content[0].type, 'tool_result');
    assert.equal(out[1].content[1].type, 'tool_result');
    assert.equal(out[1].content[2].type, 'text');
});

test('sanitizeAnthropicContentPairs inserts user tool_result when no following user message', () => {
    const assistant = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_x', name: 'shell', input: {} }],
    };
    const out = sanitizeAnthropicContentPairs([assistant]);

    assert.equal(out.length, 2);
    assert.equal(out[0], assistant);
    assert.equal(out[1].role, 'user');
    assert.equal(out[1].content.length, 1);
    assert.equal(out[1].content[0].type, 'tool_result');
    assert.equal(out[1].content[0].tool_use_id, 'call_x');
});

test('sanitizeAnthropicContentPairs stubs missing ids and leads with all tool_result blocks', () => {
    const assistant = {
        role: 'assistant',
        content: [
            { type: 'tool_use', id: 'call_a', name: 'read', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'grep', input: {} },
        ],
    };
    const user = {
        role: 'user',
        content: [
            { type: 'text', text: 'steer' },
            { type: 'tool_result', tool_use_id: 'call_a', content: 'only a' },
        ],
    };
    const out = sanitizeAnthropicContentPairs([assistant, user]);
    const blocks = out[1].content;

    assert.equal(blocks[0].type, 'tool_result');
    assert.equal(blocks[0].tool_use_id, 'call_b');
    assert.equal(blocks[1].type, 'tool_result');
    assert.equal(blocks[1].tool_use_id, 'call_a');
    assert.equal(blocks[2].type, 'text');
});

test('debugger06: sanitizeAnthropicContentPairs drops leading orphan tool_result', () => {
    const leadingOrphan = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'stale_lead', content: 'orphan' }],
    };
    const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
    };
    const out = sanitizeAnthropicContentPairs([leadingOrphan, assistant]);

    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'assistant');
});

test('debugger06: sanitizeAnthropicContentPairs drops stale tool_result and reorders valid', () => {
    const assistant = {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_live', name: 'read', input: {} }],
    };
    const user = {
        role: 'user',
        content: [
            { type: 'tool_result', tool_use_id: 'stale_other', content: 'drop me' },
            { type: 'text', text: 'between' },
            { type: 'tool_result', tool_use_id: 'call_live', content: 'VALID_KEEP' },
        ],
    };
    const out = sanitizeAnthropicContentPairs([assistant, user]);
    const blocks = out[1].content;

    assert.equal(blocks[0].type, 'tool_result');
    assert.equal(blocks[0].tool_use_id, 'call_live');
    assert.equal(blocks[0].content, 'VALID_KEEP');
    assert.equal(blocks[1].type, 'text');
    assert.ok(!blocks.some((b) => b.tool_use_id === 'stale_other'));
});

test('loop pre-send repair reattaches separated assistant/tool instead of deleting', () => {
    const user = { role: 'user', content: 'steer' };
    const msgs = [assistantA, user, { ...toolA }];
    repairTranscriptBeforeProviderSend(msgs, 'test-sess');

    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[1].toolCallId, 'call_a');
    assert.equal(msgs[1].content, 'grep output');
    assert.equal(msgs[2], user);
});


