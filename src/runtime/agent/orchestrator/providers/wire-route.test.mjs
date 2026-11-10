import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isWireUnsupportedError,
  pinSessionWireRoute,
  resolveWireRoute,
  sendOnRoute,
  sendWireRoute,
} from './wire-route.mjs';

const wireOf = (provider, model, ctx) => resolveWireRoute(provider, model, ctx)?.wire;
const sourceOf = (provider, model, ctx) => resolveWireRoute(provider, model, ctx)?.source;

test('resolution order: override, then catalog/endpoints, then family, then default', () => {
  // Family alone.
  assert.deepEqual(resolveWireRoute('openrouter', 'anthropic/claude-sonnet-5'), {
    wire: 'messages',
    profileId: 'openrouter:messages',
    source: 'family',
  });
  // An override beats the family.
  assert.equal(wireOf('openrouter', 'anthropic/claude-sonnet-5', { override: 'chat' }), 'chat');
  assert.equal(sourceOf('openrouter', 'anthropic/claude-sonnet-5', { override: 'chat' }), 'override');
  // Catalog metadata beats the family.
  assert.equal(wireOf('opencode-go', 'gpt-6-luna', { catalogWire: 'chat' }), 'chat');
  assert.equal(sourceOf('opencode-go', 'gpt-6-luna', { catalogWire: 'chat' }), 'catalog');
  // A single advertised endpoint beats the family.
  assert.equal(wireOf('command-code-oauth', 'gpt-5.5', { endpoints: ['chat'] }), 'chat');
  assert.equal(sourceOf('command-code-oauth', 'gpt-5.5', { endpoints: ['chat'] }), 'endpoints');
  // The family picks among several advertised endpoints; the default otherwise.
  assert.equal(wireOf('command-code-oauth', 'gpt-5.5', { endpoints: ['chat', 'responses'] }), 'responses');
  assert.equal(sourceOf('command-code-oauth', 'glm-5', { endpoints: ['chat', 'responses'] }), 'default');
  assert.equal(sourceOf('openrouter', 'openrouter/auto'), 'default');
  // A provider without a profile has no route.
  assert.equal(resolveWireRoute('anthropic-oauth', 'claude-opus-5'), null);
});

test('no tier guesses an endpoint the gateway does not offer', () => {
  // Overrides to wires the gateway lacks are ignored.
  assert.equal(wireOf('deepseek', 'deepseek-v4-pro', { override: 'responses', agent: true }), 'messages');
  assert.equal(wireOf('command-code-oauth', 'glm-5', { override: 'messages', endpoints: ['chat'] }), 'chat');
  // OpenCode Go's Gemini catalog answer routes to its generateContent endpoint.
  assert.deepEqual(resolveWireRoute('opencode-go', 'gemini-4-argon', { catalogWire: 'gemini' }), {
    wire: 'gemini',
    profileId: 'opencode-go:gemini',
    source: 'catalog',
  });
  assert.equal(wireOf('opencode-go', 'gemini-4-argon-contributor'), 'gemini');
  // Advertised endpoints narrow the family and the default.
  assert.equal(wireOf('command-code-oauth', 'claude-sonnet-5', { endpoints: ['messages', 'responses'] }), 'messages');
  assert.equal(wireOf('command-code-oauth', 'responses-only', { endpoints: ['responses'] }), 'responses');
  assert.equal(resolveWireRoute('command-code-oauth', 'embeddings-only', { endpoints: [] }), null);
  // Nothing describes the model: the conventional wire, flagged.
  assert.equal(sourceOf('command-code-oauth', 'claude-x', { known: false }), 'unknown');
  assert.equal(wireOf('command-code-oauth', 'claude-x', { known: false, override: 'messages' }), 'messages');
});

test('without model info Claude keeps Messages while GPT / Muse / Grok do not flip off Chat', () => {
  // Claude answers on /messages only (Command Code Provider API docs).
  assert.equal(wireOf('command-code-oauth', 'claude-sonnet-5', { known: false }), 'messages');
  assert.equal(wireOf('command-code-oauth', 'anthropic/claude-sonnet-5', { known: false }), 'messages');
  assert.equal(sourceOf('command-code-oauth', 'claude-sonnet-5', { known: false }), 'unknown');
  // The roster decides everything else; without it the conventional wire stays.
  for (const model of ['gpt-5.5', 'muse-spark-1.3', 'grok-4.7', 'glm-5']) {
    assert.equal(wireOf('command-code-oauth', model, { known: false }), 'chat', model);
  }
  // With the roster row the family picks Responses among several wires.
  assert.equal(wireOf('command-code-oauth', 'grok-4.7', { endpoints: ['chat', 'responses'] }), 'responses');
});

