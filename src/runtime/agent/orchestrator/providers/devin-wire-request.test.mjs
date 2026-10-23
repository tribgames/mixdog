import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVIN_ENUMS, decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import {
  DEVIN_ASSISTANT_SOURCE,
  DEVIN_REPLAY_ITEM_TYPE,
  buildDevinChatRequest,
  devinDeterministicUuid,
  devinHistoryBytes,
  normalizeDevinToolCallId,
  responsesCallComponent,
} from './devin-wire-request.mjs';
import { devinDemotedThinking, devinModelClass, isDevinGeminiModel } from './devin-wire-identity.mjs';
import { devinGoogleToolSchema, devinToolWireSchema } from './devin-wire-schema.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

const { ChatMessageSource } = DEVIN_ENUMS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WIRE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PNG = Buffer.from('fake-png').toString('base64');

const visionRow = { id: 'm-vision', supportsVision: true, supportsParallelToolCalls: true, maxOutputTokens: 8000 };
const textRow = { id: 'm-text', supportsVision: false, supportsParallelToolCalls: false, maxOutputTokens: 4000 };

// The request as the server sees it: encoded with the strict codec and decoded back.
function build(messages, options = {}) {
  const { request, activeTail } = buildDevinChatRequest(messages, {
    model: 'm-text',
    modelRow: textRow,
    metadata: { apiKey: 'k', userJwt: 'j' },
    cascadeId: 'cascade-1',
    executionId: 'exec-1',
    ...options,
  });
  return {
    wire: decodeDevinMessage('GetChatMessageRequest', encodeDevinMessage('GetChatMessageRequest', request)),
    request,
    activeTail,
  };
}

function devinReplay(model, extra = {}) {
  return createProviderReplay('devin-oauth', [{ type: DEVIN_REPLAY_ITEM_TYPE, model, ...extra }]);
}

test('request envelope matches the native CLI', () => {
  const { wire } = build(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'x' },
    ],
    { maxOutputTokens: 100_000 }
  );
  assert.equal(wire.prompt, 'S');
  assert.equal(wire.requestType, DEVIN_ENUMS.ChatMessageRequestType.CASCADE);
  assert.equal(wire.plannerMode, DEVIN_ENUMS.ConversationalPlannerMode.DEFAULT);
  assert.deepEqual(wire.toolChoice, { optionName: 'auto' });
  assert.equal(wire.systemPromptCacheOptions.type, DEVIN_ENUMS.CacheControlType.EPHEMERAL);
  assert.equal(wire.chatModelUid, 'm-text');
  assert.equal(wire.chatModelName, undefined);
  assert.equal(wire.promptId, undefined);
  assert.equal(wire.cascadeId, 'cascade-1');
  assert.equal(wire.executionId, 'exec-1');
  assert.equal(wire.disableParallelToolCalls, true);
  // uint64 fields decode as bigint.
  assert.deepEqual(wire.configuration, {
    numCompletions: 1n,
    maxTokens: 100_000n,
    maxNewlines: 400n,
    temperature: 1,
    topK: 40n,
    topP: Math.fround(0.95),
  });
  assert.equal(build([{ role: 'user', content: 'x' }]).wire.configuration.maxTokens, 4000n, 'model default');
  const parallel = build([{ role: 'user', content: 'x' }], { model: 'm-vision', modelRow: visionRow }).wire;
  assert.equal(parallel.disableParallelToolCalls, undefined);
});

