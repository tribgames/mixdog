#!/usr/bin/env node
// Recording of apps/desktop/src/main/model-proxy-host.test.mjs (b6f10295a): the PC side of the model proxy
// (model-proxy-host.ts createModelProxyHost / createModelProxyRuntime / modelProxyCredentialProbe) joined, as the desktop's session
// connection joins them, to the daemon side (providers/model-proxy-channel.mjs ModelProxyChannel, model-proxy-provider.mjs
// ModelProxyProvider and loadModelProxyProviderConfig). The PC's providers and registry modules are scripted (external services).
// Per case: what the daemon side received (results, errors with code and text, callbacks in order), what the PC provider saw
// (messages, model, tools, option names) and the PC-side counters the test read.
//
//   node --import <tree>/apps/desktop/scripts/test-env.mjs --import <tree>/apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-model-proxy-host-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('model-proxy-host-cases', import.meta.url);
const { tree } = set;
const A = 'apps/desktop/src/main/';
const R = 'src/runtime/';
const { createModelProxyHost, createModelProxyRuntime, modelProxyCredentialProbe } = await set.load(`${A}model-proxy-host.ts`);
const { OAUTH_PROVIDER_NAMES } = await set.load(`${R}agent/orchestrator/providers/registry.mjs`);
const { hasProviderApiKey, resolveProviderApiKey } = await set.load(`${R}shared/provider-api-key.mjs`);
const { MODEL_PROXY_REQUEST_EVENT, MODEL_PROXY_OPERATIONS, ModelProxyChannel } = await set.load(`${R}agent/orchestrator/providers/model-proxy-channel.mjs`);
const { pinSessionWireRoute, resolveWireRoute } = await set.load(`${R}agent/orchestrator/providers/wire-route.mjs`);
const { ModelProxyProvider, _resetModelProxyProviderConfigForTest, loadModelProxyProviderConfig } = await set.load(`${R}agent/orchestrator/providers/model-proxy-provider.mjs`);

