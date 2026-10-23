import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toAnthropicMessages } from './anthropic-request-utils.mjs';

// The API rejects every request that carries a blank text block, and a
// persisted turn is replayed on every later request, so one blank turn would
// make the session unusable for good.
function sendsBlankText(messages) {
  return messages.some((message) =>
    typeof message.content === 'string'
      ? !message.content.trim()
      : message.content.some((block) => block?.type === 'text' && !String(block.text ?? '').trim())
  );
}

test('a refused empty final turn is not replayed to Anthropic', () => {
  const lowered = toAnthropicMessages([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '', emptyFinal: true, stopReason: 'refusal' },
    { role: 'user', content: 'second' },
  ]);
  assert.equal(sendsBlankText(lowered), false);
  assert.equal(lowered.filter((message) => message.role === 'assistant').length, 0);
  assert.match(JSON.stringify(lowered), /first[\s\S]*second/);
});

test('a whitespace-only text beside a tool call keeps the call and drops the text', () => {
  const lowered = toAnthropicMessages([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '\n\n', toolCalls: [{ id: 'toolu_1', name: 'read', arguments: {} }] },
    { role: 'tool', toolCallId: 'toolu_1', content: 'ok' },
  ]);
  assert.equal(sendsBlankText(lowered), false);
  const assistant = lowered.find((message) => message.role === 'assistant');
  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ['tool_use']
  );
});

test('an assistant turn with text is replayed unchanged', () => {
  const lowered = toAnthropicMessages([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'next' },
  ]);
  assert.deepEqual(lowered[1], { role: 'assistant', content: 'answer' });
});