test('multi-turn history lowers to USER / assistant (SYSTEM channel) / TOOL prompts', () => {
  const { wire } = build([
    { role: 'system', content: 'You are Mixdog.' },
    { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'read ' },
        { type: 'text', text: 'a.ts' },
      ],
    },
    {
      role: 'assistant',
      content: 'Reading.',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.ts' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: 'contents' },
    { role: 'developer', content: 'note' },
    { role: 'user', content: 'thanks' },
  ]);
  assert.equal(wire.prompt, 'You are Mixdog.\n\nBe brief.');
  assert.equal(DEVIN_ASSISTANT_SOURCE, ChatMessageSource.SYSTEM);
  const prompts = wire.chatMessagePrompts;
  assert.deepEqual(
    prompts.map((p) => [p.source, p.prompt]),
    [
      [ChatMessageSource.USER, 'read a.ts'],
      [ChatMessageSource.SYSTEM, 'Reading.'],
      [ChatMessageSource.TOOL, 'contents'],
      [ChatMessageSource.USER, 'note'],
      [ChatMessageSource.USER, 'thanks'],
    ]
  );
  assert.deepEqual(prompts[1].toolCalls, [{ id: 'call_1', name: 'read', argumentsJson: '{"path":"a.ts"}' }]);
  assert.equal(prompts[2].toolCallId, 'call_1');
  assert.equal(prompts[0].messageId, devinDeterministicUuid('cascade-1\u00000\u0000user'));
  assert.equal(prompts[1].messageId, devinDeterministicUuid('cascade-1\u00001\u0000assistant'));
  assert.equal(prompts[2].messageId, devinDeterministicUuid('cascade-1\u00002\u0000tool\u0000call_1'));
  for (const prompt of prompts) assert.match(prompt.messageId, UUID_RE);
});

test('foreign tool-call ids are normalized and capped; collisions and repeats get _dupN', () => {
  const longId = `toolu_${'x'.repeat(60)}`;
  const { wire } = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: longId, name: 'read', arguments: { path: 'a' } },
        { id: 'call_A|first', name: 'read', arguments: { path: 'b' } },
        { id: 'call_A|second', name: 'read', arguments: { path: 'c' } },
        { id: 'call_A_first', name: 'read', arguments: { path: 'd' } },
      ],
    },
    { role: 'tool', toolCallId: longId, content: 'A' },
    { role: 'tool', toolCallId: 'call_A|first', content: 'B' },
    { role: 'tool', toolCallId: 'call_A|second', content: 'C' },
    { role: 'tool', toolCallId: 'call_A_first', content: 'D' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_A|second', name: 'read', arguments: {} }] },
    { role: 'tool', toolCallId: 'call_A|second', content: 'E' },
  ]);
  const [, call, r1, r2, r3, r4, again, r5] = wire.chatMessagePrompts;
  const ids = call.toolCalls.map((c) => c.id);
  assert.deepEqual(ids, [longId.slice(0, 40), 'call_A_first', 'call_A_second', 'call_A_first_dup1']);
  for (const id of ids) assert.match(id, WIRE_ID_RE);
  assert.deepEqual(
    [r1, r2, r3, r4].map((r) => [r.toolCallId, r.prompt]),
    ids.map((id, i) => [id, 'ABCD'[i]])
  );
  assert.equal(again.toolCalls[0].id, 'call_A_second_dup1');
  assert.deepEqual([r5.toolCallId, r5.prompt], ['call_A_second_dup1', 'E']);
  assert.equal(normalizeDevinToolCallId('a.b:c'), 'a_b_c');
});

test('a Responses-origin composite id keeps its call_id; other origins keep every segment', () => {
  for (const owner of ['openai-responses', 'xai-responses', 'compat-responses:opencode-go']) {
    const { wire } = build([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        providerReplay: createProviderReplay(owner, [{ type: 'function_call', call_id: 'call_a', id: 'item_b' }]),
        toolCalls: [
          { id: 'call_a|item_b', name: 'read', arguments: {} },
          { id: 'call_c', name: 'read', arguments: {} },
          { id: '|item_only', name: 'read', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: 'call_a|item_b', content: 'A' },
      // A result naming the bare call_id pairs with the composite call.
      { role: 'tool', toolCallId: 'call_c', content: 'C' },
      { role: 'tool', toolCallId: '|item_only', content: 'I' },
    ]);
    const [, call, ...results] = wire.chatMessagePrompts;
    assert.deepEqual(
      call.toolCalls.map((c) => c.id),
      ['call_a', 'call_c', '_item_only'],
      owner
    );
    assert.deepEqual(
      results.map((r) => [r.toolCallId, r.prompt]),
      [
        ['call_a', 'A'],
        ['call_c', 'C'],
        ['_item_only', 'I'],
      ]
    );
  }
  const bare = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]),
      toolCalls: [{ id: 'call_x|fc_1', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_x', content: 'X' },
  ]).wire.chatMessagePrompts;
  assert.deepEqual([bare[1].toolCalls[0].id, bare[2].toolCallId, bare[2].prompt], ['call_x', 'call_x', 'X']);
  const chat = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]),
      toolCalls: [{ id: 'call_a|item_b', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_a|item_b', content: 'A' },
  ]).wire.chatMessagePrompts;
  assert.deepEqual([chat[1].toolCalls[0].id, chat[2].toolCallId], ['call_a_item_b', 'call_a_item_b']);
  assert.equal(responsesCallComponent('call_a|item_b'), 'call_a');
  assert.equal(responsesCallComponent('|item_b'), '|item_b');
});

