import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-threads-'));
const saved = {
  MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  MIXDOG_DISABLE_LIVE_CLI_VERSIONS: process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS,
  MIXDOG_QUIET_PROVIDER_LOG: process.env.MIXDOG_QUIET_PROVIDER_LOG,
};
process.env.MIXDOG_DATA_DIR = dataDir;
// Keep the OAuth socket prewarm and CLI-version lookup off the network.
process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { AnthropicOAuthProvider } = await import('./anthropic-oauth.mjs');
const { AnthropicProvider } = await import('./anthropic.mjs');
const { MESSAGE_THREADS_BETA, THREAD_CONTINUE_MAX_AGE_MS, planAnthropicThread, _threadTest } = await import(
  './anthropic-message-threads.mjs'
);
const { countAnthropicCacheControls } = await import('./lib/anthropic-request-utils.mjs');

test.after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true });
});
test.beforeEach(() => _threadTest.reset());

const MODEL = 'claude-opus-4-8';
const ONE_HOUR = { type: 'ephemeral', ttl: '1h' };
const FIVE_MIN = { type: 'ephemeral' };

function sse(events) {
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function replyEvents({ id, text, stop = 'end_turn', toolUse = null, thinking = null, iterations = null }) {
  const events = [
    { type: 'message_start', message: { id, model: MODEL, role: 'assistant', usage: { input_tokens: 1 } } },
  ];
  let index = 0;
  if (thinking) {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: thinking.text } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: thinking.signature } },
      { type: 'content_block_stop', index }
    );
    index++;
  }
  events.push(
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index }
  );
  index++;
  if (toolUse) {
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: toolUse.id,
          name: toolUse.name,
          input: {},
          ...(toolUse.caller ? { caller: toolUse.caller } : {}),
        },
      },
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input ?? {}) },
      },
      { type: 'content_block_stop', index }
    );
  }
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: stop },
      usage: { output_tokens: 1, ...(iterations ? { iterations } : {}) },
    },
    { type: 'message_stop' }
  );
  return events;
}

function turnReply(spec) {
  return sse(replyEvents(spec));
}

// A reply whose final message_stop is held back until `release()`; `end()`
// closes the stream without it.
function gatedReply(spec) {
  const encoder = new TextEncoder();
  const frame = (e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const events = replyEvents(spec);
  const stop = events.pop();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const record = { cancelledAt: 0 };
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(frame(e));
      gate.then((withStop) => {
        if (record.cancelledAt) return;
        if (withStop) controller.enqueue(frame(stop));
        controller.close();
      });
    },
    cancel() {
      record.cancelledAt = Date.now();
    },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    release: () => open(true),
    end: () => open(false),
    record,
  };
}

const settleSoon = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function errorReply(status, code, { message = 'thread error', unsupported } = {}) {
  const details = code ? { error_code: code, ...(unsupported ? { unsupported } : {}) } : undefined;
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: status === 404 ? 'not_found_error' : 'invalid_request_error',
        message,
        ...(details ? { details } : {}),
      },
    }),
    { status, headers: { 'content-type': 'application/json' } }
  );
}

