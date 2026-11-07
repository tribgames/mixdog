#!/usr/bin/env node
// Golden twin of the PC end of the model proxy (apps/desktop model-proxy-host.ts `createModelProxyRuntime` and
// `execute`, driven over the daemon's ModelProxyChannel as the desktop does): what `providerConfig` advertises,
// how `quotaUsable` shares one measurement per provider, what `resolveWireRoute` asks the adapter, and what a
// proxied run streams, answers and does when it is cancelled. Rust `run_host::model_proxy_pc` must equal it.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//     benchmarks/rust-core/recorders/record-model-proxy-pc.mjs --tree <dir> [--out <dir>]
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const host = await importFrom(tree, 'apps/desktop/src/main/model-proxy-host.ts');
const { ModelProxyChannel, MODEL_PROXY_REQUEST_EVENT } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs'
);

let seed = 0x7a31c5d9;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const settled = async (fn) => {
  try {
    return { value: plain(await fn()) };
  } catch (error) {
    return { error: { name: error?.name ?? null, message: String(error?.message ?? error), code: error?.code ?? null } };
  }
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (done) => {
  for (let spins = 0; !done(); spins += 1) {
    if (spins > 10_000) throw new Error('recorder: the condition never held');
    await tick();
  }
};

/** The daemon channel <-> the PC host over a JSON hop, as the session connection does. */
function connect(runtime, hostOptions = {}) {
  const channel = new ModelProxyChannel();
  const pc = host.createModelProxyHost({
    invoke: async (operation, args) =>
      JSON.parse(JSON.stringify((await channel.handleOperation(operation, JSON.parse(JSON.stringify(args)))) ?? null)),
    loadRuntime: async () => runtime,
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => pc.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  return {
    channel,
    pc,
    close() {
      detach();
      pc.dispose();
    },
  };
}

const modules = (extra) => ({
  loadConfig: () => ({ providers: {} }),
  initProviders: async () => {},
  getProvider: () => undefined,
  getAllProviders: () => new Map(),
  readApiKey: async () => null,
  probeAuth: () => 'present',
  finalizeProviderRequestTools: (tools) => tools,
  measureProviderQuota: async () => null,
  quotaMeasurementServesModel: () => true,
  ...extra,
});

// -- providerConfig: availability and adapter traits of a PC -----------------------------------------------------
// Adapter traits are the classes' own declarations (providers/*.mjs: `nativePdf`, `static inputExcludesCache`,
// `consumesReadWindows`, `takesImages`), by the name each class is registered under.
const CLASSES = {
  openai: { nativePdf: true, inputExcludesCache: false },
  'openai-oauth': { nativePdf: true, inputExcludesCache: false },
  anthropic: { nativePdf: true, inputExcludesCache: true },
  'anthropic-oauth': { nativePdf: true, inputExcludesCache: true },
  gemini: { nativePdf: true, inputExcludesCache: false },
  'vertex-ai': { nativePdf: true, inputExcludesCache: true },
  'antigravity-oauth': { nativePdf: true, inputExcludesCache: false },
  'devin-oauth': { nativePdf: false, inputExcludesCache: true },
  'grok-oauth': { nativePdf: false, inputExcludesCache: false },
  'cursor-oauth': { nativePdf: false, inputExcludesCache: false, consumesReadWindows: true },
  'cursor-api': { nativePdf: false, inputExcludesCache: false, consumesReadWindows: true },
  'mixdog-local': { nativePdf: false, inputExcludesCache: false, takesImages: false },
  'custom-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { nativePdf: false, inputExcludesCache: false },
  'custom-11111111-2222-3333-4444-555555555555': { nativePdf: false, inputExcludesCache: false },
};
const OAUTH = ['openai-oauth', 'anthropic-oauth', 'antigravity-oauth', 'devin-oauth', 'grok-oauth', 'cursor-oauth'];
const NAMES = Object.keys(CLASSES);
const STATES = ['present', 'absent', 'unreadable'];
const ENV_VARS = ['MDX_REC_KEY_A', 'MDX_REC_KEY_B', 'MDX_REC_KEY_C'];

const providerConfigCases = [];
for (let i = 0; i < 160; i += 1) {
  const available = {};
  for (const name of NAMES) {
    if (chance(0.4)) continue;
    const entry = {};
    if (chance(0.85)) entry.enabled = pick([true, true, false]);
    if (chance(0.2)) entry.credentialProbeUnavailable = pick([true, false]);
    if (name.startsWith('custom-')) {
      entry.type = 'custom';
      if (chance(0.5)) entry.name = pick(['  My GPU  ', 'Corp', '', 'sk-DUMMY-abcdefghijklmnop1234']);
      if (chance(0.5)) entry.models = [{ id: 'm1', hidden: true }, { id: 'm2' }];
      if (chance(0.4)) entry.modelOverrides = { m3: { hidden: true }, m4: { hidden: false } };
      if (chance(0.4)) entry.auth = pick(['none', 'key']);
      if (chance(0.5)) entry.apiKeyEnv = pick(ENV_VARS);
    }
    if (chance(0.25)) entry.apiKey = 'sk-secret';
    entry.baseURL = 'https://corp.example/v1';
    available[name] = entry;
  }
  const live = {};
  for (const name of NAMES) {
    if (!chance(0.65)) continue;
    live[name] = { nativePdf: CLASSES[name].nativePdf, budget: pick([null, null, { transportMs: 1000, semanticMs: 2000 }, { transportMs: 0, semanticMs: 5 }, { transportMs: -4, semanticMs: 9 }]) };
  }
  const oauth = Object.fromEntries(OAUTH.map((name) => [name, pick(STATES)]));
  const keysStored = NAMES.filter(() => chance(0.4));
  const env = ENV_VARS.filter(() => chance(0.5));
  const failSync = chance(0.04) ? 'registry exploded' : null;
  for (const name of ENV_VARS) delete process.env[name];
  for (const name of env) process.env[name] = 'value';
  const instances = new Map(
    Object.entries(live).map(([name, state]) => {
      const trait = CLASSES[name];
      class Instance {
        static inputExcludesCache = trait.inputExcludesCache;
        nativePdf = trait.nativePdf;
        firstResponseBudget() {
          return state.budget;
        }
      }
      const instance = new Instance();
      if (trait.consumesReadWindows) instance.consumesReadWindows = true;
      if (trait.takesImages === false) instance.takesImages = false;
      return [name, instance];
    })
  );
  const runtime = host.createModelProxyRuntime(
    modules({
      loadConfig: () => ({ providers: available }),
      initProviders: async () => {
        if (failSync) throw new Error(failSync);
      },
      getAllProviders: () => instances,
      probeAuth: host.modelProxyCredentialProbe({
        OAUTH_PROVIDER_NAMES: new Set(OAUTH),
        oauthCredentialProbeState: (name) => oauth[name],
        hasProviderApiKey: (name, config) =>
          config?.apiKeyEnv ? Boolean(process.env[config.apiKeyEnv]) : Boolean(config?.apiKey) || keysStored.includes(name),
      }),
    })
  );
  const link = connect(runtime);
  const answer = await settled(() => link.channel.request({ provider: '', method: 'providerConfig' }));
  link.close();
  providerConfigCases.push({ available, live, oauth, keysStored, env, failSync, ...answer });
}
for (const name of ENV_VARS) delete process.env[name];

// -- quotaUsable: one measurement per provider for a window, concurrent calls joining it --------------------------
const quotaScenarios = [];
async function quotaScenario(name, ops) {
  const clock = { now: 1_000 };
  const state = { measurements: 0, fail: false, gate: null };
  const runtime = host.createModelProxyRuntime(
    modules({
      now: () => clock.now,
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true }, 'anthropic-oauth': { enabled: true } } }),
      getProvider: () => ({ send: () => {} }),
      measureProviderQuota: async (provider) => {
        state.measurements += 1;
        await state.gate;
        if (state.fail) throw new Error('usage fetch failed');
        return { provider, servable: new Set(['gpt-a']) };
      },
      quotaMeasurementServesModel: (measurement, model) => measurement.servable.has(model),
    })
  );
  const link = connect(runtime);
  const ask = (provider, model) => settled(() => link.channel.request({ provider, method: 'quotaUsable', model }));
  const steps = [];
  for (const op of ops) {
    if (op.op === 'clock') {
      clock.now += op.ms;
      steps.push({ ...op, results: [], measurements: state.measurements });
    } else if (op.op === 'fail') {
      state.fail = op.on;
      steps.push({ ...op, results: [], measurements: state.measurements });
    } else if (op.op === 'ask') steps.push({ ...op, results: [await ask(op.provider ?? 'openai-oauth', op.model)], measurements: state.measurements });
    else if (op.op === 'burst') {
      let release;
      state.gate = new Promise((resolve) => (release = resolve));
      const before = state.measurements;
      const pending = op.models.map((model) => ask(op.provider ?? 'openai-oauth', model));
      await until(() => state.measurements > before);
      await tick();
      release();
      const results = await Promise.all(pending);
      state.gate = null;
      steps.push({ ...op, results, measurements: state.measurements });
    }
  }
  link.close();
  quotaScenarios.push({ name, steps });
}
await quotaScenario('concurrent calls join one measurement; models are judged against it', [
  { op: 'burst', models: ['gpt-a', 'junk-1', 'gpt-a', 'junk-2'] },
  { op: 'ask', model: 'junk-3' },
  { op: 'ask', model: 'gpt-a' },
  { op: 'clock', ms: 59_999 },
  { op: 'ask', model: 'gpt-a' },
  { op: 'clock', ms: 1 },
  { op: 'ask', model: 'gpt-a' },
  { op: 'ask', provider: 'anthropic-oauth', model: 'gpt-a' },
  { op: 'ask', provider: 'openai-oauth', model: 'x'.repeat(257) },
]);
await quotaScenario('a failed measurement is not cached', [
  { op: 'ask', model: 'gpt-a' },
  { op: 'clock', ms: 60_000 },
  { op: 'fail', on: true },
  { op: 'ask', model: 'gpt-a' },
  { op: 'ask', model: 'gpt-a' },
  { op: 'fail', on: false },
  { op: 'ask', model: 'gpt-a' },
  { op: 'ask', model: 'junk' },
]);
await quotaScenario('a burst that fails fails every caller once', [
  { op: 'fail', on: true },
  { op: 'burst', models: ['gpt-a', 'gpt-a', 'junk'] },
  { op: 'fail', on: false },
  { op: 'ask', model: 'gpt-a' },
]);

