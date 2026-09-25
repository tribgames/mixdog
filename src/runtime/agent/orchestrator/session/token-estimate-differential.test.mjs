// Differential contract for the allocation-free token meter: every estimate
// must be identical to the former regex/iterator implementation, and the
// per-message memo must never return a value a fresh meter would not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyTokenFloors } from '../../../../../scripts/perf/transcript-baseline.mjs';
import { estimateMessagesTokens, estimateMessageTokens } from './context-utils.mjs';
import { estimateTokens } from './token-estimate.mjs';

// Frozen copy of the former estimateTokens (for-of iteration + regex floors).
function legacyWeight(cp) {
  if (cp < 0x80) return 0.25;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 1.5;
  if (cp >= 0x1100 && cp <= 0x11ff) return 1.5;
  if (cp >= 0x3130 && cp <= 0x318f) return 1.5;
  if (cp >= 0xa960 && cp <= 0xa97f) return 1.5;
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return 1.5;
  if (cp >= 0x3040 && cp <= 0x30ff) return 1.2;
  if (cp >= 0x31f0 && cp <= 0x31ff) return 1.2;
  if (cp >= 0x3400 && cp <= 0x4dbf) return 1.2;
  if (cp >= 0x4e00 && cp <= 0x9fff) return 1.2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 1.2;
  if (cp >= 0x20000 && cp <= 0x2fa1f) return 1.2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2.0;
  if (cp >= 0x1f000 && cp <= 0x1faff) return 2.0;
  if (cp >= 0x2190 && cp <= 0x21ff) return 1.5;
  if (cp >= 0x2300 && cp <= 0x23ff) return 1.5;
  if (cp < 0x0400) return 0.6;
  return 0.8;
}
const raw = Number(process.env.MIXDOG_TOKEN_ESTIMATE_SAFETY_MULTIPLIER);
const legacyMultiplier = Number.isFinite(raw) ? Math.min(2.0, Math.max(1.0, raw)) : 1.0;
function legacyEstimateTokens(text) {
  const s = String(text ?? '');
  if (s.length === 0) return 0;
  let weighted = 0;
  for (const ch of s) weighted += legacyWeight(ch.codePointAt(0));
  return Math.ceil(Math.max(weighted, s.length / 4, legacyTokenFloors(s)) * legacyMultiplier);
}

let seed = 271828;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const pick = (list) => list[random() % list.length];

const ATOMS = [
  'hello ',
  'The estimator prices deltas. ',
  'abcdef12 ',
  'x_abc12345 ',
  'abc12345_',
  '0123456789',
  'deadbeefcafebabe',
  'aGVsbG8gd29ybGQ=',
  'A'.repeat(16),
  'B'.repeat(64),
  '{"level":"info","ok":true}',
  '[1,2]',
  '{',
  '}',
  '[',
  ']',
  ',',
  '"x":',
  '<|=>',
  '\\',
  '_',
  ' ',
  '\t',
  '\v',
  '\f',
  '\n',
  '\r',
  '\r\n',
  '\u2028',
  '\u2029',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u200a',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
  '\u180e',
  'é',
  'ж',
  'ع',
  '한글',
  'ᄀ',
  'ㄱ',
  'ꥠ',
  'ힰ',
  'あア',
  'ㇰ',
  '中文',
  '㐀',
  '豈',
  '𠀀',
  '😀',
  '👨‍👩‍👧',
  '☀',
  '→',
  '⌘',
  '\ud800',
  '\udc00',
  '\udbff\udfff',
  '\ud83d',
  '\x00',
  '\x7f',
];

function corpus() {
  const samples = ['', ' ', '\n\n\n', 'a\nb\nc', '{"x":1}\n{"x":2}\n{"x":3}', '[\r]\n[\u2028]\n{\u2029}'];
  for (let index = 0; index < 4000; index += 1) {
    samples.push(Array.from({ length: random() % 160 }, () => pick(ATOMS)).join(''));
  }
  // Very large strings: prose, Korean, base64, JSONL, and a mixed blob.
  const base64 = Buffer.from(Array.from({ length: 1_500_000 }, () => random() & 0xff)).toString('base64');
  samples.push(
    'The estimator only prices the delta appended since the provider usage baseline. '.repeat(20_000),
    '재영님, 토큰 추정기는 서버 usage 기준선 위에서 델타만 계산합니다. '.repeat(20_000),
    base64,
    '{"level":"info","msg":"tool finished","ms":12,"ok":true}\n'.repeat(30_000),
    Array.from({ length: 60_000 }, () => pick(ATOMS)).join('')
  );
  return samples;
}

test('estimateTokens is identical to the former regex/iterator meter', () => {
  for (const value of corpus()) {
    assert.equal(estimateTokens(value), legacyEstimateTokens(value), JSON.stringify(value.slice(0, 200)));
  }
  for (const value of [null, undefined, 0, 12345, true, { a: 1 }, ['x', 'y']]) {
    assert.equal(estimateTokens(value), legacyEstimateTokens(value));
  }
});

test('every UTF-16 code unit is classified exactly like the former meter', () => {
  for (let code = 0; code <= 0xffff; code += 1) {
    const ch = String.fromCharCode(code);
    const value = `a${ch}b\n[${ch}]\n{x${ch}},\n${ch}[1]${ch}\nabc${ch}1234567 abcd1234${ch} q1w2e3r4${ch}_${'Z'.repeat(20)}${ch}`;
    assert.equal(estimateTokens(value), legacyEstimateTokens(value), `code unit 0x${code.toString(16)}`);
  }
});