test('a composite result pairs with a plain Responses call; opaque composite ids stay distinct', () => {
  const { wire } = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]),
      toolCalls: [{ id: 'call_A', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_A|fc_9', content: 'A' },
    { role: 'user', content: 'next' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]),
      toolCalls: [
        { id: 'tok|1', name: 'read', arguments: {} },
        { id: 'tok|2', name: 'read', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'tok|2', content: 'two' },
    { role: 'tool', toolCallId: 'tok|1', content: 'one' },
  ]);
  assert.deepEqual(promptRows(wire), [
    [ChatMessageSource.USER, '', 'go', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'call_A', 'A', false],
    [ChatMessageSource.USER, '', 'next', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'tok_2', 'two', false],
    [ChatMessageSource.TOOL, 'tok_1', 'one', false],
  ]);
});

test('an opaque composite id never collapses onto an earlier Responses call_id', () => {
  const { wire } = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]),
      toolCalls: [{ id: 'call_A', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_A', content: 'first' },
    { role: 'user', content: 'again' },
    {
      role: 'assistant',
      content: '',
      providerReplay: devinReplay('m-text'),
      toolCalls: [{ id: 'call_A|opaque', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_A|opaque', content: 'second' },
    { role: 'user', content: 'more' },
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]),
      toolCalls: [{ id: 'call_A|other', name: 'read', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'call_A|other', content: 'third' },
  ]);
  assert.deepEqual(promptRows(wire), [
    [ChatMessageSource.USER, '', 'go', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'call_A', 'first', false],
    [ChatMessageSource.USER, '', 'again', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'call_A|opaque', 'second', false],
    [ChatMessageSource.USER, '', 'more', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'call_A_other', 'third', false],
  ]);
  assert.equal(wire.chatMessagePrompts[4].toolCalls[0].id, 'call_A|opaque');
  assert.equal(wire.chatMessagePrompts[7].toolCalls[0].id, 'call_A_other');
});