// One provider of `kind` with a scripted wire. Every request is recorded with
// its body and (API key) beta header; `script` holds per-request replies, the
// default being a stored end_turn reply `reply-<n>` with id `msg_<n>`.
function harness(kind, { config = {} } = {}) {
  const requests = [];
  const script = [];
  const next = (body, headers) => {
    requests.push({ body: structuredClone(body), beta: headers?.['anthropic-beta'] || '' });
    const n = requests.length;
    const scripted = script.shift();
    return scripted ? scripted(n) : turnReply({ id: `msg_${n}`, text: `reply-${n}` });
  };
  const oauth = kind === 'anthropic-oauth';
  const identity = { id: 'account-1' };
  const provider = Object.assign(
    Object.create(oauth ? AnthropicOAuthProvider.prototype : AnthropicProvider.prototype),
    {
      name: kind,
      config: { apiKey: 'key-1', ...config },
      apiKey: 'key-1',
      fastModeBetaHeaderLatched: false,
      ensureAuth: async () => ({ accessToken: 'token', identity }),
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
  const send = (messages, opts = {}, model = MODEL, tools = []) =>
    provider.send(messages, model, tools, {
      sessionId: 'session-1',
      ...(oauth
        ? {
            _doRequestFn: async (_token, _signal, body) => ({
              response: next(body, null),
              controller: new AbortController(),
              cancelHandler: null,
            }),
          }
        : {}),
      ...opts,
    });
  return { provider, requests, script, send, identity };
}

const SYSTEM = { role: 'system', content: 'You are terse.' };
const user = (text) => ({ role: 'user', content: text });
const assistant = (result) => ({
  role: 'assistant',
  content: result.content,
  ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
  ...(result.thinkingBlocks?.length ? { thinkingBlocks: result.thinkingBlocks } : {}),
});

// Two turns: the second send carries the first reply plus a new user turn.
async function twoTurns(h, opts = {}) {
  const first = [SYSTEM, user('one')];
  const r1 = await h.send(first, opts);
  const second = [...first, assistant(r1), user('two')];
  const r2 = await h.send(second, opts);
  return { first, second, r1, r2 };
}

const wireTexts = (body) =>
  body.messages.map((m) =>
    typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? b.type).join('|')
  );

function breakpoints(body, createBody) {
  return (
    (body.cache_control ? 1 : 0) +
    countAnthropicCacheControls(createBody.system || []) +
    countAnthropicCacheControls(createBody.tools || []) +
    countAnthropicCacheControls(body.messages)
  );
}

for (const kind of ['anthropic', 'anthropic-oauth']) {
  test(`${kind}: first turn creates, the next continues with only the new messages`, async () => {
    const h = harness(kind);
    await twoTurns(h);
    const [create, cont] = h.requests.map((r) => r.body);
    assert.deepEqual(create.thread, { type: 'create' });
    assert.ok(create.system?.length, 'create carries system');
    assert.deepEqual(wireTexts(create), ['one']);
    assert.deepEqual(cont.thread, { type: 'continue', previous_message_id: 'msg_1' });
    assert.equal('system' in cont, false);
    assert.equal('tools' in cont, false);
    assert.deepEqual(wireTexts(cont), ['two']);
    assert.equal(cont.model, create.model);
    if (kind === 'anthropic') {
      for (const r of h.requests) assert.ok(r.beta.split(',').includes(MESSAGE_THREADS_BETA));
      assert.equal(h.requests[0].beta, h.requests[1].beta, 'same beta set on create and continue');
    }
  });

  test(`${kind}: a thread older than the expiry margin creates without a continue attempt`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    _threadTest.setStoredAt('session-1', kind, Date.now() - THREAD_CONTINUE_MAX_AGE_MS - 1_000);
    await h.send([...first, assistant(r1), user('two')]);
    assert.equal(h.requests.length, 2, 'no wasted continue round trip');
    assert.deepEqual(h.requests[1].body.thread, { type: 'create' });
    assert.deepEqual(wireTexts(h.requests[1].body), ['one', 'reply-1', 'two']);
  });

  test(`${kind}: a thread younger than the expiry margin continues`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    _threadTest.setStoredAt('session-1', kind, Date.now() - THREAD_CONTINUE_MAX_AGE_MS + 30_000);
    await h.send([...first, assistant(r1), user('two')]);
    assert.equal(h.requests[1].body.thread.type, 'continue');
  });

  for (const code of [
    'thread_not_found',
    'thread_already_continued',
    'thread_continue_in_flight',
    'thread_fingerprint_mismatch',
  ]) {
    test(`${kind}: ${code} on a continue replays the full conversation as a create`, async () => {
      const h = harness(kind);
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      h.script.push(() => errorReply(code === 'thread_not_found' ? 404 : 400, code));
      const r2 = await h.send([...first, assistant(r1), user('two')]);
      assert.equal(r2.content, 'reply-3');
      const replay = h.requests[2].body;
      assert.deepEqual(replay.thread, { type: 'create' });
      assert.ok(replay.system?.length);
      assert.deepEqual(wireTexts(replay), ['one', 'reply-1', 'two']);
      assert.equal(_threadTest.state('session-1', kind).responseId, 'msg_3');
    });
  }

  test(`${kind}: a continue that 404s right after a replay stops threading the conversation`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    h.script.push(() => errorReply(404, 'thread_not_found'));
    const second = [...first, assistant(r1), user('two')];
    const r2 = await h.send(second); // 404 → replay create (msg_3)
    h.script.push(() => errorReply(404, 'thread_not_found'));
    const third = [...second, assistant(r2), user('three')];
    const r3 = await h.send(third); // continue 404 again → unthreaded
    assert.equal(h.requests[3].body.thread.type, 'continue');
    assert.equal('thread' in h.requests[4].body, false);
    await h.send([...third, assistant(r3), user('four')]);
    assert.equal('thread' in h.requests[5].body, false, 'later turns stay unthreaded');
  });

  test(`${kind}: thread_unsupported_request sends the same turn without thread`, async () => {
    const h = harness(kind);
    h.script.push(() => errorReply(400, 'thread_unsupported_request', { unsupported: ['something_new'] }));
    const r = await h.send([SYSTEM, user('one')]);
    assert.equal(r.content, 'reply-2');
    assert.equal('thread' in h.requests[1].body, false);
    assert.ok(h.requests[1].body.system?.length);
    if (kind === 'anthropic') assert.ok(!h.requests[1].beta.includes(MESSAGE_THREADS_BETA));
  });

  test(`${kind}: a first-request refusal of the thread beta turns threads off for the account`, async () => {
    const h = harness(kind);
    h.script.push(() => errorReply(400, null, { message: 'thread: Extra inputs are not permitted' }));
    await h.send([SYSTEM, user('one')]);
    assert.equal('thread' in h.requests[1].body, false);
    await h.send([SYSTEM, user('other')], { sessionId: 'session-2' });
    assert.equal('thread' in h.requests[2].body, false, 'another conversation of the account is unthreaded too');
  });

  test(`${kind}: a 404 without a thread error code is not replayed as a thread`, async () => {
    const h = harness(kind);
    const plan = planAnthropicThread({
      provider: kind,
      config: {},
      opts: { sessionId: 's' },
      body: { model: MODEL, messages: [{ role: 'user', content: 'x' }] },
      account: 'a',
    });
    assert.equal(plan.mode, 'create');
    assert.equal(plan.classify(404, '{"type":"error","error":{"type":"not_found_error","message":"model: x"}}'), null);
    void h;
  });

  test(`${kind}: refusal, fallback model and unconfirmed storage make the next turn create`, async () => {
    for (const reply of [
      (n) => turnReply({ id: `msg_${n}`, text: `reply-${n}`, stop: 'refusal' }),
      (n) => turnReply({ id: `msg_${n}`, text: `reply-${n}`, iterations: [{ type: 'fallback_message', model: 'x' }] }),
    ]) {
      _threadTest.reset();
      const h = harness(kind);
      h.script.push(reply);
      await twoTurns(h);
      assert.deepEqual(h.requests[1].body.thread, { type: 'create' });
    }
  });

  test(`${kind}: pause_turn continues with empty messages`, async () => {
    const h = harness(kind);
    h.script.push((n) => turnReply({ id: `msg_${n}`, text: `reply-${n}`, stop: 'pause_turn' }));
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    await h.send([...first, assistant(r1)]);
    assert.deepEqual(h.requests[1].body.thread, { type: 'continue', previous_message_id: 'msg_1' });
    assert.deepEqual(h.requests[1].body.messages, []);
  });

  test(`${kind}: a tool turn continues with the tool result only`, async () => {
    const h = harness(kind);
    h.script.push((n) =>
      turnReply({ id: `msg_${n}`, text: 'calling', stop: 'tool_use', toolUse: { id: 'toolu_1', name: 'read' } })
    );
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    assert.equal(r1.toolCalls?.[0]?.id, 'toolu_1');
    await h.send([...first, assistant(r1), { role: 'tool', toolCallId: 'toolu_1', content: 'file text' }]);
    const cont = h.requests[1].body;
    assert.equal(cont.thread.type, 'continue');
    assert.equal(cont.messages.length, 1);
    assert.equal(cont.messages[0].content[0].type, 'tool_result');
    assert.equal(cont.messages[0].content[0].tool_use_id, 'toolu_1');
  });

  test(`${kind}: prefix divergence and fixed-field changes create`, async () => {
    const cases = {
      rewind: ({ first }) => [...first.slice(0, 1), user('one, rewritten')],
      edited: ({ first, r1 }) => [SYSTEM, user('ONE'), assistant(r1), user('two')],
      compaction: () => [SYSTEM, user('summary of earlier work'), { role: 'assistant', content: 'ok' }, user('two')],
      retried: ({ first }) => first,
      otherReply: ({ first }) => [...first, { role: 'assistant', content: 'something else' }, user('two')],
      systemChange: ({ first, r1 }) => [
        { role: 'system', content: 'Changed.' },
        ...first.slice(1),
        assistant(r1),
        user('two'),
      ],
    };
    for (const [name, build] of Object.entries(cases)) {
      _threadTest.reset();
      const h = harness(kind);
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      await h.send(build({ first, r1 }));
      assert.deepEqual(h.requests[1].body.thread, { type: 'create' }, name);
    }
  });

  test(`${kind}: model, tools, account and cache-strategy changes create`, async () => {
    const tool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } };
    const changes = {
      model: (h, msgs) => h.send(msgs, {}, 'claude-sonnet-4-6'),
      tools: (h, msgs) => h.send(msgs, {}, MODEL, [tool]),
      account: (h, msgs) => {
        h.provider.apiKey = 'key-2';
        h.identity.id = 'account-2';
        return h.send(msgs);
      },
      cacheStrategy: (h, msgs) => h.send(msgs, { cacheStrategy: { messages: '1h', system: '1h', tier3: '1h' } }),
    };
    for (const [name, change] of Object.entries(changes)) {
      _threadTest.reset();
      const h = harness(kind);
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first, { cacheStrategy: { messages: '5m' } });
      await change(h, [...first, assistant(r1), user('two')]);
      assert.deepEqual(h.requests[1].body.thread, { type: 'create' }, name);
    }
  });

  for (const [label, strategy, messageTtl] of [
    ['1h', { system: '1h', tier3: '1h', messages: '1h' }, ONE_HOUR],
    ['5m', { system: '1h', tier3: '1h', messages: '5m' }, FIVE_MIN],
  ]) {
    test(`${kind}: ${label} strategy keeps per-layer TTLs and ≤4 breakpoints on create, continue and replay`, async () => {
      const h = harness(kind);
      const system = [
        { role: 'system', content: 'Base rules.' },
        { role: 'system', content: 'Stable system.' },
        { role: 'system', content: 'Session marker.', cacheTier: 'tier3' },
      ];
      const opts = { cacheStrategy: strategy };
      const first = [
        ...system,
        user('one'),
        { role: 'assistant', content: 'a' },
        { role: 'tool', toolCallId: 'x', content: 'y' },
      ];
      const turn1 = [...system, user('one')];
      const r1 = await h.send(turn1, opts);
      const turn2 = [...turn1, assistant(r1), user('two')];
      const r2 = await h.send(turn2, opts);
      h.script.push(() => errorReply(404, 'thread_not_found'));
      await h.send([...turn2, assistant(r2), user('three')], opts);
      // The reference: the same third turn unthreaded (today's request).
      await h.send([...turn2, assistant(r2), user('three')], { ...opts, messageThreads: false });
      const [create, cont, , replay, plain] = h.requests.map((r) => r.body);
      void first;
      assert.equal(cont.thread.type, 'continue');
      assert.equal(replay.thread.type, 'create');
      for (const body of [create, cont, replay]) assert.ok(breakpoints(body, create) <= 4, JSON.stringify(body));
      // System breakpoints ride the create with their layer TTL (1h first).
      const systemTtls = create.system.filter((b) => b.cache_control).map((b) => b.cache_control);
      assert.ok(systemTtls.length >= 1);
      for (const ttl of systemTtls) assert.deepEqual(ttl, ONE_HOUR);
      // Message breakpoints on the new messages carry the messages-layer TTL.
      const msgMarks = (body) =>
        body.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .map((b) => b.cache_control)
          .filter(Boolean);
      for (const body of [create, cont, replay]) for (const ttl of msgMarks(body)) assert.deepEqual(ttl, messageTtl);
      // The replay places exactly today's breakpoints, so a warmed cache is read.
      const { thread: _t, ...replayRest } = replay;
      assert.deepEqual(replayRest, plain);
    });
  }

  test(`${kind}: messageThreads:false, forks and sessionless sends stay unthreaded`, async () => {
    const h = harness(kind, { config: { messageThreads: false } });
    await twoTurns(h);
    const f = harness(kind);
    await f.send([SYSTEM, user('q')], { transportScope: 'session-1#side:x' });
    await f.send([SYSTEM, user('q')], { sessionId: undefined });
    for (const r of [...h.requests, ...f.requests]) assert.equal('thread' in r.body, false);
  });

  test(`${kind}: closing the session drops its thread`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    globalThis.__mixdogCloseProviderConnectionsForSession('session-1', 'session-close:test');
    assert.equal(_threadTest.state('session-1', kind), null);
    await h.send([...first, assistant(r1), user('two')]);
    assert.deepEqual(h.requests[1].body.thread, { type: 'create' });
  });

  test(`${kind}: cache warming is never threaded and leaves the thread alone`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    const before = _threadTest.state('session-1', kind);
    const warmBodies = [];
    if (kind === 'anthropic') {
      h.provider.client.messages.create = (params) => {
        warmBodies.push(params);
        return { asResponse: async () => turnReply({ id: 'warm', text: 'w' }) };
      };
    }
    await h.provider
      .sendCacheWarm([...first, assistant(r1), user('two')], MODEL, [], { sessionId: 'session-1' }, { onUsage() {} })
      .catch(() => {});
    if (kind === 'anthropic') {
      assert.equal(warmBodies.length, 1);
      assert.equal('thread' in warmBodies[0], false);
    }
    assert.deepEqual(_threadTest.state('session-1', kind), before);
  });
}

