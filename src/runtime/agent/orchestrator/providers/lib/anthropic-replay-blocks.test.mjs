import assert from 'node:assert/strict';
import test from 'node:test';

import {
    sanitizeAnthropicReplayBlocks,
    sanitizeAnthropicReplayEntries,
    sanitizeAnthropicThinkingRun,
} from './anthropic-replay-blocks.mjs';

const thinking = (signature) => ({ type: 'thinking', thinking: '', signature });
const text = (value) => ({ type: 'text', text: value });
const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } };

test('an empty text block never survives into a replay', () => {
    const blocks = sanitizeAnthropicReplayBlocks([text(''), text('answer'), toolUse]);
    assert.deepEqual(blocks, [text('answer'), toolUse]);
});

test('thinking runs the model kept apart are not fused by dropping the separator', () => {
    const blocks = sanitizeAnthropicReplayBlocks([
        thinking('sig-a'), text(''), thinking('sig-b'), text('answer'), toolUse,
    ]);
    assert.deepEqual(blocks, [thinking('sig-a'), text('answer'), toolUse]);
});

test('thinking blocks the model really did emit back to back are preserved', () => {
    const blocks = sanitizeAnthropicReplayBlocks([
        thinking('sig-a'), thinking('sig-b'), text('answer'),
    ]);
    assert.deepEqual(blocks, [thinking('sig-a'), thinking('sig-b'), text('answer')]);
});

test('a real text block keeps both runs replayable', () => {
    const input = [thinking('sig-a'), text('mid'), thinking('sig-b'), text('answer')];
    assert.deepEqual(sanitizeAnthropicReplayBlocks(input), input);
});

test('redacted thinking obeys the same run rule', () => {
    const redacted = { type: 'redacted_thinking', data: 'opaque' };
    assert.deepEqual(
        sanitizeAnthropicReplayBlocks([thinking('sig-a'), text(''), redacted, text('answer')]),
        [thinking('sig-a'), text('answer')],
    );
});

test('removals are reported so a poisoned turn is traceable', () => {
    const drops = [];
    sanitizeAnthropicReplayBlocks(
        [thinking('sig-a'), text(''), thinking('sig-b')],
        (kind) => drops.push(kind),
    );
    assert.deepEqual(drops, ['empty_text', 'merged_thinking']);
});

test('entries are reduced in provider block order, not insertion order', () => {
    const blocks = sanitizeAnthropicReplayEntries([
        [4, toolUse],
        [0, thinking('sig-a')],
        [3, text('answer')],
        [1, text('')],
        [2, thinking('sig-b')],
    ]);
    assert.deepEqual(blocks, [thinking('sig-a'), text('answer'), toolUse]);
});

test('the flattened thinking projection carries only replayable runs', () => {
    assert.deepEqual(
        sanitizeAnthropicThinkingRun([thinking('sig-a'), text(''), thinking('sig-b'), toolUse]),
        [thinking('sig-a')],
    );
});

test('reducing an already reduced list changes nothing', () => {
    const once = sanitizeAnthropicReplayBlocks([thinking('sig-a'), text(''), thinking('sig-b')]);
    assert.deepEqual(sanitizeAnthropicReplayBlocks(once), once);
});