test('exclude removes a wire from every tier', () => {
  assert.equal(
    wireOf('command-code-oauth', 'gpt-5.5', { endpoints: ['chat', 'responses'], exclude: ['responses'] }),
    'chat'
  );
  assert.equal(wireOf('openrouter', 'anthropic/claude-opus-4.8', { exclude: ['messages'] }), 'chat');
  assert.equal(
    wireOf('openrouter', 'anthropic/claude-opus-4.8', { override: 'messages', exclude: ['messages'] }),
    'chat'
  );
  assert.equal(resolveWireRoute('command-code-oauth', 'x', { endpoints: ['chat'], exclude: ['chat'] }), null);
});

test('OpenRouter routes Claude to Messages, OpenAI GPT/o-series to Responses, the rest to Chat', () => {
  const cases = {
    'anthropic/claude-opus-4.8': 'messages',
    'anthropic/claude-haiku-4.5:batch': 'messages',
    '~anthropic/claude-opus-latest': 'messages',
    'openai/gpt-6.1-sol': 'responses',
    'openai/o3': 'responses',
    'openai/o4-mini-high': 'responses',
    '~openai/gpt-sol-latest': 'responses',
    'openrouter/auto': 'chat',
    'openai/text-embedding-3': 'chat',
    'google/gemini-4-argon': 'chat',
    'deepseek/deepseek-v4-pro': 'chat',
  };
  for (const [model, wire] of Object.entries(cases)) assert.equal(wireOf('openrouter', model), wire, model);
});

test('OpenCode Go adds Claude to the cold-catalog Messages prefixes', () => {
  for (const model of ['claude-haiku-5-5', 'minimax-m3', 'qwen3.7-max']) {
    assert.equal(wireOf('opencode-go', model), 'messages', model);
  }
  for (const model of ['gpt-6-luna', 'grok-4.7', 'muse-spark-1.3'])
    assert.equal(wireOf('opencode-go', model), 'responses');
  for (const model of ['glm-5.2', 'kimi-k3', 'deepseek-v4-pro']) assert.equal(wireOf('opencode-go', model), 'chat');
});

test('DeepSeek selects Messages for agent/tool requests and never Responses', () => {
  assert.equal(wireOf('deepseek', 'deepseek-v4-pro', { agent: true }), 'messages');
  assert.equal(wireOf('deepseek', 'deepseek-v4-pro', { agent: false }), 'chat');
  assert.equal(wireOf('deepseek', 'deepseek-v4-pro', { agent: true, override: 'chat' }), 'chat');
});

test('legacy resolution reproduces the wire an existing session started on', () => {
  const legacy = (provider, model, ctx = {}) => resolveWireRoute(provider, model, { ...ctx, legacy: true });
  assert.deepEqual(legacy('openrouter', 'anthropic/claude-opus-4.8'), {
    wire: 'chat',
    profileId: 'openrouter:chat',
    source: 'legacy',
  });
  assert.equal(legacy('openrouter', 'openai/gpt-6-sol').wire, 'chat');
  assert.equal(legacy('deepseek', 'deepseek-v4-pro', { agent: true }).wire, 'chat');
  // Go: cold-catalog Claude was Chat; catalog answers and older prefixes keep theirs.
  assert.equal(legacy('opencode-go', 'claude-haiku-5-5').wire, 'chat');
  assert.equal(legacy('opencode-go', 'claude-haiku-5-5', { catalogWire: 'messages' }).wire, 'messages');
  assert.equal(legacy('opencode-go', 'minimax-m3').wire, 'messages');
  assert.equal(legacy('opencode-go', 'gpt-6-luna').wire, 'responses');
  assert.equal(legacy('opencode-go', 'gemini-4-argon', { catalogWire: 'gemini' }).wire, 'chat');
  // Command Code: Chat whenever declared (or undeclared), Messages only alone.
  assert.equal(legacy('command-code-oauth', 'gpt-5.5', { endpoints: ['chat', 'responses'] }).wire, 'chat');
  assert.equal(legacy('command-code-oauth', 'claude-sonnet-5', { endpoints: ['messages'] }).wire, 'messages');
  assert.equal(legacy('command-code-oauth', 'x', { known: false }).source, 'unknown');
  // An existing session's pin is not overridden by a later per-model override.
  assert.equal(legacy('openrouter', 'anthropic/claude-opus-4.8', { override: 'messages' }).wire, 'chat');
});

