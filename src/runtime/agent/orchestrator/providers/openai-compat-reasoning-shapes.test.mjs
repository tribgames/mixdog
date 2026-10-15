import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';
import { toOpenAIMessages } from './openai-compat-wire.mjs';
import { sendCompatChat } from './openai-compat-chat-send.mjs';
import { deepSeekEffortProjection } from './deepseek.mjs';
import { compatReasoningShape } from './openai-compat-reasoning-field.mjs';

const shapeOf = (baseURL, extra = {}) => compatReasoningShape({ baseURL, ...extra });

async function* chunks(values) {
  yield* values;
}

const delta = (d, finish_reason = null) => ({ model: 'm', choices: [{ delta: d, finish_reason }] });

function providerFor(name, baseURL, streams) {
  const provider = new OpenAICompatProvider(name, { apiKey: 'fixture', baseURL, preconnect: false });
  const requests = [];
  provider.client = {
    chat: {
      completions: {
        async create(params) {
          requests.push(structuredClone(params));
          return chunks(streams[Math.min(requests.length, streams.length) - 1]);
        },
      },
    },
  };
  return { provider, requests };
}

const together = (streams) => providerFor('custom-together', 'https://api.together.xyz/v1', streams);
const mistral = (streams) => providerFor('custom-mistral', 'https://api.mistral.ai/v1', streams);
const user = [{ role: 'user', content: 'hi' }];

// --- Together AI -----------------------------------------------------------

test('Together streaming captures `reasoning` and records the field for replay', async () => {
  const { provider } = together([
    [delta({ reasoning: 'think ' }), delta({ reasoning: 'hard' }), delta({ content: 'answer' }, 'stop')],
  ]);
  const result = await provider.send(user, 'deepseek-ai/DeepSeek-V4-Pro-0813', [], {});
  assert.equal(result.content, 'answer');
  assert.equal(result.reasoningContent, 'think hard');
  assert.deepEqual(result.providerMetadata, { openaiCompat: { reasoningField: 'reasoning' } });
});

test('Together streaming captures `reasoning_content` without extra metadata', async () => {
  const { provider } = together([[delta({ reasoning_content: 'why' }), delta({ content: 'ok' }, 'stop')]]);
  const result = await provider.send(user, 'moonshotai/Kimi-K3', [], {});
  assert.equal(result.reasoningContent, 'why');
  assert.equal(result.providerMetadata, undefined);
});

test('Together replays reasoning under the key it arrived on', async () => {
  const { provider, requests } = together([
    [delta({ reasoning: 'r1' }), delta({ content: 'a1' }, 'stop')],
    [delta({ content: 'a2' }, 'stop')],
  ]);
  const first = await provider.send(user, 'm', [], {});
  const history = [
    ...user,
    {
      role: 'assistant',
      content: first.content,
      reasoningContent: first.reasoningContent,
      providerMetadata: first.providerMetadata,
    },
    { role: 'user', content: 'again' },
  ];
  await provider.send(history, 'm', [], {});
  const assistant = requests[1].messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.reasoning, 'r1');
  assert.equal(Object.hasOwn(assistant, 'reasoning_content'), false);

  const replay = toOpenAIMessages(
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', reasoningContent: 'r2' },
    ],
    'custom-together',
    { reasoningShape: shapeOf('https://api.together.xyz/v1') }
  );
  assert.equal(replay[1].reasoning_content, 'r2');
  assert.equal(Object.hasOwn(replay[1], 'reasoning'), false);
});

test('Together non-streaming recovery captures `reasoning`', async () => {
  const { provider } = together([[]]);
  const message = { role: 'assistant', content: 'done', reasoning: 'deep thought' };
  provider.client = {
    chat: {
      completions: {
        async create() {
          return { model: 'm', choices: [{ message, finish_reason: 'stop' }] };
        },
      },
    },
  };
  const assembled = await provider._recoverCompatNonStreaming({
    streamErr: Object.assign(new Error('unavailable'), { status: 503 }),
    params: { messages: [] },
    opts: {},
    signal: null,
    useModel: 'm',
  });
  const result = normalizeCompatChatResponse({
    providerName: provider.name,
    useModel: 'm',
    opts: {},
    assembled,
    reasoningShape: shapeOf('https://api.together.xyz/v1'),
  });
  assert.equal(result.content, 'done');
  assert.equal(result.reasoningContent, 'deep thought');
  assert.deepEqual(result.providerMetadata, { openaiCompat: { reasoningField: 'reasoning' } });
});

// --- Mistral typed content chunks ------------------------------------------

