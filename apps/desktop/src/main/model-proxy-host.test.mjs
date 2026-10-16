import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createModelProxyHost, createModelProxyRuntime } from './model-proxy-host.ts';
import {
  MODEL_PROXY_REQUEST_EVENT,
  MODEL_PROXY_OPERATIONS,
  ModelProxyChannel,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import {
  pinSessionWireRoute,
  resolveWireRoute,
} from '../../../../src/runtime/agent/orchestrator/providers/wire-route.mjs';
import {
  ModelProxyProvider,
  _resetModelProxyProviderConfigForTest,
  loadModelProxyProviderConfig,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs';

/** Daemon channel <-> PC host over a JSON hop, as the session connection does. */
function connect(t, runtime, { intercept = null, channel = new ModelProxyChannel(), ...hostOptions } = {}) {
  const operations = [];
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      operations.push(operation);
      await intercept?.(operation);
      const wireArgs = JSON.parse(JSON.stringify(args));
      return JSON.parse(JSON.stringify((await channel.handleOperation(operation, wireArgs)) ?? null));
    },
    loadRuntime: async () => runtime,
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  t.after(() => {
    detach();
    host.dispose();
  });
  return { channel, host, operations };
}

function fakeRuntime(providers, extra = {}) {
  return {
    provider: async (name) => providers[name],
    providerConfig: async () => ({ providers: {}, ready: true }),
    finalizeTools: (tools) => tools,
    ...extra,
  };
}

test('the PC runs the call with its own provider and streams every callback back in order', async (t) => {
  const calls = [];
  const provider = {
    async send(messages, model, tools, options) {
      calls.push({ messages, model, tools, options: Object.keys(options).sort() });
      options.onStageChange('streaming');
      options.onTextDelta('Hel');
      options.onTextDelta('lo');
      const acked = await options.onTextReset({ chars: 5 });
      options.onTextDelta(acked === true ? 'again' : 'unacked');
      return { content: 'Hello again', usage: { inputTokens: 7, outputTokens: 2 } };
    },
  };
  const { channel, host } = connect(t, fakeRuntime({ 'anthropic-oauth': provider }));
  const seen = [];
  const result = await new ModelProxyProvider('anthropic-oauth', {}, channel).send(
    [{ role: 'user', content: 'hi' }],
    'claude-test',
    [{ name: 'read', input_schema: {} }],
    {
      sessionId: 'pc-session',
      onStageChange: (stage) => {
        seen.push(['stage', stage]);
      },
      onTextDelta: (text) => {
        seen.push(['text', text]);
      },
      onTextReset: async ({ chars }) => {
        seen.push(['reset', chars]);
        return true;
      },
    }
  );
  assert.deepEqual(result, { content: 'Hello again', usage: { inputTokens: 7, outputTokens: 2 } });
  assert.deepEqual(seen, [
    ['stage', 'streaming'],
    ['text', 'Hel'],
    ['text', 'lo'],
    ['reset', 5],
    ['text', 'again'],
  ]);
  assert.deepEqual(calls, [
    {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-test',
      tools: [{ name: 'read', input_schema: {} }],
      options: ['onStageChange', 'onTextDelta', 'onTextReset', 'sessionId', 'signal'],
    },
  ]);
  // The daemon settles on the PC's resolve; the PC retires the call right after.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.running, 0);
});

test('the provider send result reaches the daemon unchanged, wireReroute included', async (t) => {
  const wireReroute = { from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, reason: 'x' };
  const provider = {
    async send() {
      return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, wireReroute };
    },
  };
  const { channel } = connect(t, fakeRuntime({ 'anthropic-oauth': provider }));
  const result = await new ModelProxyProvider('anthropic-oauth', {}, channel).send(
    [{ role: 'user', content: 'hi' }],
    'claude-test',
    [],
    { sessionId: 'pc-session' }
  );
  assert.deepEqual(result.wireReroute, wireReroute);
});

