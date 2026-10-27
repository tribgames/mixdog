// A replay-carrying assistant is metered as max(est(base), est(visible replay))
// with each half estimated on its own: the estimator's minimum-cost floors apply
// to a joined string, so est(base + replay) - est(replay) overstates base.
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextMessagesSignature, estimateMessageTokens, messageReasoningBreakdown } from './context-utils.mjs';
import { estimateTokens } from './token-estimate.mjs';

const OVERHEAD = 4;
const toolCalls = [
  {
    id: 'call_1',
    name: 'edit',
    arguments: { file: 'src/a.mjs', old_string: 'abc12345_'.repeat(300), new_string: '{"k":[1,2,3]}\n'.repeat(200) },
  },
];
const items = [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Editing the file.' }] },
  { type: 'function_call', call_id: 'call_1', name: 'edit', arguments: JSON.stringify(toolCalls[0].arguments) },
];
const baseText = (content, calls) => `${content}\n${JSON.stringify(calls)}`;

test('assistant with text, tool calls and replay meters the max of the separately estimated parts', () => {
  const message = { role: 'assistant', content: 'Editing the file.', toolCalls, providerReplay: { items } };
  const base = estimateTokens(baseText(message.content, toolCalls));
  const replay = estimateTokens(items.map((item) => JSON.stringify(item)).join('\n'));
  assert.equal(estimateMessageTokens(message), Math.max(base, replay) + OVERHEAD);
  assert.equal(estimateMessageTokens(message), Math.max(base, replay) + OVERHEAD, 'memoized repeat');
});

test('replay larger than the base wins; base larger than the replay wins', () => {
  const small = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }];
  const baseWins = { role: 'assistant', content: 'x', toolCalls, providerReplay: { items: small } };
  assert.equal(
    estimateMessageTokens(baseWins),
    estimateTokens(baseText('x', toolCalls)) + OVERHEAD
  );
  const replayWins = { role: 'assistant', content: 'x', providerReplay: { items } };
  assert.equal(estimateMessageTokens(replayWins), estimateTokens(items.map((i) => JSON.stringify(i)).join('\n')) + OVERHEAD);
});

test('a replay-free message and an empty replay still meter the whole estimate text', () => {
  const plain = { role: 'assistant', content: 'Editing the file.', toolCalls };
  assert.equal(estimateMessageTokens(plain), estimateTokens(baseText(plain.content, toolCalls)) + OVERHEAD);
  const empty = { ...plain, providerReplay: { items: [] } };
  assert.equal(estimateMessageTokens(empty), estimateMessageTokens(plain));
});

test('reasoning split stays consistent with the total', () => {
  const thought = { type: 'thinking', thinking: 'plan '.repeat(80), signature: 'S'.repeat(400) };
  const message = {
    role: 'assistant',
    content: 'Editing the file.',
    toolCalls,
    providerReplay: { items: [thought, ...items] },
  };
  const reasoning = messageReasoningBreakdown(message);
  const visible = estimateMessageTokens(reasoning.message);
  assert.ok(reasoning.tokens > 0);
  assert.equal(reasoning.tokens + visible, estimateMessageTokens(message));
});

test('hash inputs are independent of metering', () => {
  const message = { role: 'assistant', content: 'Editing the file.', toolCalls, providerReplay: { items } };
  const before = contextMessagesSignature([message]);
  estimateMessageTokens(message);
  assert.equal(contextMessagesSignature([structuredClone(message)]), before);
});

const SIG = 'A1b2'.repeat(2500);
const SIG_TOKENS = Math.ceil(SIG.length / 3.43);

test('Anthropic signed thinking is priced by its own signature and text, not by neighbouring items', () => {
  const thinking = 'let me think '.repeat(50);
  const message = {
    role: 'assistant',
    content: '',
    providerReplay: {
      items: [
        { type: 'thinking', thinking, signature: SIG },
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        { type: 'text', text: 'x' },
      ],
    },
  };
  const { tokens } = messageReasoningBreakdown(message);
  const expected = SIG_TOKENS + estimateTokens(thinking);
  assert.ok(Math.abs(tokens - expected) <= expected * 0.05, `${tokens} vs ${expected}`);
  assert.ok(tokens <= estimateMessageTokens(message));
});

test('OpenAI encrypted reasoning is priced at the opaque-blob rate alongside other items', () => {
  const message = {
    role: 'assistant',
    content: '',
    providerReplay: {
      items: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: SIG },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    },
  };
  const { tokens } = messageReasoningBreakdown(message);
  assert.ok(Math.abs(tokens - SIG_TOKENS) <= SIG_TOKENS * 0.05, `${tokens} vs ${SIG_TOKENS}`);
});