const receiptOf = (id, text, extra = []) => ({
  id,
  stoppedAt: Date.now(),
  blocks: [{ type: 'text', text }, ...extra],
  opaque: false,
  pending: null,
});

for (const kind of ['anthropic', 'anthropic-oauth']) {
  test(`${kind}: a different tool input under the same tool_use id creates`, async () => {
    for (const [name, localInput, expected] of [
      ['same input', { path: 'a.txt' }, 'continue'],
      ['different input', { path: 'b.txt' }, 'create'],
    ]) {
      _threadTest.reset();
      const h = harness(kind);
      h.script.push((n) =>
        turnReply({
          id: `msg_${n}`,
          text: 'calling',
          stop: 'tool_use',
          toolUse: { id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
        })
      );
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      await settleSoon();
      const local = { ...assistant(r1), toolCalls: [{ ...r1.toolCalls[0], arguments: localInput }] };
      await h.send([...first, local, { role: 'tool', toolCallId: 'toolu_1', content: 'file text' }]);
      assert.equal(h.requests[1].body.thread.type, expected, name);
    }
  });

  test(`${kind}: a streamed direct caller matches the transcript's tool_use; another caller creates`, async () => {
    for (const [name, caller, expected] of [
      ['direct', { type: 'direct' }, 'continue'],
      ['code execution', { type: 'code_execution_20250825', tool_id: 'srvtoolu_1' }, 'create'],
    ]) {
      _threadTest.reset();
      const h = harness(kind);
      h.script.push((n) =>
        turnReply({
          id: `msg_${n}`,
          text: 'calling',
          stop: 'tool_use',
          toolUse: { id: 'toolu_1', name: 'read', input: { path: 'a.txt' }, caller },
        })
      );
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      await h.send([...first, assistant(r1), { role: 'tool', toolCallId: 'toolu_1', content: 'file text' }]);
      assert.equal(h.requests[1].body.thread.type, expected, name);
    }
  });

  test(`${kind}: a cache_control key inside tool input is data, not a breakpoint`, async () => {
    for (const [name, localValue, expected] of [
      ['same value', 'a', 'continue'],
      ['different value', 'b', 'create'],
    ]) {
      _threadTest.reset();
      const h = harness(kind);
      h.script.push((n) =>
        turnReply({
          id: `msg_${n}`,
          text: 'calling',
          stop: 'tool_use',
          toolUse: { id: 'toolu_1', name: 'read', input: { cache_control: 'a' } },
        })
      );
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      const local = { ...assistant(r1), toolCalls: [{ ...r1.toolCalls[0], arguments: { cache_control: localValue } }] };
      await h.send([...first, local, { role: 'tool', toolCallId: 'toolu_1', content: 'file text' }]);
      assert.equal(h.requests[1].body.thread.type, expected, name);
    }
  });

  test(`${kind}: the background read is released by the send's abort signal`, async () => {
    const h = harness(kind);
    const gated = gatedReply({
      id: 'msg_1',
      text: 'calling',
      stop: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read' },
    });
    h.script.push(() => gated.response);
    const controller = new AbortController();
    await h.send([SYSTEM, user('one')], { signal: controller.signal });
    assert.equal(gated.record.cancelledAt, 0, 'the read is open while message_stop is outstanding');
    const abortedAt = Date.now();
    controller.abort(new Error('turn aborted'));
    await settleSoon();
    assert.ok(gated.record.cancelledAt > 0 && gated.record.cancelledAt - abortedAt < 500, 'released at once');
    assert.equal(_threadTest.state('session-1', kind), null);
  });

  test(`${kind}: the background read is released by session close`, async () => {
    const h = harness(kind);
    const gated = gatedReply({
      id: 'msg_1',
      text: 'calling',
      stop: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read' },
    });
    h.script.push(() => gated.response);
    await h.send([SYSTEM, user('one')]);
    const closedAt = Date.now();
    globalThis.__mixdogCloseProviderConnectionsForSession('session-1', 'session-close:test');
    await settleSoon();
    assert.ok(gated.record.cancelledAt > 0 && gated.record.cancelledAt - closedAt < 500, 'released at once');
    assert.equal(_threadTest.state('session-1', kind), null);
  });

  test(`${kind}: text that differs only in whitespace creates`, async () => {
    const h = harness(kind);
    const first = [SYSTEM, user('one')];
    const r1 = await h.send(first);
    await h.send([...first, { role: 'assistant', content: r1.content.replace('-', ' -') }, user('two')]);
    assert.deepEqual(h.requests[1].body.thread, { type: 'create' });
  });

  test(`${kind}: thinking blocks continue only with the identical signature`, async () => {
    for (const [name, signature, expected] of [
      ['same signature', 'sig-1', 'continue'],
      ['other signature', 'sig-2', 'create'],
    ]) {
      _threadTest.reset();
      const h = harness(kind);
      h.script.push((n) =>
        turnReply({ id: `msg_${n}`, text: 'answer', thinking: { text: 'mull', signature: 'sig-1' } })
      );
      const first = [SYSTEM, user('one')];
      const r1 = await h.send(first);
      assert.equal(r1.thinkingBlocks?.[0]?.signature, 'sig-1');
      const local = { ...assistant(r1), thinkingBlocks: [{ ...r1.thinkingBlocks[0], signature }] };
      await h.send([...first, local, user('two')]);
      assert.equal(h.requests[1].body.thread.type, expected, name);
    }
  });

  test(`${kind}: the stored state holds digests, not response content`, async () => {
    const h = harness(kind);
    await h.send([SYSTEM, user('one')]);
    const state = _threadTest.state('session-1', kind);
    assert.match(state.responseDigest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(state).includes('reply-1'), JSON.stringify(state));
    assert.deepEqual(Object.keys(state).sort(), [
      'account',
      'fingerprint',
      'fromReplay',
      'prefixCount',
      'prefixHash',
      'responseDigest',
      'responseId',
      'stopReason',
      'storedAt',
    ]);
  });

  test(`${kind}: a tool turn returns before message_stop and is stored when it arrives`, async () => {
    const h = harness(kind);
    const gated = gatedReply({
      id: 'msg_1',
      text: 'calling',
      stop: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read' },
    });
    h.script.push(() => gated.response);
    const started = Date.now();
    const r1 = await h.send([SYSTEM, user('one')]);
    assert.ok(Date.now() - started < 1_000, 'the turn does not wait for message_stop');
    assert.equal(r1.toolCalls?.[0]?.id, 'toolu_1');
    assert.equal(_threadTest.state('session-1', kind), null, 'not stored before message_stop');
    gated.release();
    await settleSoon();
    assert.equal(_threadTest.state('session-1', kind)?.responseId, 'msg_1');
  });

  test(`${kind}: a tool turn whose stream ends without message_stop is not stored`, async () => {
    const h = harness(kind);
    const gated = gatedReply({
      id: 'msg_1',
      text: 'calling',
      stop: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read' },
    });
    h.script.push(() => gated.response);
    await h.send([SYSTEM, user('one')]);
    gated.end();
    await settleSoon();
    assert.equal(_threadTest.state('session-1', kind), null);
  });

  test(`${kind}: closing the session while message_stop is outstanding does not resurrect the thread`, async () => {
    const h = harness(kind);
    const gated = gatedReply({
      id: 'msg_1',
      text: 'calling',
      stop: 'tool_use',
      toolUse: { id: 'toolu_1', name: 'read' },
    });
    h.script.push(() => gated.response);
    await h.send([SYSTEM, user('one')]);
    globalThis.__mixdogCloseProviderConnectionsForSession('session-1', 'session-close:test');
    gated.release();
    await settleSoon();
    assert.equal(_threadTest.state('session-1', kind), null);
    assert.equal(_threadTest.record('session-1', kind), null);
  });

  test(`${kind}: a legacy tail reminder is never threaded; a turn-scoped one is`, async () => {
    const reminder = {
      role: 'user',
      content: '<system-reminder>x</system-reminder>',
      meta: { source: 'tail-reminder' },
    };
    const h = harness(kind);
    await h.send([SYSTEM, user('one'), reminder], {}, 'claude-haiku-4-5-20251001');
    await h.send([SYSTEM, user('one'), reminder], { sessionId: 'session-2' }, MODEL);
    assert.equal('thread' in h.requests[0].body, false, 'legacy layout');
    assert.deepEqual(h.requests[1].body.thread, { type: 'create' }, 'turn-scoped layout');
    // Without a reminder the legacy-layout model threads.
    await h.send([SYSTEM, user('one')], { sessionId: 'session-3' }, 'claude-haiku-4-5-20251001');
    assert.deepEqual(h.requests[2].body.thread, { type: 'create' });
  });
}

test('the prefix hash ignores breakpoints but not cache_control keys in data', () => {
  const marker = { type: 'ephemeral' };
  const history = (inputValue, { marked }) => [
    { role: 'user', content: [{ type: 'text', text: 'go', ...(marked ? { cache_control: marker } : {}) }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { cache_control: inputValue } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: '{"cache_control":"x"}', ...(marked ? { cache_control: marker } : {}) }],
          ...(marked ? { cache_control: marker } : {}),
        },
      ],
    },
  ];
  for (const [name, inputValue, marked, expected] of [
    ['breakpoints moved', 'a', false, 'continue'],
    ['tool input data changed', 'b', true, 'create'],
  ]) {
    _threadTest.reset();
    const opts = { sessionId: 's' };
    const first = { model: MODEL, messages: history('a', { marked: true }) };
    const plan = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body: first, account: 'a' });
    plan.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_a', 'r') });
    plan.settle();
    const messages = [
      ...history(inputValue, { marked }),
      { role: 'assistant', content: 'r' },
      { role: 'user', content: 'next' },
    ];
    const next = planAnthropicThread({
      provider: 'anthropic',
      config: {},
      opts,
      body: { model: MODEL, messages },
      account: 'a',
    });
    assert.equal(next.mode, expected, name);
  }
});

