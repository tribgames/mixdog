import test from 'node:test';
import assert from 'node:assert/strict';
import { stripProviderReplayMessages } from './provider-replay.mjs';
import { createProviderReplay } from '../../providers/lib/provider-replay.mjs';
import { toAnthropicMessages } from '../../providers/lib/anthropic-request-utils.mjs';
import { convertMessagesToResponsesInput } from '../../providers/openai-responses-input.mjs';
import { toGeminiContents } from '../../providers/gemini-schema.mjs';

const call = (id, extra = {}) => ({ id, name: 'read', arguments: { path: 'a.txt' }, ...extra });
const result = (id) => ({ role: 'tool', toolCallId: id, content: 'file body' });
const prompt = { role: 'user', content: 'read a.txt then summarize' };

// One live turn per source provider: a tool call with its native replay state
// and the completed result.
const anthropicTurn = () => {
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'anthropic-sig' };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } };
  return [
    prompt,
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('toolu_1')],
      thinkingBlocks: [thinking],
      assistantBlocks: [thinking, toolUse],
      providerReplay: createProviderReplay('anthropic', [thinking, toolUse]),
    },
    result('toolu_1'),
  ];
};
const openaiTurn = () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'openai-enc', summary: [] };
  const fn = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' };
  return [
    prompt,
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('call_1')],
      reasoningItems: [reasoning],
      reasoningContent: 'plan',
      providerReplay: createProviderReplay('openai-responses', [reasoning, fn]),
    },
    result('call_1'),
  ];
};
const geminiTurn = () => [
  prompt,
  { role: 'assistant', content: '', toolCalls: [call('gem_1', { thoughtSignature: 'gemini-real-sig' })] },
  result('gem_1'),
];

const wire = (value) => JSON.stringify(value);

test('the stripped turn keeps every message, tool call and result, in order, without native state', () => {
  for (const turn of [anthropicTurn(), openaiTurn(), geminiTurn()]) {
    const stripped = stripProviderReplayMessages(turn);
    assert.equal(stripped.length, turn.length);
    assert.deepEqual(
      stripped.map((m) => [m.role, m.toolCalls?.map((c) => c.id) ?? m.toolCallId ?? null]),
      turn.map((m) => [m.role, m.toolCalls?.map((c) => c.id) ?? m.toolCallId ?? null])
    );
    assert.doesNotMatch(wire(stripped), /anthropic-sig|openai-enc|gemini-real-sig|providerReplay|reasoningContent/);
    // The source messages are untouched (replaced, never mutated).
    assert.match(wire(turn), /anthropic-sig|openai-enc|gemini-real-sig/);
  }
});

test('Anthropic thinking continues on OpenAI as a plain call/output pair with no reasoning', () => {
  const input = convertMessagesToResponsesInput(stripProviderReplayMessages(anthropicTurn()), {
    replayEncryptedReasoning: true,
  });
  assert.deepEqual(
    input.filter((item) => item.type).map((item) => [item.type, item.call_id]),
    [
      ['function_call', 'toolu_1'],
      ['function_call_output', 'toolu_1'],
    ]
  );
  assert.doesNotMatch(wire(input), /anthropic-sig|"thinking"/);
});

test('OpenAI reasoning continues on Anthropic as tool_use/tool_result with no thinking or encrypted items', () => {
  const messages = toAnthropicMessages(stripProviderReplayMessages(openaiTurn()), [{ name: 'read' }], 'anthropic');
  const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  assert.deepEqual(
    blocks.filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => [b.type, b.id ?? b.tool_use_id]),
    [
      ['tool_use', 'call_1'],
      ['tool_result', 'call_1'],
    ]
  );
  assert.equal(
    blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
    false
  );
  assert.doesNotMatch(wire(messages), /openai-enc/);
});

test('a Gemini signature never reaches another account; a Gemini target gets its own validator token', () => {
  const stripped = stripProviderReplayMessages(geminiTurn());
  assert.doesNotMatch(wire(toAnthropicMessages(stripped, [{ name: 'read' }], 'anthropic')), /gemini-real-sig/);
  // Same family behind another gateway: the foreign signature is not
  // replayed, the current turn's first call carries the bypass token.
  const contents = wire(toGeminiContents(stripped, 'gemini-3-pro'));
  assert.doesNotMatch(contents, /gemini-real-sig/);
  assert.match(contents, /skip_thought_signature_validator/);
  // Anthropic → Gemini likewise.
  assert.match(
    wire(toGeminiContents(stripProviderReplayMessages(anthropicTurn()), 'gemini-3-pro')),
    /functionResponse/
  );
});
