import assert from 'node:assert/strict';
import test from 'node:test';
import { completeToolConversation, assertResponseContains } from './lib/local-provider-live-scenarios.mjs';

test('live tool verification permits additional legitimate tool steps and carries every result into the next request', async () => {
  let calls = 0;
  const complete = await completeToolConversation({
    messages: [{ role: 'user', content: 'Read data.' }], tools: [{ name: 'read_value' }],
    send: async (messages) => {
      calls++;
      if (calls > 1) assert.equal(messages.at(-1).content, `value-${calls - 1}`);
      return calls < 3 ? { content: '', toolCalls: [{ id: `call-${calls}`, name: 'read_value', arguments: {} }] }
        : { content: 'value-2' };
    },
    executeTool: async (tool) => `value-${tool.id.split('-')[1]}`,
  });
  assert.equal(complete.toolSteps, 2);
  assertResponseContains(complete.result, 'value-2');
});

test('failed content checks retain the actual response and endless tool loops stay bounded', async () => {
  assert.throws(() => assertResponseContains({ content: 'unexpected actual answer' }, 'required'), /unexpected actual answer/);
  await assert.rejects(completeToolConversation({
    messages: [], tools: [], maxSteps: 2,
    send: async () => ({ toolCalls: [{ id: 'repeat', name: 'read' }] }),
    executeTool: async () => 'value',
  }), /2-step bound/);
});