test('plan → close → commit records nothing', () => {
  const body = { model: MODEL, messages: [{ role: 'user', content: 'x' }] };
  const plan = planAnthropicThread({ provider: 'anthropic', config: {}, opts: { sessionId: 's' }, body, account: 'a' });
  assert.equal(plan.mode, 'create');
  globalThis.__mixdogCloseProviderConnectionsForSession('s', 'session-close:test');
  plan.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_a', 'r') });
  plan.settle();
  assert.equal(_threadTest.state('s', 'anthropic'), null);
  assert.deepEqual(_threadTest.scopes(), []);
});

test('only the send that took the conversation may store its response', () => {
  const opts = { sessionId: 's' };
  const body = { model: MODEL, messages: [{ role: 'user', content: 'x' }] };
  const owner = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  const concurrent = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  assert.equal(owner.mode, 'create');
  assert.equal(concurrent.mode, 'none', 'a send while the owner is in flight goes unthreaded');
  concurrent.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_b', 'r') });
  assert.equal(_threadTest.state('s', 'anthropic'), null);
  owner.settle();
  // A later send takes the conversation; the earlier one's late commit is ignored.
  const later = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  owner.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_a', 'r') });
  assert.equal(_threadTest.state('s', 'anthropic'), null);
  later.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_c', 'r') });
  assert.equal(_threadTest.state('s', 'anthropic')?.responseId, 'msg_c');
});

