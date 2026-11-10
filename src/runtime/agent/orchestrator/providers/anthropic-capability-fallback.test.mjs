import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-capability-'));
const saved = Object.fromEntries(
  [
    'MIXDOG_DATA_DIR',
    'HTTPS_PROXY',
    'MIXDOG_DISABLE_LIVE_CLI_VERSIONS',
    'MIXDOG_QUIET_PROVIDER_LOG',
    'MIXDOG_ANTHROPIC_MESSAGE_THREADS',
    'MIXDOG_ANTHROPIC_THINKING_DISPLAY',
  ].map((key) => [key, process.env[key]])
);
process.env.MIXDOG_DATA_DIR = dataDir;
// Keep the OAuth socket prewarm and CLI-version lookup off the network.
process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
// Threads have their own rejection handling (anthropic-message-threads.test.mjs).
process.env.MIXDOG_ANTHROPIC_MESSAGE_THREADS = '0';
delete process.env.MIXDOG_ANTHROPIC_THINKING_DISPLAY;
const { AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
const { AnthropicProvider } = await import('./anthropic.mjs');
const { anthropicCapabilityEnabled, anthropicCapabilityRejection, withAnthropicCapabilityFallback } = await import(
  './anthropic-capability-fallback.mjs'
);

test.after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});

const PROGRESS_REJECTED = "thinking.adaptive.display: Input should be 'summarized' or 'omitted'";
const TURN_SCOPED_REJECTED = 'messages.1.clear_at: Extra inputs are not permitted';

test('rejection texts name the floor feature they reject, and nothing else matches', () => {
  const cases = [
    [PROGRESS_REJECTED, 'progressUpdates'],
    ['Unexpected value(s) `thinking-display-updates-2026-08-18` for the `anthropic-beta` header.', 'progressUpdates'],
    [TURN_SCOPED_REJECTED, 'turnScopedSystem'],
    ['Unexpected value(s) `mid-conversation-system-clear-at-2026-08-21` for the `anthropic-beta` header.', 'turnScopedSystem'],
    // What a turn-scoped message may hold: the model takes the message.
    ["messages.3: a turn-scoped system message supports text blocks only (clear_at: 'next_user_message')", null],
    ["messages.3.content.0: cache_control is not permitted on a turn-scoped system message (clear_at: 'next_user_message')", null],
    // The mid-conversation effort update has its own fallback.
    ['Unexpected value(s) `mid-conversation-output-config-2026-07-01` for the `anthropic-beta` header.', null],
    ['output_config: Extra inputs are not permitted', null],
    ['prompt is too long: 210000 tokens > 200000 maximum', null],
  ];
  for (const [text, feature] of cases) assert.equal(anthropicCapabilityRejection(400, text), feature, text);
  assert.equal(anthropicCapabilityRejection(500, TURN_SCOPED_REJECTED), null);
});

const rejection = (message) => Object.assign(new Error(`Anthropic API 400: ${message}`), { status: 400 });

test('a rejected feature is switched off and replayed once; a second feature gets its own single replay', async () => {
  const model = 'claude-fable-9';
  const calls = [];
  const replies = [rejection(PROGRESS_REJECTED), rejection(TURN_SCOPED_REJECTED), rejection(PROGRESS_REJECTED)];
  const send = async (opts) => {
    calls.push(opts._anthropicCapabilityRetries || []);
    const next = replies.shift();
    if (next) throw next;
    return 'ok';
  };
  // The third reply rejects a feature already replayed: no loop.
  await assert.rejects(withAnthropicCapabilityFallback('anthropic', model, {}, send), /display/);
  assert.deepEqual(calls, [[], ['progressUpdates'], ['progressUpdates', 'turnScopedSystem']]);
  assert.equal(anthropicCapabilityEnabled('progressUpdates', 'anthropic', model), false);
  assert.equal(anthropicCapabilityEnabled('turnScopedSystem', 'anthropic', model), false);
  assert.equal(anthropicCapabilityEnabled('progressUpdates', 'anthropic-oauth', model), true, 'per route');
});

test('never replayed after output reached the caller or after cancellation', async () => {
  const model = 'claude-fable-9-1';
  let calls = 0;
  const afterText = async (opts) => {
    calls++;
    opts.onTextDelta('partial');
    throw rejection(TURN_SCOPED_REJECTED);
  };
  await assert.rejects(
    withAnthropicCapabilityFallback('anthropic', model, { onTextDelta: () => {} }, afterText),
    /clear_at/
  );
  const controller = new AbortController();
  controller.abort();
  const cancelled = async () => {
    calls++;
    throw rejection(TURN_SCOPED_REJECTED);
  };
  await assert.rejects(withAnthropicCapabilityFallback('anthropic', model, { signal: controller.signal }, cancelled));
  assert.equal(calls, 2, 'one attempt each');
  assert.equal(anthropicCapabilityEnabled('turnScopedSystem', 'anthropic', model), true, 'a late error is no evidence');
});

