// The tail reminder (session/tail-reminder-rules.mjs) on every provider path that
// can serve Claude Opus 5.5: where the builder keeps a cache marker or per-message
// state, the reminder must sit after it and leave the history-derived prefix alone.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withTailReminder } from '../session/tail-reminder-rules.mjs';
import { withRuntimeUserContext } from '../session/runtime-user-context.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';
import { gatewayMessagesOpts } from './wire-gateway.mjs';
import { buildAntigravityRequest } from './antigravity-request.mjs';
import { sendCompatChat } from './openai-compat-chat-send.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { toOpenAIMessages } from './openai-compat-wire.mjs';
import { parseMessages } from './cursor-wire-request.mjs';

const KO = { id: 'ko', name: 'Korean' };
const MODEL = 'claude-opus-5-5';
const REMINDER = '<system-reminder>Write all user-facing text in Korean.</system-reminder>';
const TOOLS = [{ name: 't', description: 'A tool', inputSchema: { type: 'object', properties: {} } }];

const H1 = [
  { role: 'system', content: 'You are the Lead.' },
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 't', arguments: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'c1', content: 'English tool output' },
];
const H2 = [
  ...H1,
  { role: 'assistant', content: 'Editing.', toolCalls: [{ id: 'c2', name: 't', arguments: { path: 'b' } }] },
  { role: 'tool', toolCallId: 'c2', content: 'more English output' },
];
const withReminder = (history, model = MODEL) => withTailReminder(history, { session: {}, model }, KO);
const strip = (value) => JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v));
const marks = (messages) =>
  messages.flatMap((m, i) =>
    (Array.isArray(m.content) ? m.content : []).flatMap((b, j) => (b?.cache_control ? [[i, j]] : []))
  );

// --- Anthropic Messages engines: the shared builder behind every gateway ---

const GATEWAYS = {
  anthropic: { name: 'anthropic', model: MODEL, config: {} },
  openrouter: {
    name: 'openrouter',
    model: 'anthropic/claude-opus-5.5',
    config: { authScheme: 'bearer', modelMaxOutputTokens: () => 64000 },
    capabilityModel: MODEL,
  },
  'opencode-go': { name: 'opencode-go', model: MODEL, config: { modelMaxOutputTokens: () => 64000 } },
  'command-code-oauth': { name: 'command-code-oauth', model: MODEL, config: { modelMaxOutputTokens: () => 64000 } },
  'custom-claude': { name: 'custom-claude', model: MODEL, config: {} },
};

for (const [label, gateway] of Object.entries(GATEWAYS)) {
  const build = async (messages) =>
    (
      await buildAnthropicApiRequest({
        name: gateway.name,
        config: gateway.config,
        messages,
        useModel: gateway.model,
        tools: TOOLS,
        opts: gatewayMessagesOpts(gateway.config, gateway.model, messages, {}),
        fastModeLatched: false,
        capabilityModel: gateway.capabilityModel || gateway.model,
      })
    ).params;

  test(`${label}: breakpoint on the block before the reminder; consecutive requests share the cached prefix`, async () => {
    const first = await build(withReminder(H1, gateway.model));
    const plain = await build(H1);
    const last = first.messages.at(-1);
    assert.deepEqual(last.content.at(-1), { type: 'text', text: REMINDER });
    assert.ok(last.content.at(-2).cache_control, 'cache_control on the block before the reminder');
    assert.deepEqual(marks(first.messages), marks(plain.messages));
    assert.equal(JSON.stringify(first.messages.slice(0, -1)), JSON.stringify(plain.messages.slice(0, -1)));

    const second = await build(withReminder(H2, gateway.model));
    const [i, j] = marks(first.messages).at(-1);
    assert.equal(strip(second.system), strip(first.system));
    assert.equal(strip(second.tools), strip(first.tools));
    assert.equal(strip(second.messages.slice(0, i)), strip(first.messages.slice(0, i)));
    assert.equal(strip(second.messages[i].content.slice(0, j + 1)), strip(first.messages[i].content.slice(0, j + 1)));
    // One reminder per request, none carried into the next one's history.
    assert.equal(JSON.stringify(second.messages).split('Write all user-facing text').length - 1, 1);
  });
}

// --- OpenAI-compatible Chat (OpenRouter chat fallback, custom gateways): no marker on the tail ---

function compatFixture(name) {
  const requests = [];
  const stream = (params) => {
    requests.push(structuredClone(params));
    return (async function* () {
      yield { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] };
    })();
  };
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name,
    config: { preconnect: false },
    nativePdf: false,
    chatCacheControl: true,
    getCachedModelInfo: () => null,
    client: {
      chat: { completions: { create: async (params) => stream(params) } },
      responses: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return (async function* () {
            yield {
              type: 'response.completed',
              response: {
                id: 'resp',
                model: params.model,
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
              },
            };
          })();
        },
      },
    },
  });
  return { provider, requests };
}