test('foreign reasoning from any Mixdog representation is demoted, never replayed with its signature', () => {
  const turn = (extra) => [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'answer', ...extra },
    { role: 'user', content: 'q2' },
  ];
  const cases = [
    [{ reasoningContent: 'compat reasoning' }, '<think>\ncompat reasoning\n</think>\nanswer'],
    [
      {
        providerReplay: createProviderReplay('anthropic', [
          { type: 'thinking', thinking: 'first', signature: 'anthropic-sig' },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'thinking', thinking: 'second', signature: 'sig-2' },
          { type: 'text', text: 'answer' },
        ]),
      },
      '<think>\nfirst\n</think>\n<think>\nsecond\n</think>\nanswer',
    ],
    [
      {
        providerReplay: createProviderReplay('gemini', [
          { thought: true, text: 'gemini thought', thoughtSignature: 'g-sig' },
          { text: 'answer' },
        ]),
      },
      '<think>\ngemini thought\n</think>\nanswer',
    ],
    [
      {
        providerReplay: createProviderReplay('openai-responses', [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'enc' },
        ]),
      },
      '<think>\nsummary\n</think>\nanswer',
    ],
    [{ reasoningContent: '   ' }, 'answer'],
  ];
  for (const [extra, expected] of cases) {
    const prompt = build(turn(extra), { model: 'gpt-y' }).wire.chatMessagePrompts[1];
    assert.equal(prompt.prompt, expected);
    assert.equal(prompt.thinking, undefined);
    assert.equal(prompt.signature, undefined);
  }
  // Standalone Anthropic shapes kept on the message (no provider replay).
  const standalone = [
    [{ thinkingBlocks: [{ type: 'thinking', thinking: 'trace', signature: 's' }] }, '<think>\ntrace\n</think>\nanswer'],
    [
      {
        assistantBlocks: [
          { type: 'thinking', thinking: 'a1', signature: 's1' },
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'a2', signature: 's2' },
        ],
      },
      '<think>\na1\n</think>\n<think>\na2\n</think>\nanswer',
    ],
    [
      {
        reasoningItems: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'rs' }], encrypted_content: 'e' },
        ],
      },
      '<think>\nrs\n</think>\nanswer',
    ],
    // One trace in several representations is demoted once.
    [
      {
        reasoningContent: 'same trace',
        thinkingBlocks: [{ type: 'thinking', thinking: 'same trace', signature: 's' }],
        assistantBlocks: [{ type: 'thinking', thinking: 'same trace', signature: 's' }],
      },
      '<think>\nsame trace\n</think>\nanswer',
    ],
    [
      {
        assistantBlocks: [{ type: 'redacted_thinking', data: 'x' }],
        thinkingBlocks: [{ type: 'thinking', thinking: 'fallback' }],
      },
      '<think>\nfallback\n</think>\nanswer',
    ],
    // Ordered blocks win over a flattened or partial reasoningContent.
    [
      {
        reasoningContent: 'first',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'first' },
          { type: 'thinking', thinking: 'second' },
        ],
      },
      '<think>\nfirst\n</think>\n<think>\nsecond\n</think>\nanswer',
    ],
  ];
  for (const [extra, expected] of standalone) {
    const prompt = build(turn(extra), { model: 'gpt-y' }).wire.chatMessagePrompts[1];
    assert.equal(prompt.prompt, expected);
    assert.equal(prompt.signature, undefined);
    assert.equal(prompt.thinking, undefined);
  }
  const claude = build(turn({ reasoningContent: 'plain  ' }), { model: 'claude-x' }).wire.chatMessagePrompts[1];
  assert.equal(claude.prompt, 'plain  \nanswer');
});

test('a same-model turn keeps its tool-call ids verbatim', () => {
  const longId = `devin_${'y'.repeat(50)}`;
  const { wire } = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: longId, name: 'read', arguments: {} }],
      providerReplay: devinReplay('m-text', { messageId: 'bot-1' }),
    },
    { role: 'tool', toolCallId: longId, content: 'A' },
  ]);
  assert.equal(wire.chatMessagePrompts[1].toolCalls[0].id, longId);
  assert.equal(wire.chatMessagePrompts[2].toolCallId, longId);
});

const promptRows = (wire) =>
  wire.chatMessagePrompts.map((p) => [p.source, p.toolCallId || '', p.prompt || '', p.toolResultIsError === true]);

test('an unanswered tool call gets an error result; an orphan result becomes a stale-result note', () => {
  const { wire } = build([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] },
    { role: 'user', content: 'continue' },
    { role: 'tool', toolCallId: 'ghost', toolName: 'grep', content: 'late', isError: true },
    { role: 'tool', toolCallId: 'blank', toolName: 'grep', content: '  ' },
  ]);
  assert.deepEqual(promptRows(wire), [
    [ChatMessageSource.USER, '', 'go', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'c1', 'No result provided', true],
    [ChatMessageSource.USER, '', 'continue', false],
    [
      ChatMessageSource.USER,
      '',
      '<stale-tool-result tool="grep" id="ghost" is-error="true">\nlate\n</stale-tool-result>',
      false,
    ],
  ]);
});