function fakeProvider(name, resolve = (model, ctx) => resolveWireRoute(name, model, ctx)) {
  const calls = [];
  return {
    name,
    calls,
    resolveWireRoute: async (model, ctx) => {
      calls.push({ model, ctx });
      return resolve(model, ctx);
    },
  };
}

test('a new session pins the fresh route; an existing session pins the wire it started on', async () => {
  const provider = fakeProvider('openrouter');
  const fresh = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wireRoute: null, messages: [] };
  assert.equal((await pinSessionWireRoute(fresh, provider)).wire, 'messages');
  assert.deepEqual(fresh.wireRoute, {
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4.8',
    wire: 'messages',
    profileId: 'openrouter:messages',
    source: 'family',
  });
  // Created before the table (no wireRoute field) and already talked to its model.
  const existing = {
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4.8',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  };
  assert.equal((await pinSessionWireRoute(existing, provider)).wire, 'chat');
  assert.equal(existing.wireRoute.source, 'legacy');
  // Created before the table but never answered: resolves fresh.
  const unanswered = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', messages: [] };
  assert.equal((await pinSessionWireRoute(unanswered, provider)).wire, 'messages');
});

test('a pinned route is reused as is; a route change resolves fresh', async () => {
  const provider = fakeProvider('openrouter');
  const pinned = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wire: 'chat', source: 'legacy' };
  const session = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wireRoute: pinned, messages: [] };
  assert.equal(await pinSessionWireRoute(session, provider), pinned);
  assert.equal(provider.calls.length, 0);
  session.model = 'openai/gpt-6-sol';
  assert.equal((await pinSessionWireRoute(session, provider)).wire, 'responses');
  assert.equal(provider.calls[0].ctx.legacy, false);
});

test('a single-wire adapter, a failed resolution and an unknown model pin nothing', async () => {
  const session = () => ({ provider: 'p', model: 'm', wireRoute: null, messages: [] });
  const single = session();
  assert.equal(await pinSessionWireRoute(single, { name: 'p' }), null);
  assert.equal(single.wireRoute, null);
  const failing = session();
  const failed = await pinSessionWireRoute(failing, {
    resolveWireRoute: async () => {
      throw new Error('roster down');
    },
  });
  assert.equal(failed, null);
  assert.equal(failing.wireRoute, null);
  const unknown = { ...session(), provider: 'command-code-oauth' };
  assert.equal(
    await pinSessionWireRoute(
      unknown,
      fakeProvider('command-code-oauth', (m) => resolveWireRoute('command-code-oauth', m, { known: false }))
    ),
    null
  );
  assert.equal(unknown.wireRoute, null);
});

test('an existing session keeps its wire when metadata recovers between the pin and the send', async () => {
  const model = 'gpt-5.5';
  for (const failure of ['unknown', 'throws']) {
    let down = true;
    const provider = fakeProvider('command-code-oauth', (m, ctx) => {
      if (down && failure === 'throws') throw new Error('roster down');
      return resolveWireRoute('command-code-oauth', m, { ...ctx, endpoints: ['chat', 'responses'], known: !down });
    });
    const session = {
      provider: 'command-code-oauth',
      model,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'next' },
      ],
    };
    assert.equal(await pinSessionWireRoute(session, provider), null, failure);
    assert.equal(session.wireRoute, undefined, failure);
    down = false;
    const route = await sendWireRoute(provider, model, [{ name: 't' }], { session });
    assert.equal(route.wire, 'chat', failure);
    assert.equal(route.source, 'legacy', failure);
    // The legacy decision is pinned; later sends keep it while the model still offers it.
    assert.equal(session.wireRoute.wire, 'chat', failure);
    assert.equal(await sendWireRoute(provider, model, [], { session }), session.wireRoute);
  }
  // A session without assistant history resolves fresh and stays unpinned.
  const fresh = { provider: 'command-code-oauth', model, messages: [{ role: 'user', content: 'hi' }] };
  const provider = fakeProvider('command-code-oauth', (m, ctx) =>
    resolveWireRoute('command-code-oauth', m, { ...ctx, endpoints: ['chat', 'responses'] })
  );
  assert.equal((await sendWireRoute(provider, model, [], { session: fresh })).wire, 'responses');
  assert.equal(fresh.wireRoute, undefined);
});

