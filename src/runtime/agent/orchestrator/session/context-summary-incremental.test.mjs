import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextMessagesRevision,
  contextMessagesShapeSignature,
  contextMessagesSignature,
  summarizeContextMessages,
} from './context-utils.mjs';

// Every read of a counted block's text is a deep walk of its message.
const reads = new Map();
function counted(id, text) {
  reads.set(id, 0);
  return [
    {
      type: 'text',
      get text() {
        reads.set(id, reads.get(id) + 1);
        return text;
      },
    },
  ];
}
function resetReads() {
  for (const id of reads.keys()) reads.set(id, 0);
}
function walked() {
  return [...reads].filter(([, count]) => count > 0).map(([id]) => id);
}

function history() {
  return [
    { role: 'system', content: '# Active Workflow\nplan first\n# Rules\nbe brief' },
    { role: 'user', content: 'first question' },
    {
      role: 'assistant',
      content: counted('a1', 'answer one'),
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }],
    },
    { role: 'tool', toolCallId: 'c1', content: counted('t1', 'file body '.repeat(40)) },
    { role: 'user', content: '<system-reminder>\n# Core Memory\nprefers tabs\n</system-reminder>' },
    {
      role: 'assistant',
      content: counted('a2', 'answer two'),
      thinkingBlocks: [{ type: 'thinking', thinking: 'weighing options' }],
    },
    { role: 'user', content: 'tail question' },
  ];
}

// The full computation: fresh message objects share no memo with `list`.
function assertMatchesFullComputation(list) {
  const clone = structuredClone(list);
  assert.deepEqual(summarizeContextMessages(list), summarizeContextMessages(clone));
  for (const count of [0, 1, Math.floor(list.length / 2), list.length]) {
    assert.equal(contextMessagesSignature(list, count), contextMessagesSignature(clone, count));
    assert.equal(contextMessagesShapeSignature(list, count), contextMessagesShapeSignature(clone, count));
  }
}

test('incremental summaries equal the full computation for appended, replaced, edited and compacted histories', () => {
  let messages = history();
  assertMatchesFullComputation(messages);

  // Appended in place, one and several at a time.
  messages.push({ role: 'assistant', content: 'short reply' });
  assertMatchesFullComputation(messages);
  messages.push(
    { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'shell', arguments: { command: 'ls' } }] },
    { role: 'tool', toolCallId: 'c2', content: 'a.txt\nb.txt' }
  );
  assertMatchesFullComputation(messages);

  // Replaced array (turn commit): same objects, new array, plus a new tail.
  messages = [...messages, { role: 'user', content: 'next turn' }];
  assertMatchesFullComputation(messages);

  // Edited: an interior entry replaced, an interior field reassigned, the tail
  // mutated in place, and the tail mutated in place after the last sync and
  // then followed by an append (failed-call argument restoration).
  messages[2] = { ...messages[2], content: 'rewritten answer one' };
  assertMatchesFullComputation(messages);
  messages[3].content = 'replaced tool body';
  assertMatchesFullComputation(messages);
  messages.at(-1).content = 'next turn, edited';
  assertMatchesFullComputation(messages);
  const failed = {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c3', name: 'apply_patch', arguments: { patch: '[mixdog compacted]' } }],
  };
  messages.push(failed);
  assertMatchesFullComputation(messages);
  failed.toolCalls[0].arguments = { patch: 'restored body '.repeat(60) };
  messages.push({ role: 'tool', toolCallId: 'c3', content: 'Error: hunk failed' });
  assertMatchesFullComputation(messages);

  // Compacted: kept head with a summary anchor, a new head, and truncation.
  messages = [messages[0], { role: 'user', content: 'Summary of earlier work' }, ...messages.slice(-2)];
  assertMatchesFullComputation(messages);
  messages = [{ role: 'system', content: 'fresh system prompt' }, ...messages.slice(1)];
  assertMatchesFullComputation(messages);
  messages.splice(2);
  assertMatchesFullComputation(messages);
  messages.length = 0;
  assertMatchesFullComputation(messages);
});

test('a sync after appending one message walks only that message, in place or in a replacement array', () => {
  const messages = history();
  summarizeContextMessages(messages);
  resetReads();
  messages.push({ role: 'assistant', content: counted('appended', 'appended reply') });
  summarizeContextMessages(messages);
  assert.deepEqual(walked(), ['appended']);

  // A replacement array continues from the same transcript: besides its new
  // entries it re-checks only the previous tail, which may have been edited
  // in place after the last sync.
  summarizeContextMessages(messages);
  resetReads();
  const replaced = [...messages, { role: 'user', content: 'follow-up' }, { role: 'tool', content: counted('r', 'x') }];
  summarizeContextMessages(replaced);
  assert.deepEqual(walked().sort(), ['appended', 'r']);
  resetReads();
  const next = [...replaced, { role: 'assistant', content: counted('replacement-tail', 'done') }];
  summarizeContextMessages(next);
  assert.deepEqual(walked().sort(), ['r', 'replacement-tail']);

  // An unchanged transcript re-walks only its tail and keeps its revision.
  const revision = contextMessagesRevision(next);
  resetReads();
  assert.equal(contextMessagesRevision(next), revision);
  assert.deepEqual(walked(), ['replacement-tail']);
  assertMatchesFullComputation(next);
});