test('a misplaced tool result is pulled forward to its call; duplicates and in-window orphans are dropped', () => {
  const { wire } = build([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', name: 'x', arguments: {} },
        { id: 'b', name: 'x', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'a', content: 'A' },
    { role: 'tool', toolCallId: 'ghost', content: 'orphan inside the window' },
    { role: 'user', content: 'meanwhile' },
    { role: 'tool', toolCallId: 'b', content: 'B late' },
    { role: 'tool', toolCallId: 'a', content: 'A again' },
    { role: 'assistant', content: 'bye', stopReason: 'aborted', toolCalls: [{ id: 'z', name: 'x', arguments: {} }] },
    { role: 'user', content: 'next' },
  ]);
  assert.deepEqual(promptRows(wire), [
    [ChatMessageSource.USER, '', 'go', false],
    [ChatMessageSource.SYSTEM, '', '', false],
    [ChatMessageSource.TOOL, 'a', 'A', false],
    [ChatMessageSource.TOOL, 'b', 'B late', false],
    [ChatMessageSource.USER, '', 'meanwhile', false],
    [ChatMessageSource.SYSTEM, '', 'bye', false],
    [ChatMessageSource.TOOL, 'z', 'aborted', true],
    [ChatMessageSource.USER, '', 'next', false],
  ]);
});

test('thinking and signature replay natively for the same model; other models demote to text', () => {
  const history = [
    { role: 'user', content: 'q1' },
    {
      role: 'assistant',
      content: 'a1',
      providerReplay: devinReplay('claude-x', { messageId: 'bot-1', thinking: 'native reasoning', signature: 'sig-1' }),
    },
    { role: 'user', content: 'q2' },
    {
      role: 'assistant',
      content: 'a2',
      providerReplay: devinReplay('gpt-y', { messageId: 'bot-2', thinking: 'other', signature: 'sig-2' }),
    },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3', providerReplay: createProviderReplay('gemini', [{ thought: true }]) },
    { role: 'user', content: 'q4' },
  ];
  const prompts = build(history, { model: 'claude-x' }).wire.chatMessagePrompts;
  const [native, otherModel, otherProvider] = [prompts[1], prompts[3], prompts[5]];
  assert.equal(native.messageId, 'bot-1');
  assert.deepEqual([native.prompt, native.thinking, native.signature], ['a1', 'native reasoning', 'sig-1']);
  assert.equal(native.signatureType, undefined);
  assert.match(otherModel.messageId, UUID_RE);
  assert.deepEqual([otherModel.prompt, otherModel.thinking, otherModel.signature], ['other\na2', undefined, undefined]);
  assert.deepEqual([otherProvider.prompt, otherProvider.thinking], ['a3', undefined]);
  const gpt = build(history, { model: 'gpt-y' }).wire.chatMessagePrompts;
  assert.equal(gpt[1].prompt, '<think>\nnative reasoning\n</think>\na1');
  assert.equal(gpt[3].signature, 'sig-2');
  const gemini = build(history, { model: 'gemini-3-pro' }).wire.chatMessagePrompts;
  assert.equal(gemini[1].prompt, '```thinking\nnative reasoning\n```\na1');
  const swe = build(history, { model: 'swe-1-6' }).wire.chatMessagePrompts;
  assert.equal(swe[1].prompt, '<thinking>\nnative reasoning\n</thinking>\na1');
  // A demoted block with no visible text after it is trimmed, then line-ended.
  const bare = build(
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', providerReplay: devinReplay('gpt-y', { thinking: 'trailing  \n' }) },
      { role: 'user', content: 'q2' },
    ],
    { model: 'claude-x' }
  ).wire.chatMessagePrompts;
  assert.equal(bare[1].prompt, 'trailing\n');
});