test('an unrelated beta error is not a thread rejection and keeps threads on', () => {
  const opts = { sessionId: 's' };
  const body = { model: MODEL, messages: [{ role: 'user', content: 'x' }] };
  const plan = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  const unrelated = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'invalid anthropic-beta: unrelated-beta' },
  });
  assert.equal(plan.classify(400, unrelated), null);
  plan.settle();
  const next = planAnthropicThread({
    provider: 'anthropic',
    config: {},
    opts: { sessionId: 's2' },
    body,
    account: 'a',
  });
  assert.equal(next.mode, 'create', 'the account still threads');
  for (const message of [
    'thread: Extra inputs are not permitted',
    'Unexpected value(s) `message-threads-2026-08-12` for the `anthropic-beta` header',
  ]) {
    _threadTest.reset();
    const p = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
    assert.deepEqual(p.classify(400, JSON.stringify({ error: { type: 'invalid_request_error', message } })), {
      force: 'none',
    });
  }
});

test('a dropped continue is resent once, then the request replays in place', () => {
  const body = { model: MODEL, system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'x' }] };
  const opts = { sessionId: 's' };
  const create = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  create.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_a', 'r') });
  create.settle();
  const next = {
    ...body,
    messages: [...body.messages, { role: 'assistant', content: 'r' }, { role: 'user', content: 'y' }],
  };
  const cont = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body: next, account: 'a' });
  assert.equal(cont.mode, 'continue');
  const wire = cont.body;
  cont.toCreate();
  assert.equal(cont.mode, 'create');
  assert.deepEqual(wire.thread, { type: 'create' });
  assert.equal(wire.messages.length, 3);
  assert.deepEqual(wire.system, body.system);
});