// -- resolveWireRoute: the adapter answers; the server says only agent and legacy ---------------------------------
const ROUTES = [
  { wire: 'messages', source: 'family', profileId: 'openrouter:messages' },
  { wire: 'chat', source: 'legacy', profileId: 'openrouter:chat' },
  { wire: 'responses', source: 'unknown', profileId: 'opencode-go-oauth:responses' },
];
const wireRouteCases = [];
const wireKinds = ['none', 'null', 'undefined', 'route', 'route', 'throws'];
for (let i = 0; i < 36; i += 1) {
  const kind = wireKinds[i % wireKinds.length];
  const route = pick(ROUTES);
  const context = pick([{}, { agent: true }, { legacy: true }, { agent: true, legacy: true }, { agent: 'yes', legacy: 1 }, { agent: false, legacy: false }]);
  const model = pick(['anthropic/claude-opus-4.8', 'gpt-5', '']);
  const seen = [];
  const provider = { send: async () => ({ content: 'x' }) };
  if (kind !== 'none') {
    provider.resolveWireRoute = async (asked, ctx) => {
      seen.push({ model: asked, context: ctx });
      if (kind === 'throws') throw new Error('roster unavailable');
      if (kind === 'null') return null;
      if (kind === 'undefined') return undefined;
      return route;
    };
  }
  const link = connect(host.createModelProxyRuntime(modules({
    loadConfig: () => ({ providers: { openrouter: { enabled: true } } }),
    getProvider: () => provider,
  })));
  const answer = await settled(() => link.channel.request({ provider: 'openrouter', method: 'resolveWireRoute', model, context }));
  link.close();
  wireRouteCases.push({ kind, route: kind === 'route' ? route : null, context: plain(context), model, seen: plain(seen), ...answer });
}