test('Mistral streaming parses typed chunk lists in order', async () => {
  const { provider } = mistral([
    [
      delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'think A' }] }] }),
      delta({
        content: [
          { type: 'thinking', thinking: [{ type: 'text', text: ' B' }] },
          { type: 'text', text: 'Hel' },
        ],
      }),
      delta({ content: 'lo' }, 'stop'),
    ],
  ]);
  const text = [];
  const result = await provider.send(user, 'mistral-medium-3-5', [], { onTextDelta: (t) => text.push(t) });
  assert.equal(result.content, 'Hello');
  assert.equal(result.reasoningContent, 'think A B');
  assert.deepEqual(text, ['Hel', 'lo']);
});

test('Mistral non-streaming recovery parses a typed chunk list', async () => {
  const { provider } = mistral([[]]);
  provider.client = {
    chat: {
      completions: {
        async create() {
          return {
            model: 'm',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'thinking', thinking: [{ type: 'text', text: 'ponder' }] },
                    { type: 'text', text: 'final ' },
                    { type: 'text', text: 'answer' },
                  ],
                },
                finish_reason: 'stop',
              },
            ],
          };
        },
      },
    },
  };
  const assembled = await provider._recoverCompatNonStreaming({
    streamErr: Object.assign(new Error('unavailable'), { status: 503 }),
    params: { messages: [] },
    opts: {},
    signal: null,
    useModel: 'm',
  });
  const result = normalizeCompatChatResponse({
    providerName: provider.name,
    useModel: 'm',
    opts: {},
    assembled,
  });
  assert.equal(result.content, 'final answer');
  assert.equal(result.reasoningContent, 'ponder');
});

// --- Regression: plain string content + existing reasoning fields ----------

test('plain string content and reasoning_content parse and replay exactly as before', async () => {
  const { provider, requests } = providerFor('deepseek', 'https://api.deepseek.com', [
    [delta({ reasoning_content: 'r' }), delta({ content: 'a' }, 'stop')],
  ]);
  const result = await provider.send(
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'prev', reasoningContent: 'pr', providerMetadata: { openaiCompat: { reasoningField: 'reasoning' } } },
      { role: 'user', content: 'next' },
    ],
    'deepseek-v4-pro',
    [],
    {}
  );
  assert.equal(result.content, 'a');
  assert.equal(result.reasoningContent, 'r');
  assert.equal(result.providerMetadata, undefined);
  assert.deepEqual(requests[0].messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'prev', reasoning_content: 'pr' },
    { role: 'user', content: 'next' },
  ]);
});

test('non-Together custom endpoints keep ignoring the `reasoning` alias in results and requests', async () => {
  const { provider, requests } = providerFor('custom-other', 'https://llm.example.com/v1', [
    [delta({ reasoning: 'alias' }), delta({ content: 'a' }, 'stop')],
  ]);
  const result = await provider.send(
    [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'prev', reasoningContent: 'pr' },
      { role: 'user', content: 'next' },
    ],
    'm',
    [],
    {}
  );
  assert.equal(result.content, 'a');
  assert.equal(result.reasoningContent, undefined);
  assert.equal(result.providerMetadata, undefined);
  assert.deepEqual(requests[0].messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'prev' },
    { role: 'user', content: 'next' },
  ]);
});

// --- Resend per endpoint family ---------------------------------------------

const history = (message) => [
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a', ...message },
  { role: 'user', content: 'next' },
];

test('Mistral replays thinking as a leading chunk of the assistant content', () => {
  const out = toOpenAIMessages(
    history({ reasoningContent: 'ponder', providerMetadata: { openaiCompat: { reasoningField: 'content_chunks' } } }),
    'custom-mistral',
    { reasoningShape: shapeOf('https://api.mistral.ai/v1') }
  );
  assert.deepEqual(out[1].content, [
    { type: 'thinking', thinking: [{ type: 'text', text: 'ponder' }] },
    { type: 'text', text: 'a' },
  ]);
  assert.equal(Object.hasOwn(out[1], 'reasoning_content'), false);
  // Reasoning that did not arrive as thinking chunks is not invented into content.
  const plain = toOpenAIMessages(history({ reasoningContent: 'x' }), 'custom-mistral', {
    reasoningShape: shapeOf('https://api.mistral.ai/v1'),
  });
  assert.equal(plain[1].content, 'a');
});

test('Mistral streaming result records the chunk source for replay', async () => {
  const { provider } = mistral([
    [delta({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 't' }] }] }), delta({ content: 'x' }, 'stop')],
  ]);
  const result = await provider.send(user, 'mistral-medium-3-5', [], {});
  assert.deepEqual(result.providerMetadata, { openaiCompat: { reasoningField: 'content_chunks' } });
});