test('the PC serves only the named provider and the allowed methods', async (t) => {
  const listed = [];
  const provider = {
    send: async () => ({ content: 'x' }),
    listModels: async () => {
      listed.push('list');
      return [{ id: 'model-a' }, { id: 'model-b' }];
    },
    getCachedModelInfo: (id) => (id === 'model-a' ? { contextWindow: 1000 } : null),
  };
  const { channel } = connect(
    t,
    fakeRuntime(
      { openai: provider },
      { providerConfig: async () => ({ providers: { openai: { enabled: true, modelProxy: {} } } }) }
    )
  );
  await assert.rejects(new ModelProxyProvider('gemini', {}, channel).send([], 'g', undefined, {}), {
    code: 'MODEL_PROXY_PROVIDER_UNAVAILABLE',
    message: /"gemini" is not enabled on this PC/,
  });
  await assert.rejects(channel.request({ provider: 'openai', method: 'forgetCredentials' }), /not allowed/);
  const proxied = new ModelProxyProvider('openai', {}, channel);
  assert.deepEqual(await proxied.listModels(), [{ id: 'model-a' }, { id: 'model-b' }]);
  assert.deepEqual(proxied.getCachedModelInfo('model-a'), { contextWindow: 1000 });
  assert.equal(proxied.getCachedModelInfo('model-b'), null);
  assert.deepEqual(await channel.request({ provider: '', method: 'providerConfig' }), {
    providers: { openai: { enabled: true, modelProxy: {} } },
    ready: true,
  });
});

test('a daemon-side abort aborts the PC provider call', async (t) => {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const provider = {
    send(_messages, _model, _tools, options) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          stopped.resolve(options.signal.reason);
          reject(options.signal.reason);
        });
      });
    },
  };
  const { channel, host, operations } = connect(t, fakeRuntime({ openai: provider }), { heartbeatMs: 20 });
  const controller = new AbortController();
  const sending = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {
    signal: controller.signal,
  });
  await started.promise;
  assert.equal(host.running, 1);
  controller.abort(new Error('user stop'));
  await assert.rejects(sending, /user stop/);
  const reason = await stopped.promise;
  assert.equal(reason.name, 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.running, 0);
  // The PC acknowledged, so the daemon holds nothing for the call.
  assert.deepEqual(channel.snapshot(), { requests: [], cancelled: [] });
  assert.ok(operations.includes('modelProxyResolve'));
});

/** Await a promise driven by the host's own timers. Those are unref'd (they
 *  must never keep the app alive), so the test holds the event loop open
 *  itself, and fails instead of hanging after `limitMs`. */