// -- a proxied run: its events, its answer, its cancel and its refusals -----------------------------------------
const runs = {};
{
  const events = [];
  const provider = {
    async send(_messages, _model, _tools, options) {
      options.onStageChange('streaming');
      options.onTextDelta('Hel');
      options.onTextDelta('lo');
      return { content: 'Hello', usage: { inputTokens: 7, outputTokens: 2 } };
    },
  };
  const link = connect(host.createModelProxyRuntime(modules({
    loadConfig: () => ({ providers: { openai: { enabled: true } } }),
    getProvider: () => provider,
  })));
  const answer = await settled(() =>
    link.channel.request(
      { provider: 'openai', method: 'send', model: 'gpt', messages: [], tools: null, options: {} },
      {
        callbacks: {
          onStageChange: (...args) => events.push({ name: 'onStageChange', args: plain(args) }),
          onTextDelta: (...args) => events.push({ name: 'onTextDelta', args: plain(args) }),
        },
      }
    )
  );
  link.close();
  runs.stream = { events, ...answer };
}
{
  const started = Promise.withResolvers();
  const reasons = [];
  const provider = {
    send(_messages, _model, _tools, options) {
      started.resolve();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reasons.push({ name: options.signal.reason?.name ?? null, message: options.signal.reason?.message ?? null });
          reject(options.signal.reason);
        });
      });
    },
  };
  const link = connect(host.createModelProxyRuntime(modules({
    loadConfig: () => ({ providers: { openai: { enabled: true } } }),
    getProvider: () => provider,
  })));
  const controller = new AbortController();
  const sending = settled(() =>
    link.channel.request(
      { provider: 'openai', method: 'send', model: 'gpt', messages: [], tools: null, options: {} },
      { signal: controller.signal }
    )
  );
  await started.promise;
  controller.abort(new Error('user stop'));
  const answer = await sending;
  await until(() => reasons.length > 0 && link.pc.running === 0);
  link.close();
  runs.cancel = { reasons, serverSees: answer };
}
{
  const refusals = [];
  for (const [label, name, options, config] of [
    ['not enabled', 'anthropic', {}, { providers: { openai: { enabled: true } } }],
    ['disabled', 'openai', {}, { providers: { openai: { enabled: false } } }],
    ['not allowed', 'openai', { isProviderAllowed: () => false }, { providers: { openai: { enabled: true } } }],
  ]) {
    const link = connect(host.createModelProxyRuntime(modules({
      loadConfig: () => config,
      getProvider: () => ({ send: async () => ({ content: 'x' }) }),
    })), options);
    const answer = await settled(() => link.channel.request({ provider: name, method: 'quotaUsable', model: 'm' }));
    link.close();
    refusals.push({ label, provider: name, ...answer });
  }
  runs.refusals = refusals;
}

