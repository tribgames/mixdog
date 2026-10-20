import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessages } from './anthropic-request-utils.mjs';
import { convertMessagesToResponsesInput } from '../openai-responses-input.mjs';
import { toOpenAIMessages } from '../openai-compat-wire.mjs';
import { ANTHROPIC_TOOL_CALL_IDS, toolCallWireIdMap, withWireToolCallIds } from './tool-call-wire-ids.mjs';

const turn = (...ids) => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: ids.map((id) => ({ id, name: 'read', arguments: {} })) },
  ...ids.map((id) => ({ role: 'tool', toolCallId: id, content: `result ${id}` })),
];

const anthropicPairs = (messages) =>
  toAnthropicMessages(messages, [{ name: 'read' }], 'anthropic')
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => [b.type, b.id ?? b.tool_use_id]);

test('OpenAI-style ids reach Anthropic as valid ids, each call paired with its own result', () => {
  const pairs = anthropicPairs(turn('functions.read:0', 'call_ok'));
  for (const [, id] of pairs) assert.match(id, /^[A-Za-z0-9_-]+$/);
  const ids = pairs.map(([, id]) => id);
  // Call order then result order; a valid native id passes unchanged.
  assert.equal(ids[0], ids[2]);
  assert.equal(ids[1], 'call_ok');
  assert.equal(ids[3], 'call_ok');
  assert.notEqual(ids[0], 'functions.read:0');
});

test('two ids that clean to the same text stay distinct, and the mapping is stable across turns', () => {
  const messages = turn('functions.read:0', 'functions.read_0', 'functions/read:0');
  const pairs = anthropicPairs(messages);
  const callIds = pairs.filter(([type]) => type === 'tool_use').map(([, id]) => id);
  assert.equal(new Set(callIds).size, 3);
  // A later turn appends; the earlier ids project identically (same wire prefix).
  const later = [...messages, ...turn('call_2').slice(1)];
  const first = toolCallWireIdMap(messages, ANTHROPIC_TOOL_CALL_IDS);
  const second = toolCallWireIdMap(later, ANTHROPIC_TOOL_CALL_IDS);
  for (const [id, wire] of first) assert.equal(second.get(id), wire);
  // A stand-in never takes an id another call already owns.
  const taken = [...first.values()][0];
  const clash = toolCallWireIdMap(turn('functions.read:0', taken), ANTHROPIC_TOOL_CALL_IDS);
  assert.notEqual(clash.get('functions.read:0'), taken);
});

test('Gemini ids reach OpenAI within its id rules, paired', () => {
  const geminiId = `gemini/${'x'.repeat(80)}#1`;
  const input = convertMessagesToResponsesInput(turn(geminiId, 'gemini_abc'));
  const items = input.filter((item) => item.type === 'function_call' || item.type === 'function_call_output');
  const [call, , output] = items;
  assert.equal(call.call_id, output.call_id);
  assert.ok(call.call_id.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(call.call_id));
  assert.equal(items[1].call_id, 'gemini_abc');
  const chat = toOpenAIMessages(turn(geminiId), 'openai');
  const chatCall = chat.find((m) => m.tool_calls)?.tool_calls[0].id;
  assert.ok(chatCall.length <= 40);
  assert.equal(chat.find((m) => m.role === 'tool').tool_call_id, chatCall);
});

test('history is never rewritten: an all-valid transcript is the same array', () => {
  const messages = turn('toolu_1');
  assert.equal(withWireToolCallIds(messages, ANTHROPIC_TOOL_CALL_IDS), messages);
  const foreign = turn('functions.read:0');
  withWireToolCallIds(foreign, ANTHROPIC_TOOL_CALL_IDS);
  assert.equal(foreign[1].toolCalls[0].id, 'functions.read:0');
});