test('a send uses the pinned route for its own provider and model, else resolves', async () => {
  const provider = fakeProvider('openrouter');
  const pinned = {
    provider: 'openrouter',
    model: 'anthropic/claude-opus-4.8',
    wire: 'chat',
    profileId: 'openrouter:chat',
  };
  assert.equal(await sendWireRoute(provider, 'anthropic/claude-opus-4.8', [], { wireRoute: pinned }), pinned);
  assert.equal(
    await sendWireRoute(provider, 'anthropic/claude-opus-4.8', [], { session: { wireRoute: pinned } }),
    pinned
  );
  // Another model (e.g. a compaction model) resolves its own route.
  assert.equal((await sendWireRoute(provider, 'openai/o3', [], { wireRoute: pinned })).wire, 'responses');
  // A pin to a wire the provider does not serve is ignored.
  const deepseek = fakeProvider('deepseek');
  const bogus = { provider: 'deepseek', model: 'deepseek-v4-pro', wire: 'responses' };
  assert.equal(
    (await sendWireRoute(deepseek, 'deepseek-v4-pro', [{ name: 't' }], { wireRoute: bogus })).wire,
    'messages'
  );
  assert.equal((await sendWireRoute(deepseek, 'deepseek-v4-pro', [], {})).wire, 'chat');
});

test('legacy resolution never selects a wire the model does not advertise', () => {
  const route = resolveWireRoute('command-code-oauth', 'responses-only', { endpoints: ['responses'], legacy: true });
  assert.equal(route.wire, 'responses');
  assert.notEqual(route.source, 'legacy');
  // Still offered: the legacy wire stays.
  assert.equal(
    resolveWireRoute('command-code-oauth', 'gpt-5.5', { endpoints: ['chat', 'responses'], legacy: true }).source,
    'legacy'
  );
  // Nothing offered: not routable.
  assert.equal(resolveWireRoute('command-code-oauth', 'x', { endpoints: [], legacy: true }), null);
});

test('an unknown model with no advertised endpoint is not routable', () => {
  assert.equal(resolveWireRoute('command-code-oauth', 'x', { known: false, endpoints: [] }), null);
  assert.equal(
    resolveWireRoute('command-code-oauth', 'x', { known: false, endpoints: ['responses'] }).wire,
    'responses'
  );
  assert.equal(resolveWireRoute('command-code-oauth', 'x', { known: false }).source, 'unknown');
});

test('a pinned wire the model no longer offers is resolved fresh and re-pinned; nothing offered throws', async () => {
  let endpoints = ['chat', 'responses'];
  const provider = fakeProvider('command-code-oauth', (m, ctx) =>
    resolveWireRoute('command-code-oauth', m, { ...ctx, endpoints })
  );
  const model = 'gpt-5.5';
  const pin = {
    provider: 'command-code-oauth',
    model,
    wire: 'chat',
    profileId: 'command-code-oauth:chat',
    source: 'legacy',
  };
  const session = { provider: 'command-code-oauth', model, wireRoute: pin, messages: [] };
  assert.equal(await sendWireRoute(provider, model, [], { session }), pin);
  endpoints = ['responses'];
  const route = await sendWireRoute(provider, model, [], { session });
  assert.equal(route.wire, 'responses');
  assert.notEqual(route.source, 'legacy');
  assert.equal(session.wireRoute, route, 'the fresh route is re-pinned');
  endpoints = [];
  await assert.rejects(sendWireRoute(provider, model, [], { session }), { code: 'MODEL_NOT_ROUTABLE' });
  await assert.rejects(sendWireRoute(provider, model, [], {}), { code: 'MODEL_NOT_ROUTABLE' });
});

