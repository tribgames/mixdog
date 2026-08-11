import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _applyReasoningReplayPolicy,
  _isReasoningReplayRejection,
} from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { _convertMessagesToResponsesInputForTest } from '../src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs';

const rs = (id) => ({ type: 'reasoning', id, encrypted_content: `enc_${id}`, summary: [] });
const user = (text) => ({ role: 'user', content: [{ type: 'input_text', text }] });

test('virgin chain locks to strip: first frame has no reasoning, later frames stripped', () => {
  const entry = {};
  const first = { input: [user('hi')] };
  assert.equal(_applyReasoningReplayPolicy(entry, first), first);
  assert.equal(entry.replayReasoning, false);
  // Turn 2 on the same entry now carries retained reasoning — sticky strip.
  const second = { input: [user('hi'), rs('rs_a'), user('again')] };
  const out = _applyReasoningReplayPolicy(entry, second);
  assert.deepEqual(out.input.map((i) => i.type ?? 'message'), ['message', 'message']);
  // Original body is never mutated.
  assert.equal(second.input.length, 3);
});

test('fresh entry with retained reasoning = recovery: replay kept and sticky', () => {
  const entry = {};
  const body = { input: [user('hi'), rs('rs_a'), user('again')] };
  assert.equal(_applyReasoningReplayPolicy(entry, body), body);
  assert.equal(entry.replayReasoning, true);
  // Later frames on the recovered chain keep including reasoning (append-only).
  const next = { input: [user('hi'), rs('rs_a'), user('again'), rs('rs_b')] };
  assert.equal(_applyReasoningReplayPolicy(entry, next), next);
});

test('entry with prior chain state strips replayed reasoning', () => {
  for (const state of [{ lastResponseId: 'resp_1' }, { lastRequestInput: [] }]) {
    const entry = { lastResponseId: null, lastRequestInput: null, ...state };
    const body = { input: [rs('rs_a'), user('again')] };
    const out = _applyReasoningReplayPolicy(entry, body);
    assert.equal(entry.replayReasoning, false);
    assert.deepEqual(out.input.map((i) => i.type ?? 'message'), ['message']);
  }
});

test('suppress forces strip even on a fresh recovery entry', () => {
  const entry = {};
  const body = { input: [rs('rs_a'), user('again')] };
  const out = _applyReasoningReplayPolicy(entry, body, { suppress: true });
  assert.equal(entry.replayReasoning, false);
  assert.deepEqual(out.input.map((i) => i.type ?? 'message'), ['message']);
});

test('rejection matcher is narrow', () => {
  assert.equal(_isReasoningReplayRejection(new Error('Item rs_abc123 is a duplicate')), true);
  assert.equal(_isReasoningReplayRejection({ payload: { message: 'reasoning item already exists in session' } }), true);
  assert.equal(_isReasoningReplayRejection(new Error('Our servers are currently overloaded. Please try again later.')), false);
  assert.equal(_isReasoningReplayRejection(new Error('handshake closed before open (code=1006)')), false);
  assert.equal(_isReasoningReplayRejection(null), false);
});

test('converter replays collector-shaped (untagged) reasoning items', () => {
  const messages = [
    { role: 'user', content: 'q1' },
    {
      role: 'assistant',
      content: 'a1',
      // Exact WS/HTTP collector shape: no `type` tag on retained items.
      reasoningItems: [
        { id: 'rs_1', encrypted_content: 'enc1', summary: [] },
        { type: 'reasoning', id: 'rs_2', encrypted_content: 'enc2', summary: [] },
        { type: 'message', id: 'x', encrypted_content: 'nope' },
        { id: 'rs_3', encrypted_content: '' },
      ],
    },
    { role: 'user', content: 'q2' },
  ];
  const replayed = _convertMessagesToResponsesInputForTest(messages, { replayEncryptedReasoning: true });
  const rsItems = replayed.filter((i) => i.type === 'reasoning');
  assert.deepEqual(rsItems.map((i) => i.id), ['rs_1', 'rs_2']);
  assert.deepEqual(rsItems.map((i) => i.encrypted_content), ['enc1', 'enc2']);
  // Flag off: no reasoning items on the wire (today's default).
  const plain = _convertMessagesToResponsesInputForTest(messages, {});
  assert.equal(plain.some((i) => i.type === 'reasoning'), false);
});