test('chat wire: the reminder is the last message, no tail marker, prefix unchanged', async () => {
  const body = (history) => toOpenAIMessages(history, 'openrouter', { cacheControl: true });
  const first = body(withReminder(H1));
  assert.deepEqual(first.at(-1), { role: 'user', content: REMINDER });
  assert.equal(JSON.stringify(first.slice(0, -1)), JSON.stringify(body(H1)));
  assert.equal(JSON.stringify(first.at(-1)).includes('cache_control'), false);
  const second = body(withReminder(H2));
  assert.equal(JSON.stringify(second.slice(0, first.length - 1)), JSON.stringify(first.slice(0, -1)));

  const { provider, requests } = compatFixture('openrouter');
  await sendCompatChat(provider, withReminder(H1), 'm1', [], {});
  await sendCompatChat(provider, withReminder(H2), 'm1', [], {});
  assert.deepEqual(requests[0].messages.at(-1), { role: 'user', content: REMINDER });
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length - 1), requests[0].messages.slice(0, -1));
});

// --- OpenAI-compatible Responses (custom/gateway wire): continuation is indexed by transcript position ---

test('responses wire: the reminder ends the input and never enters the continuation indexes', async () => {
  const { provider, requests } = compatFixture('opencode-go');
  const first = await sendCompatResponses(provider, withReminder(H1), 'm1', [], {});
  const second = await sendCompatResponses(provider, withReminder(H2), 'm1', [], {
    providerState: first.providerState,
  });
  const plain = compatFixture('opencode-go');
  await sendCompatResponses(plain.provider, H1, 'm1', [], {});

  const input = requests[0].input;
  assert.deepEqual(input.at(-1), { role: 'user', content: [{ type: 'input_text', text: REMINDER }] });
  assert.deepEqual(input.slice(0, -1), plain.requests[0].input);
  assert.equal(first.providerState.compatResponses.seenMessageCount, H1.length, 'transcript length, no reminder');
  // The next request replays the same prefix, then its own new items.
  assert.deepEqual(requests[1].input.slice(0, input.length - 1), input.slice(0, -1));
  assert.deepEqual(requests[1].input.at(-1), input.at(-1));
  assert.equal(JSON.stringify(requests[1].input).split('Write all user-facing text').length - 1, 1);
  assert.equal(second.providerState.compatResponses.seenMessageCount, H2.length);
});

// --- Antigravity (Claude behind Google): the tool-loop closure must see the real tail ---

test('antigravity Claude: closure runs on the real history; the reminder is the last content', () => {
  const model = 'claude-opus-5-5-thinking';
  const opts = { thinkingLevel: 'high' };
  const plain = buildAntigravityRequest(H1, model, TOOLS, opts, 'proj').request;
  const body = buildAntigravityRequest(withReminder(H1, model), model, TOOLS, opts, 'proj').request;
  assert.ok(JSON.stringify(plain.contents).includes('[Continue.]'), 'the unthought tool loop is closed');
  assert.deepEqual(body.contents.slice(0, -1), plain.contents);
  assert.deepEqual(body.contents.at(-1), { role: 'user', parts: [{ text: REMINDER }] });
  assert.equal(body.sessionId, plain.sessionId);
});

// --- Cursor: the run resumes from tool results; the reminder is only the active user text ---

test('cursor: the reminder is the active turn text and leaves history and tool results alone', () => {
  const chat = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ];
  const plain = parseMessages(chat);
  const parsed = parseMessages([...chat, { role: 'user', content: REMINDER }]);
  assert.equal(plain.userText, '');
  assert.equal(parsed.userText, REMINDER);
  assert.deepEqual(parsed.history, plain.history);
  assert.deepEqual(parsed.toolResults, plain.toolResults);
});

// --- Persisted reminders stay in history, so they never shift the prefix ---

test('persisted turn reminders live in the stored user message and keep the prefix stable', async () => {
  const turn = withRuntimeUserContext(
    { role: 'user', content: 'Refactor the parser.' },
    {
      suffix:
        '\n\n<system-reminder>\n# Current Time\nLocal: 2026-10-21 17:47:11\n</system-reminder>' +
        '\n\n<system-reminder>\n<deferred_tools_delta>\nRemoved deferred tools:\n- mcp__x\n</deferred_tools_delta>\n</system-reminder>' +
        '\n\n<system-reminder>\n<goal_state>\nactive\n</goal_state>\n</system-reminder>',
    }
  );
  const steering = {
    role: 'user',
    content: '<task-notification>\ndone\n</task-notification>',
    meta: { source: 'task-notification' },
  };
  const history1 = [H1[0], turn, ...H1.slice(2)];
  const history2 = [...history1, ...H2.slice(4), steering];
  const build = async (messages) =>
    (
      await buildAnthropicApiRequest({
        name: 'anthropic',
        config: {},
        messages,
        useModel: MODEL,
        tools: TOOLS,
        opts: {},
        fastModeLatched: false,
      })
    ).params;
  const first = await build(withReminder(history1));
  const second = await build(withReminder(history2));
  const text = (message) => JSON.stringify(message.content);
  for (const body of [first, second]) {
    for (const tag of ['# Current Time', 'deferred_tools_delta', 'goal_state'])
      assert.ok(text(body.messages[0]).includes(tag), tag);
  }
  assert.equal(history1[1], turn, 'the stored message is not rewritten');
  const [i, j] = marks(first.messages).at(-1);
  assert.equal(strip(second.messages.slice(0, i)), strip(first.messages.slice(0, i)));
  assert.equal(strip(second.messages[i].content.slice(0, j + 1)), strip(first.messages[i].content.slice(0, j + 1)));
});