test('Groq reads `reasoning` and never echoes it; vLLM reads and echoes `reasoning`', async () => {
  const groq = providerFor('custom-groq', 'https://api.groq.com/openai/v1', [
    [delta({ reasoning: 'g' }), delta({ content: 'a' }, 'stop')],
  ]);
  const r = await groq.provider.send(user, 'openai/gpt-oss-20b', [], {});
  assert.equal(r.reasoningContent, 'g');
  const out = toOpenAIMessages(history({ reasoningContent: 'g', providerMetadata: r.providerMetadata }), 'custom-groq', {
    reasoningShape: shapeOf('https://api.groq.com/openai/v1'),
  });
  assert.equal(Object.hasOwn(out[1], 'reasoning'), false);
  assert.equal(Object.hasOwn(out[1], 'reasoning_content'), false);

  const vllmShape = compatReasoningShape({ wireFormat: 'vllm' });
  const echoed = toOpenAIMessages(
    history({ reasoningContent: 'v', providerMetadata: { openaiCompat: { reasoningField: 'reasoning' } } }),
    'custom-vllm',
    { reasoningShape: vllmShape }
  );
  assert.equal(echoed[1].reasoning, 'v');
  const legacy = toOpenAIMessages(history({ reasoningContent: 'v' }), 'custom-vllm', { reasoningShape: vllmShape });
  assert.equal(legacy[1].reasoning_content, 'v');
});

test('OpenRouter keeps text reasoning; reasoning_details replace it when present', async () => {
  const { provider } = providerFor('openrouter', 'https://openrouter.ai/api/v1', [
    [delta({ reasoning: 'or text' }), delta({ content: 'a' }, 'stop')],
  ]);
  const result = await provider.send(user, 'x/y', [], {});
  assert.equal(result.reasoningContent, 'or text');
  const shape = compatReasoningShape({ providerName: 'openrouter' });
  const text = toOpenAIMessages(history({ reasoningContent: 'or text' }), 'openrouter', { reasoningShape: shape });
  assert.equal(text[1].reasoning, 'or text');
  const details = [{ type: 'reasoning.text', text: 'd' }];
  const both = toOpenAIMessages(
    history({ reasoningContent: 'or text', providerMetadata: { openrouter: { reasoning_details: details } } }),
    'openrouter',
    { reasoningShape: shape }
  );
  assert.deepEqual(both[1].reasoning_details, details);
  assert.equal(Object.hasOwn(both[1], 'reasoning'), false);
});

test('developer role maps to system unless the endpoint documents it', () => {
  const msgs = [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }];
  assert.equal(toOpenAIMessages(msgs, 'deepseek')[0].role, 'system');
  assert.equal(toOpenAIMessages(msgs, 'mimo-oauth', { developerRole: true })[0].role, 'developer');
});

test('xAI Chat sends x-grok-conv-id and keeps caller headers; DeepSeek minimal maps to low', async () => {
  const seen = [];
  const { provider } = providerFor('xai', 'https://api.x.ai/v1', [[delta({ content: 'a' }, 'stop')]]);
  const create = provider.client.chat.completions.create;
  provider.client.chat.completions.create = async (params, options) => {
    seen.push(options?.headers);
    return create(params, options);
  };
  await sendCompatChat(provider, user, 'grok-4.5', [], { sessionId: 's1', requestHeaders: { 'x-extra': '1' } });
  assert.match(seen[0]['x-grok-conv-id'], /^[0-9a-f-]{36}$/);
  assert.equal(seen[0]['x-extra'], '1');

  const ds = providerFor('deepseek', 'https://api.deepseek.com', [[delta({ content: 'a' }, 'stop')]]);
  await ds.provider.send(user, 'deepseek-v4-pro', [], { effort: 'minimal' });
  assert.deepEqual(ds.requests[0].thinking, { type: 'enabled' });
  assert.equal(ds.requests[0].reasoning_effort, 'low');
});

test('DeepSeek Chat and Messages agree on the effort map (minimal→low, ultra→max)', async () => {
  for (const [effort, expected] of [
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'high'],
    ['xhigh', 'high'],
    ['max', 'max'],
    ['ultra', 'max'],
  ]) {
    const ds = providerFor('deepseek', 'https://api.deepseek.com', [[delta({ content: 'a' }, 'stop')]]);
    await ds.provider.send(user, 'deepseek-v4-pro', [], { effort });
    assert.equal(ds.requests[0].reasoning_effort, expected, `chat ${effort}`);
    const body = {};
    deepSeekEffortProjection(body, { effort });
    assert.equal(body.output_config.effort, expected, `messages ${effort}`);
  }
});