test('only a clear endpoint refusal counts as an unsupported wire', () => {
  const http = (status, message) => Object.assign(new Error(message), { status });
  assert.equal(isWireUnsupportedError(http(405, 'Method Not Allowed')), true);
  assert.equal(isWireUnsupportedError(http(501, 'not implemented')), true);
  assert.equal(isWireUnsupportedError(http(400, 'This model is not supported on the /v1/responses endpoint')), true);
  assert.equal(
    isWireUnsupportedError(http(404, 'Unsupported route: use the /v1/messages endpoint for Claude models')),
    true
  );
  // Not an endpoint refusal: parameters, unknown model, auth, quota, server, abort.
  assert.equal(isWireUnsupportedError(http(400, 'Unsupported parameter: temperature')), false);
  assert.equal(isWireUnsupportedError(http(404, 'model gpt-x not found')), false);
  assert.equal(isWireUnsupportedError(http(401, 'endpoint not supported for this key')), false);
  assert.equal(isWireUnsupportedError(http(403, 'endpoint not supported for this plan')), false);
  assert.equal(isWireUnsupportedError(http(429, 'quota: endpoint not supported')), false);
  assert.equal(isWireUnsupportedError(http(500, 'endpoint not supported')), false);
  assert.equal(isWireUnsupportedError(Object.assign(http(405, 'x'), { liveTextEmitted: true })), false);
  assert.equal(isWireUnsupportedError(Object.assign(http(405, 'x'), { streamStalled: true })), false);
  assert.equal(isWireUnsupportedError(new Error('terminated')), false);
});

function routedProvider(name, endpoints) {
  return {
    name,
    resolveWireRoute: async (model, ctx) => resolveWireRoute(name, model, { ...ctx, endpoints }),
  };
}

test('an unsupported refusal before any output switches wire once and records the reroute', async () => {
  const provider = routedProvider('command-code-oauth', ['chat', 'responses']);
  const model = 'gpt-5.5';
  const pin = { provider: 'command-code-oauth', model, wire: 'responses', profileId: 'command-code-oauth:responses' };
  const session = {
    provider: 'command-code-oauth',
    model,
    wireRoute: pin,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', reasoningContent: 'r' },
    ],
  };
  const history = [...session.messages, { role: 'user', content: 'next' }];
  const calls = [];
  const out = await sendOnRoute(
    provider,
    model,
    [],
    { session, compatWireApi: 'responses' },
    history,
    async (wire, h, opts) => {
      calls.push({ wire, h, opts });
      if (wire === 'responses')
        throw Object.assign(new Error('responses endpoint is not supported for this model'), { status: 400 });
      return { content: 'ok' };
    }
  );
  assert.equal(out.content, 'ok');
  assert.deepEqual(
    calls.map((c) => c.wire),
    ['responses', 'chat']
  );
  assert.equal('compatWireApi' in calls[0].opts, false, 'a caller wire switch never reaches an engine');
  assert.equal(session.wireRoute.wire, 'chat');
  assert.equal(session.wireRoute.source, 'reroute');
  assert.equal(session.wireRoute.reroutedFrom, 'responses');
  assert.equal('reasoningContent' in calls[1].h[1], false, 'history written on the old wire is lowered');
  assert.equal('reasoningContent' in history[1], true, 'the stored transcript itself is untouched');
});

test('a wire switch never follows output, auth, quota, abort or a second refusal', async () => {
  const model = 'gpt-5.5';
  const refuse = () => Object.assign(new Error('endpoint not supported'), { status: 400 });
  const run = (provider, dispatch, opts = {}) =>
    sendOnRoute(provider, model, [], opts, [{ role: 'user', content: 'q' }], dispatch);
  const both = () => routedProvider('command-code-oauth', ['chat', 'responses']);

  // Output already shown to the caller.
  let calls = 0;
  await assert.rejects(
    run(
      both(),
      async (wire, _h, opts) => {
        calls++;
        opts.onTextDelta('partial');
        throw refuse();
      },
      { onTextDelta() {} }
    ),
    /not supported/
  );
  assert.equal(calls, 1);

  // A tool call or reasoning delta counts as output too.
  calls = 0;
  await assert.rejects(
    run(
      both(),
      async (wire, _h, opts) => {
        calls++;
        opts.onStreamDelta('reasoning');
        throw refuse();
      },
      { onStreamDelta() {} }
    )
  );
  assert.equal(calls, 1);

  // Auth / quota / transport failures surface unchanged.
  for (const status of [401, 403, 429, 500]) {
    calls = 0;
    await assert.rejects(
      run(both(), async () => {
        calls++;
        throw Object.assign(new Error('endpoint not supported'), { status });
      })
    );
    assert.equal(calls, 1, String(status));
  }

  // An aborted send.
  calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run(
      both(),
      async () => {
        calls++;
        throw refuse();
      },
      { signal: controller.signal }
    )
  );
  assert.equal(calls, 1);

  // Switch once: the second wire's refusal is the error, with no third attempt.
  const wires = [];
  await assert.rejects(
    run(routedProvider('openrouter', ['chat', 'messages', 'responses']), async (wire) => {
      wires.push(wire);
      throw refuse();
    }),
    /not supported/
  );
  assert.equal(wires.length, 2);

  // A model served on no other wire keeps its error.
  calls = 0;
  await assert.rejects(
    run(routedProvider('command-code-oauth', ['responses']), async () => {
      calls++;
      throw refuse();
    })
  );
  assert.equal(calls, 1);
});