const DEADLINE_MS = 10_000;
const disposers = [];
const turns = async (n) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const failure = (e) => ({ name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e), status: e?.status ?? null, retryAfter: e?.retryAfter ?? null, partialContent: e?.partialContent ?? null, liveTextEmitted: e?.liveTextEmitted ?? null, headers: e?.headers ?? null, cause: e?.cause === undefined ? null : String(e.cause), baseURL: e?.baseURL ?? null });
const rejected = async (promise) => { try { return { resolved: await promise }; } catch (e) { return { rejected: failure(e) }; } };
/** `promise` or a rejection naming `label` after DEADLINE_MS (the host's timers are unref'd: this keeps the loop alive). */
async function settled(label, promise, limitMs = DEADLINE_MS) {
  let timer;
  const limit = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: still pending after ${limitMs}ms`)), limitMs); });
  try { return await Promise.race([promise, limit]); } finally { clearTimeout(timer); }
}
function connect(runtime, { intercept = null, channel = new ModelProxyChannel(), ...hostOptions } = {}) {
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
  disposers.push(() => { detach(); host.dispose(); });
  return { channel, host, operations };
}
const fakeRuntime = (providers, extra = {}) => ({ provider: async (name) => providers[name], providerConfig: async () => ({ providers: {}, ready: true }), finalizeTools: (tools) => tools, ...extra });
function hangingProvider() {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  return { started: started.promise, stopped: stopped.promise, send(_m, _model, _t, options) { started.resolve(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => { stopped.resolve(options.signal.reason); reject(options.signal.reason); }); }); } };
}
function pcModules(available, keys = {}) {
  const live = new Map();
  const keyReads = [];
  const inits = [];
  return {
    keyReads, probeAuth: () => 'present', inits, live,
    loadConfig: (options) => { if (JSON.stringify(options) !== '{"secrets":"presence"}') throw new Error(`loadConfig options ${JSON.stringify(options)}`); return { providers: structuredClone(available) }; },
    initProviders: async (config) => {
      inits.push(structuredClone(config));
      live.clear();
      const enabled = Object.entries(config).filter(([, entry]) => entry.enabled === true);
      if (!enabled.length) throw Object.assign(new Error('all providers disabled in config'), { code: 'PROVIDERS_NONE_ENABLED' });
      for (const [name, entry] of enabled) live.set(name, { send: async () => ({ content: `${name}:${entry.apiKey ?? 'no-key'}` }) });
    },
    getProvider: (name) => live.get(name), getAllProviders: () => live,
    readApiKey: async (name) => { keyReads.push(name); return keys[name] ?? null; },
    finalizeProviderRequestTools: (tools) => tools,
  };
}
const send = (channel, name, args = {}) => new ModelProxyProvider(name, {}, channel).send(args.messages ?? [], args.model ?? 'gpt', args.tools, args.options ?? {});
const providerConfigOf = (channel) => channel.request({ provider: '', method: 'providerConfig' });
const REDACTED_NOTE = 'timers: heartbeat counts depend on the host timers and are not compared, only the lease outcome';
async function run(name, fn, extra) {
  await set.run(name, async () => { try { return await fn(); } finally { while (disposers.length) disposers.pop()(); _resetModelProxyProviderConfigForTest(); } }, extra);
}

await run('quota requests use the PC policy with the selected provider and model, after provider guards', async () => {
  const calls = [];
  const provider = { send: () => { throw new Error('a quota check must not send a model request'); } };
  const providers = { 'openai-oauth': { enabled: true }, 'anthropic-oauth': { enabled: false } };
  const runtime = createModelProxyRuntime({
    loadConfig: () => ({ providers }), initProviders: async () => {}, getProvider: () => provider, getAllProviders: () => new Map(), readApiKey: async () => null, probeAuth: () => 'present', finalizeProviderRequestTools: (tools) => tools,
    measureProviderQuota: async (name, options) => { calls.push({ name, providerIsTheRegistryProvider: options.provider === provider }); return { name }; },
    quotaMeasurementServesModel: (measurement, model) => { calls.push({ name: measurement.name, model }); return model === 'gpt-usable'; },
  });
  const { channel } = connect(runtime, { isProviderAllowed: (name) => name !== 'grok-oauth' });
  const usable = [];
  for (const model of ['gpt-usable', 'gpt-exhausted']) usable.push({ model, answer: await channel.request({ provider: 'openai-oauth', method: 'quotaUsable', model }) });
  const refused = [];
  for (const name of ['grok-oauth', 'anthropic-oauth']) refused.push({ provider: name, ...(await rejected(channel.request({ provider: name, method: 'quotaUsable', model: 'test' }))) });
  return { providers, deniedProvider: 'grok-oauth', usable, refused, policyCalls: calls };
});
await run('quota requests share one account-wide measurement per provider; models are judged against it, never retained', async () => {
  let clock = 1_000; let measurements = 0; let failNext = false; let gate = null; let measurementStarted;
  const provider = { send: () => { throw new Error('a quota check must not send a model request'); } };
  const runtime = createModelProxyRuntime({
    now: () => clock, loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }), initProviders: async () => {}, getProvider: () => provider, getAllProviders: () => new Map(),
    readApiKey: async () => null, probeAuth: () => 'present', finalizeProviderRequestTools: (tools) => tools,
    measureProviderQuota: async () => { measurements += 1; measurementStarted?.(); await gate; if (failNext) throw new Error('usage fetch failed'); return { servable: new Set(['gpt-a']) }; },
    quotaMeasurementServesModel: (measurement, model) => measurement.servable.has(model),
  });
  const first = connect(runtime).channel;
  const second = connect(runtime).channel;
  const ask = (channel, model) => channel.request({ provider: 'openai-oauth', method: 'quotaUsable', model });
  const log = [];
  let release;
  gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (measurementStarted = resolve));
  const pending = [ask(first, 'gpt-a'), ask(second, 'junk-1'), ask(second, 'gpt-a'), ask(first, 'junk-2')];
  await settled('the first measurement', started);
  measurementStarted = null;
  release();
  log.push({ step: 'concurrent on two connections', answers: await Promise.all(pending), measurements });
  gate = null;
  const many = [];
  for (let i = 0; i < 50; i += 1) many.push(await ask(i % 2 ? first : second, `junk-${i}`));
  log.push({ step: '50 other models in the window', allFalse: many.every((v) => v === false), gptA: await ask(second, 'gpt-a'), measurements });
  clock += 59_999; await ask(first, 'gpt-a');
  log.push({ step: 'clock +59999', measurements });
  clock += 1; await ask(first, 'gpt-a');
  log.push({ step: 'clock +1 (window over)', measurements });
  log.push({ step: 'long model name (257 chars)', answer: await ask(first, 'x'.repeat(257)), measurements });
  clock += 60_000; failNext = true;
  const failA = await rejected(ask(first, 'gpt-a'));
  const failB = await rejected(ask(second, 'gpt-a'));
  log.push({ step: 'failed measurement is not cached', failA, failB, measurements });
  failNext = false;
  log.push({ step: 'after recovery', answer: await ask(first, 'gpt-a'), measurements });
  return { startClock: 1_000, windowMs: 60_000, log };
});
await run('the PC runs the call with its own provider and streams every callback back in order', async () => {
  const calls = [];
  const provider = {
    async send(messages, model, tools, options) {
      calls.push({ messages, model, tools, options: Object.keys(options).sort() });
      options.onStageChange('streaming'); options.onTextDelta('Hel'); options.onTextDelta('lo');
      const acked = await options.onTextReset({ chars: 5 });
      options.onTextDelta(acked === true ? 'again' : 'unacked');
      return { content: 'Hello again', usage: { inputTokens: 7, outputTokens: 2 } };
    },
  };
  const { channel, host } = connect(fakeRuntime({ 'anthropic-oauth': provider }));
  const seen = [];
  const result = await new ModelProxyProvider('anthropic-oauth', {}, channel).send([{ role: 'user', content: 'hi' }], 'claude-test', [{ name: 'read', input_schema: {} }], {
    sessionId: 'pc-session',
    onStageChange: (stage) => { seen.push(['stage', stage]); },
    onTextDelta: (text) => { seen.push(['text', text]); },
    onTextReset: async ({ chars }) => { seen.push(['reset', chars]); return true; },
  });
  await turns(2);
  return { result, callbacks: seen, pcProviderCalls: calls, hostRunningAfter: host.running };
});
await run('the provider send result reaches the daemon unchanged, wireReroute included', async () => {
  const wireReroute = { from: { provider: 'a', model: 'm1' }, to: { provider: 'b', model: 'm2' }, reason: 'x' };
  const provider = { async send() { return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, wireReroute }; } };
  const { channel } = connect(fakeRuntime({ 'anthropic-oauth': provider }));
  const result = await send(channel, 'anthropic-oauth', { messages: [{ role: 'user', content: 'hi' }], model: 'claude-test', tools: [], options: { sessionId: 'pc-session' } });
  return { providerResult: { content: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, wireReroute }, wireReroute: result.wireReroute };
});
await run('the PC serves only the named provider and the allowed methods', async () => {
  const listed = [];
  const provider = { send: async () => ({ content: 'x' }), listModels: async () => { listed.push('list'); return [{ id: 'model-a' }, { id: 'model-b' }]; }, getCachedModelInfo: (id) => (id === 'model-a' ? { contextWindow: 1000 } : null) };
  const { channel } = connect(fakeRuntime({ openai: provider }, { providerConfig: async () => ({ providers: { openai: { enabled: true, modelProxy: {} } }, ready: true }) }));
  const unavailable = await rejected(new ModelProxyProvider('gemini', {}, channel).send([], 'g', undefined, {}));
  const forget = await rejected(channel.request({ provider: 'openai', method: 'forgetCredentials' }));
  const proxied = new ModelProxyProvider('openai', {}, channel);
  return { unavailable, forget, models: await proxied.listModels(), cachedA: proxied.getCachedModelInfo('model-a'), cachedB: proxied.getCachedModelInfo('model-b'), providerConfig: await providerConfigOf(channel), listCalls: listed.length };
});
await run('the PC reports its model-specific first-response budget through the catalog and provider config', async () => {
  const argon = { transportMs: 577_000, semanticMs: 1_147_000 };
  const fallback = { transportMs: 130_000, semanticMs: 250_000 };
  const provider = { send: async () => ({ content: 'x' }), listModels: async () => [{ id: 'argon' }, { id: 'flash' }, { id: 'bare' }], getCachedModelInfo: (id) => (id === 'bare' ? null : { id }), firstResponseBudget: (id) => (id === 'argon' ? argon : id === 'flash' ? { transportMs: 'x', semanticMs: 1 } : null) };
  const { channel } = connect(fakeRuntime({ 'antigravity-oauth': provider }, { providerConfig: async () => ({ providers: { 'antigravity-oauth': { enabled: true, modelProxy: { firstResponseBudget: fallback } } }, ready: true }) }));
  const proxied = new ModelProxyProvider('antigravity-oauth', {}, channel);
  await proxied.listModels();
  const config = await providerConfigOf(channel);
  const forwarded = new ModelProxyProvider('antigravity-oauth', config.providers['antigravity-oauth'], channel);
  return { argon, fallback, cachedArgon: proxied.getCachedModelInfo('argon'), cachedFlash: proxied.getCachedModelInfo('flash'), cachedBare: proxied.getCachedModelInfo('bare'), config, forwardedBudgetForUnlisted: forwarded.firstResponseBudget('unlisted') };
});
await run('a daemon-side abort aborts the PC provider call', async () => {
  const started = Promise.withResolvers(); const stopped = Promise.withResolvers();
  const provider = { send(_m, _model, _t, options) { started.resolve(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => { stopped.resolve(options.signal.reason); reject(options.signal.reason); }); }); } };
  const { channel, host, operations } = connect(fakeRuntime({ openai: provider }), { heartbeatMs: 20 });
  const controller = new AbortController();
  const sending = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, { signal: controller.signal });
  await settled('the PC call to start', started.promise);
  const runningWhileCalling = host.running;
  controller.abort(new Error('user stop'));
  const outcome = await rejected(sending);
  const reason = await settled('the PC provider to see the abort', stopped.promise);
  await turns(5);
  return { runningWhileCalling, daemonOutcome: outcome, pcAbortReason: { name: reason.name }, runningAfter: host.running, snapshot: channel.snapshot(), resolveOperationSeen: operations.includes('modelProxyResolve'), normalized: REDACTED_NOTE };
});
await run('a daemon silent past its lease makes the PC abandon every active call', async () => {
  const provider = hangingProvider();
  let now = 1_000; let daemonSilent = false; let failedHeartbeats = 0; let onFailed;
  const { channel, host } = connect(fakeRuntime({ openai: provider }), { heartbeatMs: 5, leaseMs: 100, now: () => now, intercept: async (operation) => { if (daemonSilent && operation === 'modelProxyHeartbeat') { failedHeartbeats += 1; onFailed?.(); throw new Error('connection lost'); } } });
  const daemonCall = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  await settled('the PC call to start', provider.started);
  const runningBefore = host.running;
  daemonSilent = true; now += 50;
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await settled('3 failed heartbeats inside the lease', new Promise((resolve) => { onFailed = () => failedHeartbeats >= 3 && resolve(); }));
    const runningInsideLease = host.running;
    now += 100;
    const reason = await settled('the PC provider to see the lease abort', provider.stopped);
    const daemonOutcome = await rejected(settled('the daemon call', daemonCall));
    return { leaseMs: 100, heartbeatMs: 5, runningBefore, atLeastThreeFailedHeartbeats: failedHeartbeats >= 3, runningInsideLease, abortReason: { code: reason.code, message: reason.message }, runningAfter: host.running, daemonOutcome, normalized: REDACTED_NOTE };
  } finally { clearInterval(keepAlive); }
});
await run('disposing the host aborts and drops every active call', async () => {
  const provider = hangingProvider();
  const { channel, host } = connect(fakeRuntime({ openai: provider }));
  const daemonCall = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {});
  await settled('the PC call to start', provider.started);
  const runningBefore = host.running;
  host.dispose();
  const runningAfterDispose = host.running;
  const reason = await settled('the PC provider to see the abort', provider.stopped);
  return { runningBefore, runningAfterDispose, abortReason: { name: reason.name }, daemonOutcome: await rejected(settled('the daemon call', daemonCall)) };
});
await run('cold start: the daemon waits for a PC that connects late and loads its registry on demand', async () => {
  _resetModelProxyProviderConfigForTest();
  const modules = pcModules({ openai: { enabled: true }, gemini: { enabled: false } });
  const channel = new ModelProxyChannel();
  const loading = loadModelProxyProviderConfig({ channel, waitMs: 2_000 });
  await turns(5);
  const liveBeforeConnect = modules.live.size;
  connect(createModelProxyRuntime(modules), { channel });
  const config = await settled('the provider config', loading);
  return { liveBeforeConnect, config, keyReads: modules.keyReads, waitMs: 2_000, normalized: 'the test waited 50 ms before connecting; the recording yields five event-loop turns' };
});
await run('the daemon retries an unready PC answer instead of reading it as "all disabled"', async () => {
  let asked = 0;
  const { channel } = connect(fakeRuntime({}, { providerConfig: async () => (++asked === 1 ? { providers: {}, ready: false } : { providers: { openai: { enabled: true, modelProxy: {} } }, ready: true }) }));
  const config = await settled('the provider config', loadModelProxyProviderConfig({ channel, waitMs: 2_000 }));
  return { config, asked };
});
await run('a loaded PC registry with nothing enabled is an answer, not a wait', async () => {
  const modules = pcModules({ openai: { enabled: false } });
  const { channel } = connect(createModelProxyRuntime(modules));
  return { config: await settled('the provider config', loadModelProxyProviderConfig({ channel, waitMs: 5_000 }), 5_000) };
});
await run("only the requested provider's credential is read, on demand", async () => {
  const modules = pcModules({ openai: { enabled: true }, anthropic: { enabled: true } }, { openai: 'pc-openai-key', anthropic: 'pc-anthropic-key' });
  const { channel } = connect(createModelProxyRuntime(modules));
  const result = await send(channel, 'openai');
  return { result, keyReads: modules.keyReads, anthropicKeyInLastInit: modules.inits.at(-1).anthropic.apiKey ?? null };
});
await run('server send options are reduced to the allowlist', async () => {
  let seen = null;
  const provider = { async send(_m, _model, _t, options) { seen = options; return { content: 'ok' }; } };
  const { channel } = connect(fakeRuntime({ openai: provider }));
  const options = { sessionId: 's1', temperature: 0.2, baseURL: 'http://attacker.example', requestHeaders: { authorization: 'Bearer x' }, extraBody: { stolen: true }, codexInstallationId: 'pc-identity', toolExecutionSessionId: 'daemon-session', _providerSeam: true };
  await send(channel, 'openai', { options });
  return { options, seenKeys: Object.keys(seen).sort(), signalIsAbortSignal: seen.signal instanceof AbortSignal, toolExecutionSessionId: seen.toolExecutionSessionId, sessionId: seen.sessionId, temperature: seen.temperature };
});
await run('a proxied side request gets its own transport scope on the PC, disposed when the request ends', async () => {
  const closed = []; const previousHook = globalThis.__mixdogCloseProviderConnectionsForSession;
  globalThis.__mixdogCloseProviderConnectionsForSession = (scope) => closed.push(scope);
  try {
    const sends = []; const released = []; const hung = Promise.withResolvers();
    const provider = {
      releaseTransportScope: (scope) => released.push(scope),
      async send(_m, _model, _t, options) {
        sends.push(options);
        if (options.sessionId === 'fail') throw new Error('provider down');
        if (options.sessionId === 'hang') { hung.resolve(); return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason)); }); }
        return { content: 'ok' };
      },
    };
    const { channel } = connect(fakeRuntime({ openai: provider }));
    const proxied = new ModelProxyProvider('openai', {}, channel);
    const mainScope = 'main-session#side:server-scope';
    const side = (sessionId, signal) => proxied.send([], 'gpt', undefined, { sessionId, transportScope: mainScope, signal });
    const scopeShape = (scope, sessionId) => ({ isString: typeof scope === 'string', differsFromServerScope: scope !== mainScope, startsWithSessionHash: String(scope).startsWith(`${sessionId}#`) });
    const log = [];
    await side('ok');
    log.push({ step: 'success', scope: scopeShape(sends[0].transportScope, 'ok'), closedIsScope: closed[0] === sends[0].transportScope, releasedIsScope: released[0] === sends[0].transportScope });
    const fail = await rejected(side('fail'));
    log.push({ step: 'error', fail, scopeIsClosed: sends[1].transportScope === closed[1], differsFromFirst: sends[1].transportScope !== sends[0].transportScope, releasedEqualsClosed: JSON.stringify(released) === JSON.stringify(closed) });
    const controller = new AbortController();
    const hanging = side('hang', controller.signal);
    await settled('the hanging side request to start', hung.promise);
    const closedWhileRunning = closed.length;
    controller.abort(new Error('user stop'));
    const cancelled = await rejected(hanging);
    await turns(5);
    log.push({ step: 'cancel', closedWhileRunning, cancelled, closedAfter: closed.length, closedIsScope: closed[2] === sends[2].transportScope, releasedEqualsClosed: JSON.stringify(released) === JSON.stringify(closed), distinctScopes: new Set(closed).size });
    await proxied.send([], 'gpt', undefined, { sessionId: 'main' });
    log.push({ step: 'no scope named', hasTransportScope: Object.hasOwn(sends[3], 'transportScope'), closedAfter: closed.length });
    return { mainScope, log, normalized: 'the scope is session#<random>: only its shape is compared' };
  } finally { globalThis.__mixdogCloseProviderConnectionsForSession = previousHook; }
});
await run('PC errors reach the server with only the recovery fields, credentials redacted', async () => {
  const provider = { async send() { throw Object.assign(new Error('401 from upstream for key sk-DUMMY-abcdefghijklmnopqrstuvwxyz'), { status: 401, code: 'auth_failed', retryAfter: 3, partialContent: 'half an answer', liveTextEmitted: true, headers: { authorization: 'Bearer pc-secret-token' }, cause: new Error('socket to https://internal.pc.example'), baseURL: 'https://internal.pc.example' }); } };
  const { channel } = connect(fakeRuntime({ openai: provider }));
  const error = await new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}).then(() => null, (e) => e);
  return { thrown: error ? { ...failure(error), hasHeaders: error.headers !== undefined, hasCause: error.cause !== undefined, hasBaseURL: error.baseURL !== undefined, messageRedacted: /\[redacted\]/.test(error.message), messageKeepsKey: /sk-DUMMY-abcdef/.test(error.message) } : null };
});
await run('providerConfig tells a server availability and traits only; disallowed providers are refused', async () => {
  const sendFn = async () => ({ content: 'x' });
  const { channel } = connect(fakeRuntime({ openai: { send: sendFn }, 'custom-1': { send: sendFn } }, {
    providerConfig: async () => ({ ready: true, providers: {
      openai: { enabled: true, baseURL: 'https://corp.example/v1', organization: 'acme', accountLabel: 'work@acme.example', modelProxy: { nativePdf: true, consumesReadWindows: true, extra: 'x' } },
      'mixdog-local': { enabled: true, modelProxy: { nativePdf: false, takesImages: false } },
      'custom-1': { type: 'custom', enabled: true, baseURL: 'http://10.0.0.5' },
    } }),
  }), { isProviderAllowed: (name) => name !== 'custom-1' });
  return { deniedProvider: 'custom-1', advertised: await providerConfigOf(channel), customSend: await rejected(new ModelProxyProvider('custom-1', {}, channel).send([], 'm', undefined, {})), openaiSend: await new ModelProxyProvider('openai', {}, channel).send([], 'm', undefined, {}) };
});
await run('a remote session pins its wire through the PC adapter and the pin reaches the PC send', async () => {
  const resolved = []; const sent = [];
  const provider = {
    resolveWireRoute: async (model, ctx) => { resolved.push({ model, ctx }); return resolveWireRoute('openrouter', model, { ...ctx, override: null }); },
    send: async (messages, model, tools, options) => { sent.push({ route: options.wireRoute, sessionRoute: options.session?.wireRoute }); return { content: 'ok' }; },
  };
  const { channel } = connect(fakeRuntime({ openrouter: provider }));
  const proxy = new ModelProxyProvider('openrouter', {}, channel);
  const model = 'anthropic/claude-opus-4.8';
  const session = { id: 's1', provider: 'openrouter', model, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] };
  const route = await pinSessionWireRoute(session, proxy);
  await proxy.send(session.messages, model, undefined, { wireRoute: session.wireRoute, session });
  let asked = 0;
  const { channel: soloChannel } = connect(fakeRuntime({ openai: { send: async () => ({ content: 'x' }), resolveWireRoute: async () => { asked += 1; return null; } } }));
  const solo = new ModelProxyProvider('openai', {}, soloChannel);
  const a1 = await solo.resolveWireRoute('gpt-x', { agent: true });
  const a2 = await solo.resolveWireRoute('gpt-x', { agent: true });
  return { session, pinnedRoute: route, resolved, sentToPc: sent, sessionWireRoute: session.wireRoute, solo: { answers: [a1, a2], pcAsked: asked } };
});
await run('a call is claimed and run while another is still running: there is no concurrency cap', async () => {
  const provider = hangingProvider();
  const { channel, host, operations } = connect(fakeRuntime({ openai: provider }));
  const firstAbort = new AbortController();
  const first = new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, { signal: firstAbort.signal });
  first.catch(() => {});
  await settled('the first call to start', provider.started);
  provider.send = async () => ({ content: 'second' });
  const second = await settled('the second call', new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  const claims = operations.filter((operation) => operation === 'modelProxyClaim').length;
  const runningAfterSecond = host.running;
  firstAbort.abort(new Error('done'));
  return { second, claims, runningAfterSecond };
});
await run('a call payload over the request cap is refused before any provider runs', async () => {
  let sent = false;
  const provider = { async send() { sent = true; return { content: 'x' }; } };
  const { channel } = connect(fakeRuntime({ openai: provider }), { maxRequestBytes: 200 });
  const outcome = await rejected(settled('the oversized call', new ModelProxyProvider('openai', {}, channel).send([{ role: 'user', content: 'x'.repeat(500) }], 'gpt', undefined, {})));
  return { maxRequestBytes: 200, contentChars: 500, outcome, providerSent: sent };
});
await run('the last disabled or removed provider is not advertised even when the registry preserves its instance', async () => {
  const available = { openai: { enabled: true } };
  const modules = pcModules(available);
  const init = modules.initProviders;
  modules.initProviders = async (config) => { if (!Object.values(config).some((entry) => entry.enabled === true)) throw Object.assign(new Error('all disabled'), { code: 'PROVIDERS_NONE_ENABLED' }); return init(config); };
  const runtime = createModelProxyRuntime(modules);
  const log = [];
  log.push({ step: 'enabled', enabled: (await runtime.providerConfig()).providers.openai.enabled });
  available.openai.enabled = false;
  log.push({ step: 'disabled', enabled: (await runtime.providerConfig()).providers.openai.enabled, registryKeepsInstance: modules.live.has('openai'), provider: (await runtime.provider('openai')) === undefined ? 'undefined' : 'present' });
  delete available.openai;
  log.push({ step: 'removed', enabled: (await runtime.providerConfig()).providers.openai.enabled, provider: (await runtime.provider('openai')) === undefined ? 'undefined' : 'present' });
  return { log, keyReads: modules.keyReads };
});
for (const claimed of [false, true]) {
  await run(`provider config deadline aborts a stalled request (claimed=${claimed})`, async () => {
    const channel = new ModelProxyChannel();
    let requestId;
    const detach = channel.attachPublisher((snapshot) => { for (const { id } of snapshot.requests) { requestId = id; if (claimed) channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]); } });
    disposers.push(detach);
    const outcome = await rejected(settled('the provider config deadline', loadModelProxyProviderConfig({ channel, waitMs: 30 }), 1_000));
    return { claimed, waitMs: 30, outcome, requestPublished: Boolean(requestId) };
  });
}
await run('forced and short-budget reads do not join an older request or let it overwrite the fresh cache', async () => {
  const replies = [];
  const channel = { connected: true, generation: 1, request: () => new Promise((resolve) => replies.push(resolve)) };
  const old = loadModelProxyProviderConfig({ channel });
  const fresh = loadModelProxyProviderConfig({ channel, force: true });
  const log = [{ step: 'old + forced', requestsSent: replies.length }];
  replies[1]({ ready: true, providers: { gemini: { enabled: true } } });
  log.push({ step: 'forced answered', gemini: (await fresh).gemini.enabled });
  replies[0]({ ready: true, providers: { gemini: { enabled: false } } });
  await old;
  log.push({ step: 'old answered late, cache read', gemini: (await loadModelProxyProviderConfig({ channel })).gemini.enabled });
  _resetModelProxyProviderConfigForTest();
  const long = loadModelProxyProviderConfig({ channel, waitMs: 15_000 });
  const short = loadModelProxyProviderConfig({ channel, waitMs: 1_000 });
  log.push({ step: 'long + short wait', requestsSentTotal: replies.length });
  replies[3]({ ready: true, providers: {} }); replies[2]({ ready: true, providers: {} });
  await Promise.all([long, short]);
  return { log };
});
await run('all built-in provider families and custom protocols use the same PC catalog and send path', async () => {
  const names = ['openai', 'anthropic', 'gemini', 'deepseek', 'xai', 'opencode-go', 'openrouter', 'openai-oauth', 'anthropic-oauth', 'grok-oauth', 'muse-code-oauth', 'command-code-oauth', 'mimo-oauth', 'cursor-oauth', 'antigravity-oauth', 'mixdog-local'];
  const custom = ['openai-chat', 'openai-responses', 'anthropic'].flatMap((protocol, i) => ['key', 'none'].map((auth, j) => ({ id: `custom-00000000-0000-4000-8000-0000000000${i}${j}`, protocol, auth })));
  const available = Object.fromEntries([...names.map((id) => [id, { enabled: true }]), ...custom.map(({ id, ...config }) => [id, { ...config, type: 'custom', enabled: true }])]);
  const modules = pcModules(available);
  const init = modules.initProviders;
  modules.initProviders = async (config) => { await init(config); for (const [name, provider] of modules.live) provider.listModels = async () => [{ id: `${name}-model` }]; };
  let clock = 0;
  const { channel } = connect(createModelProxyRuntime(modules), { now: () => clock });
  const advertised = await providerConfigOf(channel);
  const perProvider = [];
  for (const name of Object.keys(available)) {
    clock += 60_000;
    const proxy = new ModelProxyProvider(name, {}, channel);
    perProvider.push({ name, enabled: advertised.providers[name].enabled, models: await proxy.listModels(), content: (await proxy.send([], `${name}-model`, [], {})).content });
  }
  return { available, advertisedNames: Object.keys(advertised.providers).sort(), perProvider };
});
await run('proxy readiness distinguishes missing credentials, transient probes, and explicit disables', async () => {
  const available = { 'openai-oauth': { enabled: true } };
  const modules = pcModules(available);
  let state = 'present';
  modules.probeAuth = () => state;
  const init = modules.initProviders;
  modules.initProviders = async (config) => { if (config['openai-oauth'].credentialProbeUnavailable) return; return init(config); };
  const runtime = createModelProxyRuntime(modules);
  const { channel } = connect(runtime);
  const read = async () => (await providerConfigOf(channel)).providers['openai-oauth'];
  const log = [];
  log.push({ step: 'present + enabled', advertised: await read() });
  state = 'unreadable'; available['openai-oauth'] = { enabled: false, credentialProbeUnavailable: true };
  log.push({ step: 'unreadable, preserved adapter', advertised: await read(), providerPresent: Boolean(await runtime.provider('openai-oauth')) });
  state = 'absent'; available['openai-oauth'] = { enabled: true };
  log.push({ step: 'absent, persisted enable', advertised: await read(), provider: (await runtime.provider('openai-oauth')) === undefined ? 'undefined' : 'present' });
  state = 'present'; available['openai-oauth'] = { enabled: false };
  log.push({ step: 'present, explicitly disabled', advertised: await read(), provider: (await runtime.provider('openai-oauth')) === undefined ? 'undefined' : 'present' });
  return { log };
});
await run('custom environment credentials drive proxy readiness without a stored-key fallback', async () => {
  const variable = 'MIXDOG_PROXY_ENV_CREDENTIAL_TEST';
  const previous = process.env[variable];
  try {
    const name = 'custom-proxy-env';
    const available = { [name]: { type: 'custom', auth: 'key', enabled: true, apiKeyEnv: variable } };
    const modules = pcModules(available, { [name]: 'stored-key-must-not-be-used' });
    modules.probeAuth = () => 'absent';
    const init = modules.initProviders;
    modules.initProviders = async (config) => { await init(config); modules.live.set(name, { send: async () => ({ content: resolveProviderApiKey(name, config[name]) }) }); };
    const runtime = createModelProxyRuntime(modules);
    const { channel } = connect(runtime);
    process.env[variable] = 'environment-key-one';
    const first = await runtime.providerConfig();
    const provider = new ModelProxyProvider(name, {}, channel);
    const one = (await provider.send([], 'test-model', undefined, {})).content;
    process.env[variable] = 'environment-key-two';
    const two = (await provider.send([], 'test-model', undefined, {})).content;
    delete process.env[variable];
    modules.probeAuth = () => 'present';
    const after = await runtime.providerConfig();
    return { variable, available, firstAdvertised: first.providers[name], keyValueInConfig: JSON.stringify(first).includes('environment-key-one'), sendWithKeyOne: one, sendWithKeyTwo: two, afterUnset: after.providers[name], providerAfterUnset: (await runtime.provider(name)) === undefined ? 'undefined' : 'present', keyReads: modules.keyReads };
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});
await run('an unreadable credential with a live adapter is advertised on the first read, not only later ones', async () => {
  const modules = pcModules({ 'openai-oauth': { enabled: true } });
  modules.probeAuth = () => 'unreadable';
  const { channel } = connect(createModelProxyRuntime(modules));
  const read = async () => (await providerConfigOf(channel)).providers['openai-oauth'];
  return { first: await read(), second: await read() };
});
await run("a text-only adapter's image trait is advertised, so a remote read sends it OCR text", async () => {
  const modules = pcModules({ 'mixdog-local': { enabled: true }, openai: { enabled: true } });
  const initProviders = modules.initProviders;
  modules.initProviders = async (config) => { await initProviders(config); Object.assign(modules.live.get('mixdog-local'), { nativePdf: false, takesImages: false }); };
  const { channel } = connect(createModelProxyRuntime(modules));
  const { providers } = await providerConfigOf(channel);
  return { localTraits: providers['mixdog-local'].modelProxy, openaiTraits: providers.openai.modelProxy };
});
await run('a custom provider advertises only the ids of its hidden models', async () => {
  const name = 'custom-proxy-hidden';
  const available = { [name]: { type: 'custom', auth: 'none', enabled: true, name: 'Private gateway', baseURL: 'https://gateway.internal', models: [{ id: 'row-hidden', hidden: true }, { id: 'row-visible' }], modelOverrides: { 'override-hidden': { hidden: true }, 'override-visible': { name: 'Shown' } } } };
  const { channel } = connect(createModelProxyRuntime(pcModules(available)));
  return { available, advertised: (await providerConfigOf(channel)).providers[name] };
});
await run('an advertised custom provider name is trimmed, redacted and capped; empty or non-string names are omitted', async () => {
  const custom = (name) => ({ type: 'custom', enabled: true, ...(name === undefined ? {} : { name }) });
  const providers = {
    'custom-secret': custom('  Gateway sk-DUMMY-abcdefghijklmnop1234  '), 'custom-long': custom('n'.repeat(250)), 'custom-empty': custom('   '), 'custom-number': custom(42),
    'custom-object': custom({ toString: 'x' }), 'custom-missing': custom(), 'custom-blocked': custom('Blocked gateway'), openai: { enabled: true, name: 'Renamed OpenAI' },
  };
  const { channel } = connect(fakeRuntime({}, { providerConfig: async () => ({ ready: true, providers }) }), { isProviderAllowed: (name) => name !== 'custom-blocked' });
  const advertised = (await providerConfigOf(channel)).providers;
  return { configured: providers, blocked: 'custom-blocked', advertised, advertisedNameLengths: Object.fromEntries(Object.entries(advertised).map(([k, v]) => [k, typeof v.name === 'string' ? v.name.length : null])), blockedNameLeaked: JSON.stringify(advertised).includes('Blocked gateway') };
});
await run('proxy credential presence follows the registry OAuth set and resolveProviderApiKey precedence', async () => {
  const variables = ['MIXDOG_PROXY_PROBE_ENV_TEST', 'MIXDOG_AGENT_PROXY-PROBE_APIKEY', 'OPENAI_API_KEY'];
  const saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  try {
    for (const name of variables) delete process.env[name];
    const oauthReads = [];
    const probe = modelProxyCredentialProbe({ OAUTH_PROVIDER_NAMES, oauthCredentialProbeState: (name) => { oauthReads.push(name); return 'unreadable'; }, hasProviderApiKey });
    const oauth = [probe('cursor-oauth', {}), probe('proxy-probe-oauth', {})];
    const cases = [['proxy-probe', { apiKey: 'config-file-key' }], ['proxy-probe', { apiKeyEnv: 'MIXDOG_PROXY_PROBE_ENV_TEST' }], ['proxy-probe', { apiKeyEnv: 'MIXDOG_PROXY_PROBE_ENV_TEST', apiKey: 'ignored-for-env-routes' }], ['proxy-probe', {}], ['custom-proxy-probe', { type: 'custom', auth: 'key', apiKeyEnv: 'MIXDOG_PROXY_PROBE_ENV_TEST' }]];
    const check = (step) => ({ step, env: Object.fromEntries(variables.map((n) => [n, process.env[n] ?? null])), results: cases.map(([name, config]) => ({ name, config, probe: probe(name, config), resolveProviderApiKeyFound: Boolean(resolveProviderApiKey(name, config)) })) });
    const log = [check('no environment')];
    process.env.MIXDOG_PROXY_PROBE_ENV_TEST = 'from-env';
    process.env['MIXDOG_AGENT_PROXY-PROBE_APIKEY'] = 'from-mixdog-env';
    log.push(check('both variables set'));
    log.push({ step: 'bare name with the MIXDOG_AGENT alias set', probe: probe('proxy-probe', {}) });
    delete process.env.MIXDOG_PROXY_PROBE_ENV_TEST;
    log.push({ step: 'named variable removed', customProbe: probe('custom-proxy-probe', cases[4][1]) });
    log.push(check('named variable removed (all cases)'));
    log.push({ step: 'custom auth none', probe: probe('custom-proxy-probe', { type: 'custom', auth: 'none' }) });
    return { oauthSet: { oauthProbes: oauth, oauthReads }, log };
  } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});

await set.finish({
  entry: {
    runs: 'apps/desktop/src/main/model-proxy-host.ts (createModelProxyHost, createModelProxyRuntime, modelProxyCredentialProbe) over the real ModelProxyChannel, ModelProxyProvider and loadModelProxyProviderConfig of the daemon side, joined through a JSON hop as the session connection does; resolveWireRoute / pinSessionWireRoute; the real provider-api-key helpers',
    notRun: 'no real provider: the PC providers and registry modules are scripted objects; timers are the host\'s real (unref\'d) heartbeat timers with injected `now` for the lease',
  },
  replay: {
    entry: 'mixdog-core run_host/model_proxy_pc.rs and mixdog-core-domains ai_admin/model_proxy.rs: drive the proxy channel and the PC host with the recorded scripted providers/registry and compare each case\'s observed fields whole',
    normalised: { secretShapedInputs: 'the test strings sk-abcdefghijklmnopqrstuvwxyz and sk-abcdefghijklmnop1234 are recorded with the sk-DUMMY- marker (the fixture secret scan refuses the original shape); the redactor treats both alike', heartbeats: 'heartbeat operation counts are not compared (real timers)', transportScope: 'the PC scope is <session>#<random>: its shape only', coldStartWait: 'a 50 ms wait became five event-loop turns' },
  },
  replaceInText: [],
});
process.exit(0);