test('model classes and demotion wrappers follow each model dialect', () => {
  const classes = [
    ['claude-sonnet-4-5', 'anthropic'],
    ['anthropic/claude-opus-4', 'anthropic'],
    ['gemini-3-pro-high', 'gemini'],
    ['gemma-3-27b', 'gemma'],
    ['gpt-5-codex', 'openai'],
    ['o3', 'openai'],
    ['o3-high', 'openai'],
    ['gpt-oss-120b', 'gpt-oss'],
    ['kimi-k2-thinking', 'kimi'],
    ['k3', 'kimi'],
    ['glm-4.6', 'glm'],
    ['qwen3-coder', 'qwen'],
    ['deepseek-r1-distill-qwen-32b', 'qwen'],
    ['deepseek-v3', 'deepseek'],
    ['minimax-m2', 'minimax'],
    ['grok-4', 'xai'],
    ['swe-1-6', 'unknown'],
    ['MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW', 'unknown'],
  ];
  for (const [id, cls] of classes) assert.equal(devinModelClass(id), cls, id);
  assert.equal(isDevinGeminiModel('adaptive', 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW'), true);
  assert.equal(isDevinGeminiModel('gemini-2.5-flash', 'x'), true);
  assert.equal(isDevinGeminiModel('claude-x', 'claude-x'), false);
  assert.equal(devinDemotedThinking('minimax-m2', '<thinking>\nr\n</thinking>'), '<thinking>\nr\n</thinking>');
  assert.equal(devinDemotedThinking('kimi-k2', 'r'), '<think>\nr\n</think>');
  assert.equal(devinDemotedThinking('claude-x', 'r '), 'r ');
  assert.equal(devinDemotedThinking('claude-x', ''), '');
});

test('images ride as ImageData only for a vision model; otherwise they degrade to text', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    },
    { role: 'assistant', content: '', toolCalls: [{ id: 's1', name: 'shot', arguments: {} }] },
    { role: 'tool', toolCallId: 's1', content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] },
  ];
  const vision = build(messages, { model: 'm-vision', modelRow: visionRow }).wire.chatMessagePrompts;
  assert.equal(vision[0].prompt, 'look');
  assert.deepEqual(vision[0].images, [{ base64Data: PNG, mimeType: 'image/png' }]);
  assert.deepEqual(vision[2].images, [{ base64Data: PNG, mimeType: 'image/jpeg' }]);

  const text = build(messages).wire.chatMessagePrompts;
  assert.equal(text[0].images, undefined);
  assert.match(text[0].prompt, /^look\[image omitted/);
  assert.equal(text[2].images, undefined);
  assert.match(text[2].prompt, /^\[image omitted/);
});

test('tool schemas go out as JSON schema strings, Google-normalized for Gemini models', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: ['number', 'null'] } },
    required: ['path'],
  };
  const tools = [{ name: 'read', description: 'Read a file', inputSchema: schema }];
  const plain = build([{ role: 'user', content: 'x' }], { tools }).wire.tools;
  assert.deepEqual(plain, [{ name: 'read', description: 'Read a file', jsonSchemaString: JSON.stringify(schema) }]);
  const strict = build([{ role: 'user', content: 'x' }], { tools: [{ ...tools[0], strict: true }] }).wire.tools;
  assert.equal(strict[0].strict, true);
  const gemini = build([{ role: 'user', content: 'x' }], { tools, model: 'gemini-3-pro' }).wire.tools;
  const projected = JSON.parse(gemini[0].jsonSchemaString);
  assert.deepEqual(projected.properties.limit, { type: 'number', nullable: true });
  assert.deepEqual(projected.required, ['path']);
  const routed = build([{ role: 'user', content: 'x' }], {
    tools,
    model: 'adaptive',
    chatModelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW',
  }).wire.tools;
  assert.equal(routed[0].jsonSchemaString, gemini[0].jsonSchemaString);
});