test('a typed parameter, quota or billing error that mentions an endpoint never switches wire', () => {
  const http = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
  // Parameter rejection on a 400, even though the message says "endpoint".
  assert.equal(isWireUnsupportedError(http(400, 'Unsupported parameter: temperature for this API endpoint')), false);
  assert.equal(
    isWireUnsupportedError(
      http(400, 'Unsupported parameter: temperature for this API endpoint', { param: 'temperature' })
    ),
    false
  );
  assert.equal(
    isWireUnsupportedError(
      http(400, 'bad request', {
        providerErrorCode: 'unsupported_parameter',
        message: 'this endpoint is not supported',
      })
    ),
    false
  );
  // Typed quota / billing / auth, with endpoint-unavailable wording.
  assert.equal(
    isWireUnsupportedError(
      http(400, 'The responses endpoint is not available on your plan', { code: 'insufficient_quota' })
    ),
    false
  );
  assert.equal(
    isWireUnsupportedError(
      http(404, 'The /v1/messages endpoint is not available', { error: { type: 'billing_error' } })
    ),
    false
  );
  assert.equal(isWireUnsupportedError(http(404, 'endpoint unavailable', { quotaExhausted: true })), false);
  assert.equal(isWireUnsupportedError(http(405, 'This endpoint is not available: add credits to your balance')), false);
  assert.equal(isWireUnsupportedError(http(400, 'invalid api key for this endpoint, not supported')), false);
  // A bare "API" is not an endpoint word.
  assert.equal(isWireUnsupportedError(http(400, 'model is not supported by this API')), false);
  // The specific wire rejection still qualifies when typed neutrally.
  assert.equal(
    isWireUnsupportedError(
      http(400, 'This model is not supported on the /v1/responses endpoint', { code: 'invalid_request_error' })
    ),
    true
  );
});

test('consecutive sends reusing one opts object follow the session pin through reroutes', async () => {
  const model = 'gpt-5.5';
  const pin = { provider: 'command-code-oauth', model, wire: 'responses', profileId: 'command-code-oauth:responses' };
  const session = { provider: 'command-code-oauth', model, wireRoute: pin, messages: [{ role: 'user', content: 'q' }] };
  const provider = {
    name: 'command-code-oauth',
    resolveWireRoute: async (m, ctx) => {
      const exclude = ctx.exclude || [];
      const wires = ['responses', 'chat'].filter((wire) => !exclude.includes(wire));
      const keep = ctx.keep && wires.includes(ctx.keep) ? ctx.keep : null;
      const wire = keep || wires[0];
      return { wire, profileId: `command-code-oauth:${wire}`, source: keep ? 'pinned' : 'endpoints' };
    },
  };
  const sendOpts = { session, wireRoute: pin }; // the same opts object every send of the turn
  const refuse = (wire) =>
    Object.assign(new Error(`${wire} endpoint is not supported for this model`), { status: 400 });
  const seen = [];
  // The gateway refuses whichever wire is tried first; the other one answers.
  for (const refused of ['responses', 'chat', 'responses']) {
    const wires = [];
    await sendOnRoute(provider, model, [], sendOpts, session.messages, async (wire) => {
      wires.push(wire);
      if (wire === refused) throw refuse(wire);
      return { content: 'ok' };
    });
    seen.push(wires);
  }
  // Send 1 starts on the pin (responses) and moves to chat. Send 2 starts on
  // the session's current pin (chat), not the stale opts copy, and moves back.
  assert.deepEqual(seen, [
    ['responses', 'chat'],
    ['chat', 'responses'],
    ['responses', 'chat'],
  ]);
  assert.equal(session.wireRoute.wire, 'chat');
});