const LARGE = 'a1b2c3d4 {"k":"v"}\n'.repeat(40_000);
const OPAQUE = 'Zm9vYmFyYmF6'.repeat(200);

function messageShapes() {
  return [
    { role: 'system', content: '# Environment\nplatform: win32\n# Workflow\nDefault' },
    { role: 'user', content: 'plain question with 한글 and 😀' },
    { role: 'user', content: LARGE },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: OPAQUE }, width: 1280, height: 720 },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${OPAQUE}` } },
        { type: 'file', mimeType: 'application/pdf', data: OPAQUE, name: 'spec.pdf' },
      ],
    },
    {
      role: 'assistant',
      content: 'Reading the file.',
      toolCalls: [
        { id: 'call_1', name: 'read', arguments: { path: 'src/a.mjs', offset: 1 } },
        { id: 'call_2', name: 'grep', arguments: '{"pattern":"x"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: LARGE },
    { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'no matches' }] },
    {
      role: 'assistant',
      content: 'done',
      toolCalls: [{ id: 'call_3', name: 'shell', arguments: { command: 'node -v' } }],
      providerReplay: {
        items: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: OPAQUE, summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
          { type: 'function_call', call_id: 'call_3', name: 'shell', arguments: '{"command":"node -v"}' },
        ],
      },
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'thought through it' }],
      thinkingBlocks: [
        { type: 'thinking', thinking: 'step one, step two', signature: OPAQUE },
        { type: 'redacted_thinking', data: OPAQUE },
      ],
      assistantBlocks: [{ type: 'text', text: 'thought through it' }],
      reasoningItems: [{ type: 'reasoning', encrypted_content: OPAQUE }],
      providerMetadata: { gemini: { thoughtParts: [{ text: 'gemini thought', thought: true, thoughtSignature: OPAQUE }] } },
    },
    { role: 'assistant', content: null },
    { role: 'user', content: [{ type: 'text', text: 'dated' }], meta: { at: new Date(0) } },
    { role: 'user', content: [{ type: 'text', text: 'when', at: new Date(0) }] },
  ];
}

test('message meter is identical to the former meter on text, tool call and tool result shapes', () => {
  const toolCalls = [{ id: 'call_9', name: 'edit', arguments: { file: 'x.mjs', text: LARGE } }];
  const cases = [
    [{ role: 'user', content: LARGE }, LARGE],
    [{ role: 'user', content: '한국어 질문입니다 😀' }, '한국어 질문입니다 😀'],
    [{ role: 'tool', toolCallId: 'call_9', content: LARGE }, `${LARGE}\ncall_9`],
    [{ role: 'assistant', content: 'editing', toolCalls }, `editing\n${JSON.stringify(toolCalls)}`],
  ];
  for (const [message, text] of cases) {
    assert.equal(estimateMessageTokens(message), legacyEstimateTokens(text) + 4);
    assert.equal(estimateMessageTokens(message), legacyEstimateTokens(text) + 4, 'memoized repeat');
  }
});

test('memoized message meter always equals a fresh meter of the same data', () => {
  const messages = messageShapes();
  const fresh = (message) => estimateMessageTokens(structuredClone(message));
  const cold = messages.map(fresh);
  assert.deepEqual(messages.map(estimateMessageTokens), cold);
  assert.deepEqual(messages.map(estimateMessageTokens), cold, 'warm repeat');
  assert.equal(estimateMessagesTokens(messages), cold.reduce((sum, tokens) => sum + tokens, 0));
  for (const value of [null, undefined, 'text', 7]) assert.equal(estimateMessageTokens(value), estimateMessageTokens(value));

  const mutations = [
    // Restored tool arguments edited in place below an unchanged array.
    (list) => {
      list[4].toolCalls[0].arguments.path = `src/${'deep/'.repeat(400)}a.mjs`;
    },
    (list) => {
      list[4].toolCalls[1].arguments = '{"pattern":"changed and longer pattern"}';
    },
    // Streamed content: appended block, edited block text, replaced string.
    (list) => {
      list[3].content.push({ type: 'text', text: 'and one more thing' });
    },
    (list) => {
      list[6].content[0].text += ' after all';
    },
    (list) => {
      list[1].content = 'plain question with 한글 and 😀 (edited)';
    },
    // Same-length opaque payload swap and key reorder.
    (list) => {
      list[7].providerReplay.items[0].encrypted_content = 'a'.repeat(OPAQUE.length);
    },
    (list) => {
      const call = list[4].toolCalls[0];
      const { id } = call;
      delete call.id;
      call.id = id;
    },
    (list) => {
      list[8].providerMetadata.gemini.thoughtParts[0].text = 'a much longer gemini thought '.repeat(50);
    },
    (list) => {
      list[8].thinkingBlocks.pop();
    },
    (list) => {
      list[9].content = [{ type: 'text', text: 'now filled' }];
    },
    (list) => {
      list[11].content[0].at.setTime(Date.now());
    },
    (list) => {
      list[5].toolCallId = 'call_renamed';
    },
    (list) => {
      list[2].role = 'tool';
    },
  ];
  for (const mutate of mutations) {
    mutate(messages);
    assert.deepEqual(messages.map(estimateMessageTokens), messages.map(fresh), mutate.toString());
  }
  assert.ok(estimateMessageTokens(messages[4]) > cold[4], 'a longer in-place argument must re-meter');
});