async function settledWhileAlive(promise, limitMs = 2_000) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${limitMs}ms`)), limitMs);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** A PC provider call that only ends when its signal aborts. */
function hangingProvider() {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  return {
    started: started.promise,
    stopped: stopped.promise,
    send(_messages, _model, _tools, options) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          stopped.resolve(options.signal.reason);
          reject(options.signal.reason);
        });
      });
    },
  };
}

test('a daemon silent past its lease makes the PC abandon every active call', async (t) => {
  const provider = hangingProvider();
  let now = 1_000;
  let daemonSilent = false;
  const { channel, host } = connect(t, fakeRuntime({ openai: provider }), {
    heartbeatMs: 5,
    leaseMs: 100,
    now: () => now,
    intercept: async (operation) => {
      if (daemonSilent && operation === 'modelProxyHeartbeat') throw new Error('connection lost');
    },
  });
  const daemonCall = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  await provider.started;
  assert.equal(host.running, 1);
  daemonSilent = true;
  // Failed heartbeats inside the lease keep the call running.
  now += 50;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.running, 1);
  // Past the lease: aborted and dropped locally.
  now += 100;
  const reason = await settledWhileAlive(provider.stopped);
  assert.equal(reason.code, 'MODEL_PROXY_UNAVAILABLE');
  assert.equal(host.running, 0);
  // Its settle still reached this (live) test daemon, so nothing is left over.
  await assert.rejects(settledWhileAlive(daemonCall), /stopped answering/);
});

test('disposing the host aborts and drops every active call', async (t) => {
  const provider = hangingProvider();
  const { channel, host } = connect(t, fakeRuntime({ openai: provider }));
  const daemonCall = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  await provider.started;
  assert.equal(host.running, 1);
  host.dispose();
  assert.equal(host.running, 0);
  const reason = await settledWhileAlive(provider.stopped);
  assert.equal(reason.name, 'AbortError');
  await assert.rejects(settledWhileAlive(daemonCall), /desktop app is closing/);
});

/** The PC's registry modules: empty until initProviders, keys read on demand. */
function pcModules(available, keys = {}) {
  const live = new Map();
  const keyReads = [];
  const inits = [];
  return {
    keyReads,
    probeAuth: () => 'present',
    inits,
    live,
    loadConfig: (options) => {
      assert.deepEqual(options, { secrets: 'presence' });
      return { providers: structuredClone(available) };
    },
    initProviders: async (config) => {
      inits.push(structuredClone(config));
      live.clear();
      const enabled = Object.entries(config).filter(([, entry]) => entry.enabled === true);
      if (!enabled.length) throw Object.assign(new Error('all providers disabled in config'), { code: 'PROVIDERS_NONE_ENABLED' });
      for (const [name, entry] of enabled) {
        live.set(name, { send: async () => ({ content: `${name}:${entry.apiKey ?? 'no-key'}` }) });
      }
    },
    getProvider: (name) => live.get(name),
    getAllProviders: () => live,
    readApiKey: async (name) => {
      keyReads.push(name);
      return keys[name] ?? null;
    },
    finalizeProviderRequestTools: (tools) => tools,
  };
}

test('cold start: the daemon waits for a PC that connects late and loads its registry on demand', async (t) => {
  _resetModelProxyProviderConfigForTest();
  t.after(() => _resetModelProxyProviderConfigForTest());
  const modules = pcModules({ openai: { enabled: true }, gemini: { enabled: false } });
  const channel = new ModelProxyChannel();
  // The daemon asks before any client is connected and the PC registry is empty.
  const loading = loadModelProxyProviderConfig({ channel, waitMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(modules.live.size, 0);
  connect(t, createModelProxyRuntime(modules), { channel });
  const config = await settledWhileAlive(loading);
  assert.deepEqual(config, {
    openai: { enabled: true, authState: 'present', modelProxy: {} },
    gemini: { enabled: false, authState: 'present', modelProxy: {} },
  });
  // Availability needs no credential value.
  assert.deepEqual(modules.keyReads, []);
});

test('the daemon retries an unready PC answer instead of reading it as "all disabled"', async (t) => {
  _resetModelProxyProviderConfigForTest();
  t.after(() => _resetModelProxyProviderConfigForTest());
  let asked = 0;
  const { channel } = connect(
    t,
    fakeRuntime(
      {},
      {
        providerConfig: async () =>
          ++asked === 1
            ? { providers: {}, ready: false }
            : { providers: { openai: { enabled: true, modelProxy: {} } }, ready: true },
      }
    )
  );
  const config = await settledWhileAlive(loadModelProxyProviderConfig({ channel, waitMs: 2_000 }));
  assert.deepEqual(config, { openai: { enabled: true, modelProxy: {} } });
  assert.equal(asked, 2);
});

test('a loaded PC registry with nothing enabled is an answer, not a wait', async (t) => {
  _resetModelProxyProviderConfigForTest();
  t.after(() => _resetModelProxyProviderConfigForTest());
  const modules = pcModules({ openai: { enabled: false } });
  const { channel } = connect(t, createModelProxyRuntime(modules));
  const config = await settledWhileAlive(loadModelProxyProviderConfig({ channel, waitMs: 5_000 }), 1_000);
  assert.deepEqual(config, { openai: { enabled: false, authState: 'present', modelProxy: {} } });
});

test('only the requested provider\'s credential is read, on demand', async (t) => {
  const modules = pcModules(
    { openai: { enabled: true }, anthropic: { enabled: true } },
    { openai: 'pc-openai-key', anthropic: 'pc-anthropic-key' }
  );
  const { channel } = connect(t, createModelProxyRuntime(modules));
  const result = await new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  assert.deepEqual(result, { content: 'openai:pc-openai-key' });
  assert.deepEqual(modules.keyReads, ['openai']);
  assert.equal(modules.inits.at(-1).anthropic.apiKey, undefined);
});

test('server send options are reduced to the allowlist', async (t) => {
  let seen = null;
  const provider = {
    async send(_messages, _model, _tools, options) {
      seen = options;
      return { content: 'ok' };
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: provider }));
  await new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {
    sessionId: 's1',
    temperature: 0.2,
    baseURL: 'http://attacker.example',
    requestHeaders: { authorization: 'Bearer x' },
    extraBody: { stolen: true },
    codexInstallationId: 'pc-identity',
    _providerSeam: true,
  });
  assert.deepEqual(Object.keys(seen).sort(), ['sessionId', 'signal', 'temperature']);
  assert.ok(seen.signal instanceof AbortSignal);
});

test('a proxied side request gets its own transport scope on the PC, disposed when the request ends', async (t) => {
  const closed = [];
  const previousHook = globalThis.__mixdogCloseProviderConnectionsForSession;
  globalThis.__mixdogCloseProviderConnectionsForSession = (scope) => closed.push(scope);
  t.after(() => {
    globalThis.__mixdogCloseProviderConnectionsForSession = previousHook;
  });
  const sends = [];
  const released = [];
  const hung = Promise.withResolvers();
  const provider = {
    releaseTransportScope: (scope) => released.push(scope),
    async send(_messages, _model, _tools, options) {
      sends.push(options);
      if (options.sessionId === 'fail') throw new Error('provider down');
      if (options.sessionId === 'hang') {
        hung.resolve();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
      }
      return { content: 'ok' };
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: provider }));
  const proxied = new ModelProxyProvider('openai', {}, channel);
  const mainScope = 'main-session#side:server-scope';
  const side = (sessionId, signal) => proxied.send([], 'gpt', undefined, { sessionId, transportScope: mainScope, signal });

  // Success: the PC's own scope, never the server's, released afterwards.
  await side('ok');
  const [ok] = sends;
  assert.equal(typeof ok.transportScope, 'string');
  assert.notEqual(ok.transportScope, mainScope);
  assert.ok(ok.transportScope.startsWith('ok#'));
  assert.deepEqual(closed, [ok.transportScope]);
  assert.deepEqual(released, [ok.transportScope]);

  // Error.
  await assert.rejects(side('fail'), /provider down/);
  assert.equal(sends[1].transportScope, closed[1]);
  assert.notEqual(sends[1].transportScope, ok.transportScope);
  assert.deepEqual(released, closed);

  // Cancel.
  const controller = new AbortController();
  const hanging = side('hang', controller.signal);
  await hung.promise;
  assert.equal(closed.length, 2, 'still held while the request runs');
  controller.abort(new Error('user stop'));
  await assert.rejects(hanging, /user stop/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed.length, 3);
  assert.equal(closed[2], sends[2].transportScope);
  assert.deepEqual(released, closed);
  assert.equal(new Set(closed).size, 3, 'every request got a scope of its own');

  // A request that names no scope is left on its session's own state.
  await proxied.send([], 'gpt', undefined, { sessionId: 'main' });
  assert.equal(Object.hasOwn(sends[3], 'transportScope'), false);
  assert.equal(closed.length, 3);
});

test('PC errors reach the server with only the recovery fields, credentials redacted', async (t) => {
  const provider = {
    async send() {
      throw Object.assign(new Error('401 from upstream for key sk-abcdefghijklmnopqrstuvwxyz'), {
        status: 401,
        code: 'auth_failed',
        retryAfter: 3,
        partialContent: 'half an answer',
        liveTextEmitted: true,
        headers: { authorization: 'Bearer pc-secret-token' },
        cause: new Error('socket to https://internal.pc.example'),
        baseURL: 'https://internal.pc.example',
      });
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: provider }));
  const error = await new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}).then(
    () => assert.fail('expected a failure'),
    (failure) => failure
  );
  assert.equal(error.status, 401);
  assert.equal(error.code, 'auth_failed');
  assert.equal(error.retryAfter, 3);
  assert.equal(error.partialContent, 'half an answer');
  assert.equal(error.liveTextEmitted, true);
  assert.equal(error.headers, undefined);
  assert.equal(error.cause, undefined);
  assert.equal(error.baseURL, undefined);
  assert.match(error.message, /\[redacted\]/);
  assert.doesNotMatch(error.message, /sk-abcdef/);
});

test('providerConfig tells a server availability and traits only; disallowed providers are refused', async (t) => {
  const send = async () => ({ content: 'x' });
  const { channel } = connect(
    t,
    fakeRuntime(
      { openai: { send }, 'custom-1': { send } },
      {
        providerConfig: async () => ({
          ready: true,
          providers: {
            openai: {
              enabled: true,
              baseURL: 'https://corp.example/v1',
              organization: 'acme',
              accountLabel: 'work@acme.example',
              modelProxy: { nativePdf: true, extra: 'x' },
            },
            'custom-1': { type: 'custom', enabled: true, baseURL: 'http://10.0.0.5' },
          },
        }),
      }
    ),
    { isProviderAllowed: (name) => name !== 'custom-1' }
  );
  // A provider the server may not use is not even named to it.
  assert.deepEqual(await channel.request({ provider: '', method: 'providerConfig' }), {
    providers: { openai: { enabled: true, modelProxy: { nativePdf: true } } },
    ready: true,
  });
  await assert.rejects(new ModelProxyProvider('custom-1', {}, channel).send([], 'm', undefined, {}), {
    code: 'MODEL_PROXY_PROVIDER_NOT_ALLOWED',
  });
  assert.deepEqual(await new ModelProxyProvider('openai', {}, channel).send([], 'm', undefined, {}), { content: 'x' });
});

test('a remote session pins its wire through the PC adapter and the pin reaches the PC send', async (t) => {
  const resolved = [];
  const sent = [];
  const provider = {
    resolveWireRoute: async (model, ctx) => {
      resolved.push({ model, ctx });
      return resolveWireRoute('openrouter', model, { ...ctx, override: null });
    },
    send: async (messages, model, tools, options) => {
      sent.push({ route: options.wireRoute, sessionRoute: options.session?.wireRoute });
      return { content: 'ok' };
    },
  };
  const { channel } = connect(t, fakeRuntime({ openrouter: provider }));
  const proxy = new ModelProxyProvider('openrouter', {}, channel);
  // An existing session that already talked to its model keeps Chat (legacy).
  const model = 'anthropic/claude-opus-4.8';
  const session = {
    id: 's1',
    provider: 'openrouter',
    model,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  };
  const route = await pinSessionWireRoute(session, proxy);
  assert.equal(route?.wire, 'chat');
  assert.equal(route.source, 'legacy');
  assert.deepEqual(resolved, [{ model, ctx: { agent: true, legacy: true } }]);
  await proxy.send(session.messages, model, undefined, { wireRoute: session.wireRoute, session });
  assert.deepEqual(sent, [{ route: session.wireRoute, sessionRoute: session.wireRoute }]);
  // A single-wire PC adapter pins nothing, and is asked once per model.
  let asked = 0;
  const { channel: soloChannel } = connect(
    t,
    fakeRuntime({
      openai: {
        send: async () => ({ content: 'x' }),
        resolveWireRoute: async () => {
          asked += 1;
          return null;
        },
      },
    })
  );
  const solo = new ModelProxyProvider('openai', {}, soloChannel);
  assert.equal(await solo.resolveWireRoute('gpt-x', { agent: true }), null);
  assert.equal(await solo.resolveWireRoute('gpt-x', { agent: true }), null);
  assert.equal(asked, 1);
});

test('at the concurrency cap nothing more is claimed; a freed slot takes up the next call', async (t) => {
  const provider = hangingProvider();
  const { channel, host, operations } = connect(t, fakeRuntime({ openai: provider }), { maxConcurrentCalls: 1 });
  const firstAbort = new AbortController();
  const first = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, { signal: firstAbort.signal });
  first.catch(() => {});
  await provider.started;
  const second = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(operations.filter((operation) => operation === 'modelProxyClaim').length, 1);
  assert.equal(channel.snapshot().requests.length, 1, 'the second call waits unclaimed on the daemon');
  provider.send = async () => ({ content: 'second' });
  firstAbort.abort(new Error('done'));
  assert.deepEqual(await settledWhileAlive(second), { content: 'second' });
  assert.equal(host.running, 0);
});

test('a call payload over the request cap is refused before any provider runs', async (t) => {
  let sent = false;
  const provider = {
    async send() {
      sent = true;
      return { content: 'x' };
    },
  };
  const { channel } = connect(t, fakeRuntime({ openai: provider }), { maxRequestBytes: 200 });
  await assert.rejects(
    settledWhileAlive(
      new ModelProxyProvider('openai', {}, channel).send([{ role: 'user', content: 'x'.repeat(500) }], 'gpt', undefined, {})
    ),
    { code: 'MODEL_PROXY_REQUEST_TOO_LARGE' }
  );
  assert.equal(sent, false);
});


test('the last disabled or removed provider is not advertised even when the registry preserves its instance', async () => {
  const available = { openai: { enabled: true } };
  const modules = pcModules(available);
  const init = modules.initProviders;
  modules.initProviders = async (config) => {
    // Match the real registry's all-disabled preservation guard.
    if (!Object.values(config).some((entry) => entry.enabled === true)) {
      throw Object.assign(new Error('all disabled'), { code: 'PROVIDERS_NONE_ENABLED' });
    }
    return init(config);
  };
  const runtime = createModelProxyRuntime(modules);
  assert.equal((await runtime.providerConfig()).providers.openai.enabled, true);
  available.openai.enabled = false;
  assert.equal((await runtime.providerConfig()).providers.openai.enabled, false);
  assert.equal(modules.live.has('openai'), true);
  assert.equal(await runtime.provider('openai'), undefined);
  delete available.openai;
  assert.equal((await runtime.providerConfig()).providers.openai.enabled, false);
  assert.equal(await runtime.provider('openai'), undefined);
  assert.deepEqual(modules.keyReads, []);
});


for (const claimed of [false, true]) {
  test(`provider config deadline aborts a stalled request (claimed=${claimed})`, async (t) => {
    _resetModelProxyProviderConfigForTest();
    t.after(_resetModelProxyProviderConfigForTest);
    const channel = new ModelProxyChannel();
    let requestId;
    const detach = channel.attachPublisher((snapshot) => {
      for (const { id } of snapshot.requests) {
        requestId = id;
        if (claimed) channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]);
      }
    });
    t.after(detach);
    const loading = loadModelProxyProviderConfig({ channel, waitMs: 30 });
    await assert.rejects(settledWhileAlive(loading, 1_000), (error) => error.code === 'MODEL_PROXY_UNAVAILABLE');
    assert.ok(requestId);
  });
}

test('forced and short-budget reads do not join an older request or let it overwrite the fresh cache', async (t) => {
  _resetModelProxyProviderConfigForTest();
  t.after(_resetModelProxyProviderConfigForTest);
  const replies = [];
  const channel = {
    connected: true, generation: 1,
    request: () => new Promise((resolve) => replies.push(resolve)),
  };
  const old = loadModelProxyProviderConfig({ channel });
  const fresh = loadModelProxyProviderConfig({ channel, force: true });
  assert.equal(replies.length, 2);
  replies[1]({ ready: true, providers: { gemini: { enabled: true } } });
  assert.equal((await fresh).gemini.enabled, true);
  replies[0]({ ready: true, providers: { gemini: { enabled: false } } });
  await old;
  assert.equal((await loadModelProxyProviderConfig({ channel })).gemini.enabled, true);

  _resetModelProxyProviderConfigForTest();
  const long = loadModelProxyProviderConfig({ channel, waitMs: 15_000 });
  const short = loadModelProxyProviderConfig({ channel, waitMs: 1_000 });
  assert.equal(replies.length, 4);
  replies[3]({ ready: true, providers: {} });
  replies[2]({ ready: true, providers: {} });
  await Promise.all([long, short]);
});


test('all built-in provider families and custom protocols use the same PC catalog and send path', async (t) => {
  const names = ['openai', 'anthropic', 'gemini', 'deepseek', 'xai', 'opencode-go', 'openrouter',
    'openai-oauth', 'anthropic-oauth', 'grok-oauth', 'muse-code-oauth', 'command-code-oauth',
    'mimo-oauth', 'cursor-oauth', 'antigravity-oauth', 'mixdog-local'];
  const custom = ['openai-chat', 'openai-responses', 'anthropic'].flatMap((protocol, i) =>
    ['key', 'none'].map((auth, j) => ({
      id: `custom-00000000-0000-4000-8000-0000000000${i}${j}`, protocol, auth,
    }))
  );
  const available = Object.fromEntries([
    ...names.map((id) => [id, { enabled: true }]),
    ...custom.map(({ id, ...config }) => [id, { ...config, type: 'custom', enabled: true }]),
  ]);
  const modules = pcModules(available);
  const init = modules.initProviders;
  modules.initProviders = async (config) => {
    await init(config);
    for (const [name, provider] of modules.live) {
      provider.listModels = async () => [{ id: `${name}-model` }];
    }
  };
  const runtime = createModelProxyRuntime(modules);
  let clock = 0;
  const { channel } = connect(t, runtime, { now: () => clock });
  const advertised = await channel.request({ provider: '', method: 'providerConfig' });
  assert.deepEqual(Object.keys(advertised.providers).sort(), Object.keys(available).sort());
  for (const name of Object.keys(available)) {
    clock += 60_000; // Each independent provider check receives a fresh rate-limit window.
    assert.equal(advertised.providers[name].enabled, true, name);
    const proxy = new ModelProxyProvider(name, {}, channel);
    assert.deepEqual(await proxy.listModels(), [{ id: `${name}-model` }]);
    assert.equal((await proxy.send([], `${name}-model`, [], {})).content, `${name}:no-key`);
  }
});


test('proxy readiness distinguishes missing credentials, transient probes, and explicit disables', async (t) => {
  const available = { 'openai-oauth': { enabled: true } };
  const modules = pcModules(available);
  let state = 'present';
  modules.probeAuth = () => state;
  const init = modules.initProviders;
  modules.initProviders = async (config) => {
    if (config['openai-oauth'].credentialProbeUnavailable) return; // registry preserves the prior adapter
    return init(config);
  };
  const runtime = createModelProxyRuntime(modules);
  const { channel } = connect(t, runtime);
  const read = async () => (await channel.request({ provider: '', method: 'providerConfig' })).providers['openai-oauth'];
  assert.equal((await read()).enabled, true);
  state = 'unreadable';
  available['openai-oauth'] = { enabled: false, credentialProbeUnavailable: true };
  assert.deepEqual(await read(), { enabled: true, authState: 'unreadable', modelProxy: {} });
  assert.ok(await runtime.provider('openai-oauth'));
  state = 'absent';
  available['openai-oauth'] = { enabled: true }; // a persisted enable is not authentication
  assert.deepEqual(await read(), { enabled: false, authState: 'absent', modelProxy: {} });
  assert.equal(await runtime.provider('openai-oauth'), undefined);
  state = 'present';
  available['openai-oauth'] = { enabled: false };
  assert.equal((await read()).enabled, false);
  assert.equal(await runtime.provider('openai-oauth'), undefined);
});


test('custom environment credentials drive proxy readiness without a stored-key fallback', async (t) => {
  const variable = 'MIXDOG_PROXY_ENV_CREDENTIAL_TEST';
  const previous = process.env[variable];
  t.after(() => { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; });
  const name = 'custom-proxy-env';
  const available = { [name]: { type: 'custom', auth: 'key', enabled: true, apiKeyEnv: variable } };
  const modules = pcModules(available, { [name]: 'stored-key-must-not-be-used' });
  modules.probeAuth = () => 'absent'; // No conventional environment alias or keychain credential.
  const { resolveProviderApiKey } = await import('../../../../src/runtime/shared/provider-api-key.mjs');
  const init = modules.initProviders;
  modules.initProviders = async (config) => {
    await init(config);
    modules.live.set(name, { send: async () => ({ content: resolveProviderApiKey(name, config[name]) }) });
  };
  const runtime = createModelProxyRuntime(modules);
  const { channel } = connect(t, runtime);
  process.env[variable] = 'environment-key-one';
  const first = await runtime.providerConfig();
  assert.equal(first.providers[name].enabled, true);
  assert.equal(first.providers[name].authState, 'present');
  assert.equal(JSON.stringify(first).includes('environment-key-one'), false, 'no key value crosses the config boundary');
  const provider = new ModelProxyProvider(name, {}, channel);
  assert.equal((await provider.send([], 'test-model', undefined, {})).content, 'environment-key-one');
  process.env[variable] = 'environment-key-two';
  assert.equal((await provider.send([], 'test-model', undefined, {})).content, 'environment-key-two');
  delete process.env[variable];
  modules.probeAuth = () => 'present'; // A stored key must not satisfy a missing named variable.
  assert.equal((await runtime.providerConfig()).providers[name].enabled, false);
  assert.equal(await runtime.provider(name), undefined);
  assert.deepEqual(modules.keyReads, []);
});