// Expected projections were produced by the reference schema pipeline.
test('tool schemas: draft upgrade on every wire, Google projection for Gemini', () => {
  const nullable = {
    type: 'object',
    properties: {
      a: { type: 'string', nullable: true, format: 'uri', minLength: 2 },
      b: { type: ['number', 'null'], minimum: 0, maximum: 9 },
      c: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'C' },
    },
    required: ['a'],
    additionalProperties: false,
  };
  assert.deepEqual(devinToolWireSchema(nullable).properties, {
    a: { type: ['string', 'null'], format: 'uri', minLength: 2 },
    b: { type: ['number', 'null'], minimum: 0, maximum: 9 },
    c: { description: 'C', type: ['integer', 'null'] },
  });
  assert.equal(
    JSON.stringify(devinGoogleToolSchema(devinToolWireSchema(nullable))),
    '{"type":"object","properties":{"a":{"type":"string","nullable":true,"description":"{format: \\"uri\\", minLength: 2}"},"b":{"type":"number","nullable":true,"description":"{minimum: 0, maximum: 9}"},"c":{"description":"C","type":"integer","nullable":true}},"required":["a"],"propertyOrdering":["a","b","c"]}'
  );
  const unions = {
    type: 'object',
    properties: {
      mode: { anyOf: [{ const: 'fast' }, { const: 'slow' }] },
      level: { oneOf: [{ const: 1 }, { const: 2 }] },
      mixed: { anyOf: [{ const: 'x' }, { const: null }] },
      bare: { enum: ['p', 'q'] },
      nums: { enum: [1, 2, 3] },
    },
  };
  assert.equal(
    JSON.stringify(devinGoogleToolSchema(devinToolWireSchema(unions))),
    '{"type":"object","properties":{"mode":{"type":"string","enum":["fast","slow"]},"level":{"type":"number"},"mixed":{"type":"string","nullable":true},"bare":{"enum":["p","q"],"type":"string"},"nums":{"type":"number"}},"propertyOrdering":["mode","level","mixed","bare","nums"]}'
  );
  const shapes = {
    type: 'object',
    properties: {
      multi: { type: ['string', 'array', 'null'], items: { type: 'string' }, maxLength: 4, minItems: 2 },
      any: {},
      flag: true,
      never: false,
      map: {
        type: 'object',
        additionalProperties: { type: 'string' },
        patternProperties: { '^x': { type: 'number' } },
      },
    },
  };
  assert.equal(
    JSON.stringify(devinGoogleToolSchema(devinToolWireSchema(shapes))),
    '{"type":"object","properties":{"multi":{"nullable":true,"anyOf":[{"type":"string","description":"{maxLength: 4}"},{"type":"array","items":{"type":"string"},"description":"{minItems: 2}"}]},"any":{},"flag":{},"never":{"not":{}},"map":{"type":"object","properties":{}}},"propertyOrdering":["multi","any","flag","never","map"]}'
  );
  const refs = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: { Pt: { type: 'object', properties: { x: { type: 'number' } } } },
    properties: {
      p: { $ref: '#/definitions/Pt', description: 'point' },
      t: { type: 'array', items: [{ type: 'string' }] },
    },
  };
  const upgraded = devinToolWireSchema(refs);
  assert.equal(upgraded.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(upgraded.properties.p, { $ref: '#/$defs/Pt', description: 'point' });
  assert.deepEqual(upgraded.properties.t, { type: 'array', prefixItems: [{ type: 'string' }] });
  assert.deepEqual(devinGoogleToolSchema(upgraded).properties.p, {
    type: 'object',
    properties: { x: { type: 'number' } },
    description: 'point',
  });
});

test('the active turn is excluded from the compactable history size', () => {
  const big = 'h'.repeat(1000);
  const tail = build([
    { role: 'tool', toolCallId: 'x', content: big },
    { role: 'user', content: 'u'.repeat(5000) },
  ]);
  assert.equal(tail.activeTail, 1);
  assert.ok(devinHistoryBytes(tail.request, tail.activeTail) > 1000, 'an orphan result note is history');
  assert.ok(devinHistoryBytes(tail.request, tail.activeTail) < 2000, 'the prompt is active');
  const split = build([
    { role: 'user', content: big },
    { role: 'user', content: 'u' },
    { role: 'developer', content: 'd' },
  ]);
  assert.equal(split.activeTail, 3);
  const afterTool = build([
    { role: 'user', content: 'small' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'c', content: big },
  ]);
  assert.equal(afterTool.activeTail, 0);
  // An orphan result becomes a synthetic user note; the active tail still
  // follows the conversation's own roles, so the note stays compactable.
  const orphan = build([
    { role: 'user', content: 'small' },
    { role: 'tool', toolCallId: 'gone', toolName: 'read', content: 'o'.repeat(600 * 1024) },
  ]);
  assert.equal(orphan.activeTail, 0);
  assert.ok(devinHistoryBytes(orphan.request, orphan.activeTail) > 600 * 1024);
  assert.ok(devinHistoryBytes(afterTool.request, afterTool.activeTail) > 1000);
});