// -- inputExcludesCache: each adapter class's own `static inputExcludesCache`, by registered name -----------------
// (registry.mjs `PROVIDER_MODULES`; a custom provider is an OpenAICompatProvider.) The usage accounting
// (usage-accounting.mjs:60), the context metrics (`providerInputExcludesCache`) and the proxy's advertisement read it.
const providerDir = 'src/runtime/agent/orchestrator/providers/';
const CLASS_OF = {
  anthropic: ['anthropic.mjs', 'AnthropicProvider'],
  'anthropic-oauth': ['anthropic-oauth.mjs', 'AnthropicOAuthProvider'],
  'antigravity-oauth': ['antigravity-oauth.mjs', 'AntigravityOAuthProvider'],
  'command-code-oauth': ['command-code-oauth.mjs', 'CommandCodeOAuthProvider'],
  'cursor-api': ['cursor.mjs', 'CursorApiProvider'],
  'cursor-oauth': ['cursor.mjs', 'CursorOAuthProvider'],
  deepseek: ['deepseek.mjs', 'DeepSeekProvider'],
  'devin-oauth': ['devin.mjs', 'DevinOAuthProvider'],
  gemini: ['gemini.mjs', 'GeminiProvider'],
  'grok-oauth': ['grok-oauth.mjs', 'GrokOAuthProvider'],
  'mimo-oauth': ['mimo-oauth.mjs', 'MimoOAuthProvider'],
  'mixdog-local': ['mixdog-local.mjs', 'MixdogLocalProvider'],
  'muse-code-oauth': ['muse-code-oauth.mjs', 'MuseCodeOAuthProvider'],
  'custom-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': ['openai-compat.mjs', 'OpenAICompatProvider'],
  'openai-oauth': ['openai-oauth.mjs', 'OpenAIOAuthProvider'],
  openai: ['openai-ws.mjs', 'OpenAIDirectProvider'],
  'opencode-go-oauth': ['opencode-go-oauth.mjs', 'OpenCodeGoOAuthProvider'],
  openrouter: ['openrouter.mjs', 'OpenRouterProvider'],
  'vertex-ai': ['vertex-ai.mjs', 'VertexAIProvider'],
};
const inputExcludesCache = {};
for (const [name, [file, cls]] of Object.entries(CLASS_OF)) {
  inputExcludesCache[name] = (await importFrom(tree, providerDir + file))[cls].inputExcludesCache;
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'model-proxy-pc');
writeJson(join(outDir, 'model-proxy-pc-twin.json'), {
  domain: 'model-proxy-pc-twin',
  recorder: 'benchmarks/rust-core/recorders/record-model-proxy-pc.mjs',
  oauthProviders: OAUTH,
  inputExcludesCache,
  providerConfigCases,
  quotaScenarios,
  wireRouteCases,
  runs,
});
writeSetManifest(outDir, {
  set: 'model-proxy-pc',
  recorder: 'benchmarks/rust-core/recorders/record-model-proxy-pc.mjs',
  command: 'node benchmarks/rust-core/recorders/record-model-proxy-pc.mjs --tree <tree>',
  identityTree: tree,
});
console.log(
  `recorded ${providerConfigCases.length} providerConfig cases, ${quotaScenarios.length} quota scenarios, ${wireRouteCases.length} wire routes`
);
process.exit(0);
