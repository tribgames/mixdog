import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeContextMessages } from './context-utils.mjs';

test('warm context summaries observe in-place mutations of every replay-bearing field', () => {
    const message = {
        role: 'assistant', content: [{ type: 'text', text: 'answer' }],
        toolCalls: [{ id: 'call', name: 'read', arguments: { path: 'a' } }],
        thinkingBlocks: [{ type: 'thinking', thinking: 'reason' }],
        assistantBlocks: [{ type: 'text', text: 'block' }],
        reasoningItems: [{ type: 'reasoning', summary: [{ text: 'summary' }] }],
        providerMetadata: { note: 'metadata' }, providerReplay: { note: 'replay' },
        toolCallId: 'call',
    };
    const messages = [message];
    const compare = () => assert.deepEqual(summarizeContextMessages(messages),
        summarizeContextMessages(structuredClone(messages)));
    compare();
    for (const field of ['content', 'toolCalls', 'thinkingBlocks', 'assistantBlocks',
        'reasoningItems', 'providerMetadata', 'providerReplay']) {
        const target = Array.isArray(message[field]) ? message[field][0] : message[field];
        target.text = 'mutated text '.repeat(200);
        compare();
        message[field] = null;
        compare();
        delete message[field];
        compare();
    }
    message.content = 'growing answer '.repeat(200);
    message.role = 'tool';
    message.toolCallId = 'new-call';
    compare();
    messages.push({ role: 'user', content: 'next' });
    compare();
    messages.splice(0, 1);
    compare();
});
