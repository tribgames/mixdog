import assert from 'node:assert/strict';
import test from 'node:test';

import { __cursorWireInternals } from './cursor-wire.mjs';

const { buildRunRequest, decodeMessage, encodeMessage, rewriteConversationState } = __cursorWireInternals;

function checkpointWith(usedTokens) {
  return encodeMessage('ConversationStateStructure', {
    rootPromptMessagesJson: [new Uint8Array([1, 2, 3])],
    tokenDetails: { usedTokens, maxTokens: 200_000 },
    turns: [new Uint8Array([4])],
  });
}

function runInput(conversation, history) {
  return {
    model: 'auto',
    systems: ['rules'],
    tools: [],
    userText: 'hello',
    conversation,
    history,
  };
}

test('a replaced transcript does not replay the checkpoint token accounting', () => {
  const rewritten = rewriteConversationState(checkpointWith(349_000), [new Uint8Array([9, 9])]);
  const state = decodeMessage('ConversationStateStructure', rewritten);
  assert.equal(state.tokenDetails?.usedTokens, undefined);
  assert.deepEqual(state.rootPromptMessagesJson, [new Uint8Array([9, 9])]);
});

test('compaction drops the checkpoint measured against the pre-compaction prefix', () => {
  const conversation = { id: 'conv-1', checkpoint: null, historyBlobIds: null, blobs: new Map() };
  buildRunRequest(runInput(conversation, [{ role: 'user', content: 'a' }]));
  conversation.checkpoint = checkpointWith(349_000);
  buildRunRequest(runInput(conversation, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]));
  assert.notEqual(conversation.checkpoint, null);
  buildRunRequest(runInput(conversation, [{ role: 'user', content: 'compacted summary' }]));
  assert.equal(conversation.checkpoint, null);
});
