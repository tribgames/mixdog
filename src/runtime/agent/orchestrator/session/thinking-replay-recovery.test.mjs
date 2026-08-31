import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assistantMessageWithoutThinkingReplay,
    canRepairThinkingReplay,
    isThinkingReplayRejection,
    repairThinkingReplayInPlace,
} from './thinking-replay-recovery.mjs';

const rejection = (message) => ({ httpStatus: 400, message });
const poisonedTurn = () => ({
    role: 'assistant',
    content: 'looking',
    toolCalls: [{ id: 'toolu_1', name: 'read', arguments: {} }],
    providerReplay: {
        version: 1,
        provider: 'anthropic',
        items: [
            { type: 'thinking', thinking: '', signature: 'sig-a' },
            { type: 'thinking', thinking: '', signature: 'sig-b' },
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
        ],
    },
});

test('only the deterministic replay-shape refusals are treated as repairable', () => {
    assert.equal(isThinkingReplayRejection(rejection(
        'Anthropic OAuth API 400: messages.3.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.',
    )), true);
    assert.equal(isThinkingReplayRejection(rejection(
        'Anthropic OAuth API 400: messages: text content blocks must be non-empty',
    )), true);
    // Asks for MORE reasoning replay — stripping is the wrong repair.
    assert.equal(isThinkingReplayRejection(rejection(
        'Expected `thinking` or `redacted_thinking`, but found `tool_use`',
    )), false);
    assert.equal(isThinkingReplayRejection({ httpStatus: 429, message: 'rate limit' }), false);
    assert.equal(isThinkingReplayRejection(null), false);
});

test('repair keeps the turn usable: text and tool calls stay, reasoning replay goes', () => {
    const repaired = assistantMessageWithoutThinkingReplay(poisonedTurn());
    assert.deepEqual(repaired.providerReplay.items, [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} },
    ]);
    assert.equal(repaired.content, 'looking');
    assert.equal(repaired.toolCalls.length, 1);
});

test('a turn whose replay was nothing but reasoning falls back to the flat lowering', () => {
    const repaired = assistantMessageWithoutThinkingReplay({
        role: 'assistant',
        content: '',
        thinkingBlocks: [{ type: 'thinking', thinking: '', signature: 'sig-a' }],
        providerReplay: {
            version: 1,
            provider: 'anthropic',
            items: [{ type: 'thinking', thinking: '', signature: 'sig-a' }],
        },
    });
    assert.equal(Object.hasOwn(repaired, 'providerReplay'), false);
    assert.equal(Object.hasOwn(repaired, 'thinkingBlocks'), false);
});

test('empty text blocks are repaired too — the API rejects them outright', () => {
    const repaired = assistantMessageWithoutThinkingReplay({
        role: 'assistant',
        content: 'hi',
        assistantBlocks: [{ type: 'text', text: '' }, { type: 'text', text: 'hi' }],
    });
    assert.deepEqual(repaired.assistantBlocks, [{ type: 'text', text: 'hi' }]);
});

test('a turn with nothing to strip is left alone', () => {
    const clean = {
        role: 'assistant',
        content: 'hi',
        providerReplay: { version: 1, provider: 'anthropic', items: [{ type: 'text', text: 'hi' }] },
    };
    assert.equal(assistantMessageWithoutThinkingReplay(clean), null);
    assert.equal(canRepairThinkingReplay([clean]), false);
    assert.equal(repairThinkingReplayInPlace([clean]), -1);
});

test('the newest carrying turn is repaired by reference so the session persists the fix', () => {
    const older = poisonedTurn();
    const newer = poisonedTurn();
    const messages = [
        { role: 'user', content: 'go' },
        older,
        { role: 'tool', toolCallId: 'toolu_1', content: 'ok' },
        newer,
        { role: 'tool', toolCallId: 'toolu_1', content: 'ok' },
    ];
    assert.equal(canRepairThinkingReplay(messages), true);
    assert.equal(repairThinkingReplayInPlace(messages), 3);
    assert.notEqual(messages[3], newer, 'repaired turn must be a new reference');
    assert.equal(messages[1], older, 'older turns are untouched');
    assert.equal(messages[3].providerReplay.items.some((b) => b.type === 'thinking'), false);
});