test('a continue whose new messages would exceed 4 breakpoints is sent as a create', () => {
  const marked = { type: 'ephemeral' };
  const system = [1, 2, 3].map((i) => ({ type: 'text', text: `s${i}`, cache_control: marked }));
  const body = { model: MODEL, system, messages: [{ role: 'user', content: 'x' }] };
  const opts = { sessionId: 's' };
  const first = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body, account: 'a' });
  first.commit({ stopReason: 'end_turn', threadReceipt: receiptOf('msg_a', 'r') });
  first.settle();
  const twoMarks = {
    role: 'user',
    content: [
      { type: 'text', text: 'y', cache_control: marked },
      { type: 'text', text: 'z', cache_control: marked },
    ],
  };
  const next = { ...body, messages: [...body.messages, { role: 'assistant', content: 'r' }, twoMarks] };
  const plan = planAnthropicThread({ provider: 'anthropic', config: {}, opts, body: next, account: 'a' });
  assert.notEqual(plan.mode, 'continue');
});

test('unsupported models and context editing are never threaded', () => {
  const opts = { sessionId: 's' };
  const base = { messages: [{ role: 'user', content: 'x' }] };
  assert.equal(
    planAnthropicThread({
      provider: 'anthropic',
      config: {},
      opts,
      body: { ...base, model: 'claude-3-opus' },
      account: 'a',
    }).mode,
    'none'
  );
  assert.equal(
    planAnthropicThread({
      provider: 'anthropic',
      config: {},
      opts,
      body: { ...base, model: 'claude-haiku-4-5' },
      account: 'a',
    }).mode,
    'create'
  );
  assert.equal(
    planAnthropicThread({
      provider: 'anthropic',
      config: {},
      opts,
      body: { ...base, model: MODEL, context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } },
      account: 'a',
    }).mode,
    'none'
  );
});