function sse(id, text) {
  const events = [
    { type: 'message_start', message: { id, role: 'assistant', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function errorReply(message) {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

// One provider of `kind` on a scripted wire: every request is recorded with its
// body and (API key) beta header; `script` holds error replies, the default
// being a reply `reply-<n>`.
function harness(kind) {
  const requests = [];
  const script = [];
  const next = (body, headers) => {
    requests.push({ body: structuredClone(body), beta: headers?.['anthropic-beta'] || '' });
    const message = script.shift();
    return message ? errorReply(message) : sse(`msg_${requests.length}`, `reply-${requests.length}`);
  };
  const oauth = kind === 'anthropic-oauth';
  const provider = Object.assign(
    Object.create(oauth ? AnthropicOAuthProvider.prototype : AnthropicProvider.prototype),
    {
      name: kind,
      config: { apiKey: 'key-1' },
      apiKey: 'key-1',
      fastModeBetaHeaderLatched: false,
      ensureAuth: async () => ({ accessToken: 'token', identity: { id: 'account-1' } }),
      scrubTokens: (text) => String(text || ''),
      _refreshModelCache: async () => null,
      client: {
        messages: {
          create(params, options) {
            return { asResponse: async () => next(params, options?.headers) };
          },
        },
      },
    }
  );
  if (!oauth) provider._currentClient = () => provider.client;
  const send = (messages, model) =>
    provider.send(messages, model, [], {
      sessionId: 'session-1',
      effort: 'high',
      ...(oauth
        ? {
            _doRequestFn: async (_token, _signal, body) => ({
              response: next(body, null),
              controller: new AbortController(),
              cancelHandler: null,
            }),
          }
        : {}),
    });
  return { requests, script, send };
}

const SYSTEM = { role: 'system', content: 'You are terse.' };
const REMINDER = {
  role: 'user',
  content: '<system-reminder>Reply in Korean.</system-reminder>',
  meta: { source: 'tail-reminder' },
};

for (const kind of ['anthropic', 'anthropic-oauth']) {
  test(`${kind}: a model that rejects progress updates is switched off and the turn replayed once without them`, async () => {
    const h = harness(kind);
    const model = 'claude-mythos-5-2';
    h.script.push(PROGRESS_REJECTED);
    const result = await h.send([SYSTEM, { role: 'user', content: 'one' }], model);
    assert.equal(result.content, 'reply-2');
    assert.deepEqual(h.requests[0].body.thinking, { type: 'adaptive', display: 'updates' });
    assert.deepEqual(h.requests[1].body.thinking, { type: 'adaptive' });
    if (kind === 'anthropic') {
      assert.ok(h.requests[0].beta.includes('thinking-display-updates'));
      assert.ok(!h.requests[1].beta.includes('thinking-display-updates'));
    }
    await h.send([SYSTEM, { role: 'user', content: 'two' }], model);
    assert.equal(h.requests.length, 3, 'the next turn pays no failed attempt');
    assert.deepEqual(h.requests[2].body.thinking, { type: 'adaptive' });
    await h.send([SYSTEM, { role: 'user', content: 'three' }], 'claude-fable-5-2');
    assert.deepEqual(h.requests[3].body.thinking, { type: 'adaptive', display: 'updates' }, 'other models keep it');
  });

  test(`${kind}: a model that rejects turn-scoped system messages is switched off and the turn replayed once in the legacy layout`, async () => {
    const h = harness(kind);
    const model = 'claude-fable-5-2';
    const messages = [SYSTEM, { role: 'user', content: 'one' }, REMINDER];
    h.script.push(TURN_SCOPED_REJECTED);
    const result = await h.send(messages, model);
    assert.equal(result.content, 'reply-2');
    assert.equal(h.requests[0].body.messages.at(-1).clear_at, 'next_user_message');
    assert.equal(JSON.stringify(h.requests[1].body.messages).includes('clear_at'), false);
    assert.ok(JSON.stringify(h.requests[1].body.messages).includes('Reply in Korean.'), 'the reminder still rides');
    if (kind === 'anthropic') {
      assert.ok(h.requests[0].beta.includes('mid-conversation-system-clear-at'));
      assert.ok(!h.requests[1].beta.includes('mid-conversation-system-clear-at'));
    }
    await h.send(messages, model);
    assert.equal(h.requests.length, 3, 'the next turn pays no failed attempt');
    assert.equal(JSON.stringify(h.requests[2].body.messages).includes('clear_at'), false);
  });
}
