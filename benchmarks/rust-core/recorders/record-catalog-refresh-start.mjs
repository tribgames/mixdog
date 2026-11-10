#!/usr/bin/env node
// Node's provider-catalog refresh that a provider-readiness call starts (`ensureProvidersReady`,
// src/session-runtime/provider-readiness.mjs:146-182, over `refreshProviderCatalogsOnStartup`,
// src/runtime/agent/orchestrator/providers/registry.mjs:699-721) and what its completion does: the catalog revision moves
// (registry.mjs:717), the pending flag clears and the parked warm-ups are woken (`settle`), the model caches drop with the
// providers kept (`invalidateProviderCaches({ preserveProviderInit: true })`) and the secrets-carrying re-warm starts
// (`warmProviderModelCache({ loadSecrets: true })`). Also the 24 h catalog timer that each new refresh arms
// (`armNextCatalogRefresh`, registry.mjs:686-697): due and not due at its boundary. And which providers each refresh asks
// once a provider was disabled (`disableProvider`) or registered (`initProviders`) after the last readiness call, or while
// a refresh runs: the startup refresh, the timer's, a forced `refreshCatalogs`, a provider-scoped forced read and a read.
//
// Each scenario runs in its own Node process (the registry is process-global), side by side, in-process over the tree's
// own modules: the registry, `createProviderReadiness`, `createProviderModels` and the custom providers' real listing
// (`fetch`) against a loopback endpoint the scenario scripts. The config is the tree's `loadConfig()` over a temp data
// dir; the keychain is an empty stand-in (no OS keychain is touched). Time is virtual: timers wait in one queue ordered by
// due time, then registration order, and run one at a time only when a step advances the clock, with every microtask
// drained between callbacks (a real `setImmediate`). Every wait is on a Node promise or a request reaching the endpoint,
// each with its own deadline and message.
//
// Recorded per step: the product requests made so far (method, URL, the headers the product set, body; the request the
// product hands to `fetch`, before undici adds its own), the readiness' pending flag, the wakes, the re-warm calls, whether
// the provider-model cache is loaded and whether a load is in flight, and the rows of a full read.
//
//   node benchmarks/rust-core/recorders/record-catalog-refresh-start.mjs --tree <export of 7f633e730> --work <temp dir> [--only <scenario>]
//
// Output: native/core/fixtures/catalog-refresh-start/node-catalog-refresh-start.json (+ MANIFEST.json).
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// 7f633e730: the commit the model-list fixtures of this area are recorded from. The readiness, registry, catalog-deadline,
// provider-models and custom-provider code it runs is the same as at b6f10295a (`git diff b6f10295a 7f633e730` is empty
// for every module this recorder loads but the Anthropic ones, which no scenario registers).
const NODE_COMMIT = '7f633e7305166c5fc8ee66464859ab7de7b60b4d';
const RECORDER = 'benchmarks/rust-core/recorders/record-catalog-refresh-start.mjs';
const SEEDS = 'benchmarks/rust-core/recorders/model-lists/seeds.json';
const HERE = fileURLToPath(import.meta.url);
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_MS = 60_000;

const A = 'custom-0a0a0a0a-0000-4000-8000-00000000000a';
const B = 'custom-0b0b0b0b-0000-4000-8000-00000000000b';
const C = 'custom-0c0c0c0c-0000-4000-8000-00000000000c';
const E = 'custom-0e0e0e0e-0000-4000-8000-00000000000e';
const provider = (name, path, extra = {}) => ({ type: 'custom', schemaVersion: 2, name, protocol: 'openai-chat', baseURL: `__BASE_URL__/${path}/v1`, auth: 'none', enabled: true, ...extra });
const list = (...ids) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'fixture' })) });
const agent = (providers) => ({ providers, presets: [{ id: 'p1', name: 'P1', provider: A, model: 'a-1' }], default: 'p1' });
const A_AND_DISABLED_B = agent({ [A]: provider('Alpha', 'a'), [B]: provider('Beta', 'b', { enabled: false }) });
const A_AND_B = agent({ [A]: provider('Alpha', 'a'), [B]: provider('Beta', 'b') });
const AB_STUB = { '/a/v1/models': list('a-1'), '/b/v1/models': list('b-1') };

// Steps: `ready` (a readiness call over the runtime's providers, or with `enable` switched on as a route selection does,
// `ensureProviderEnabled`; `hold` paths are held at the endpoint and the step waits for each to arrive), `release` (the held
// requests are answered), `settle` (the observed refresh, the completion's re-warms and any load in flight have ended),
// `read` (a full `listProviderModels` read; `force` and `provider` as `collectProviderModels` takes them), `serve` (the
// endpoint answers `stub` from now on), `advance` (virtual time moves by `ms`, running each timer that falls due; `hold`
// as for `ready`), `settleTimer` (the catalog refresh the 24 h timer started has ended), `disable` (`disableProvider`,
// what turning a provider off or removing it does to the registry, apis.mjs:300,327,461), `init` (the registry initialized
// with `enable` switched on, outside the readiness, as an agent run's provider setup does), `refresh` (a forced
// `refreshCatalogs`, then the model caches drop with the providers kept: `refreshLocalProviderCatalog`'s tail,
// apis.mjs:308-309).
const SCENARIOS = [
  {
    name: 'a-ready-call-starts-the-refresh-and-its-completion-rewarms',
    agent: A_AND_DISABLED_B,
    stub: { '/a/v1/models': list('a-1'), '/b/v1/models': list('b-1') },
    steps: [
      { do: 'ready', hold: ['/a/v1/models'] },
      { do: 'release' },
      { do: 'settle' },
      { do: 'read' },
      { do: 'serve', stub: { '/a/v1/models': list('a-1', 'a-2'), '/b/v1/models': list('b-1') } },
      { do: 'ready' },
      { do: 'read' },
      { do: 'ready', enable: B, hold: ['/a/v1/models', '/b/v1/models'] },
      { do: 'release' },
      { do: 'settle' },
      { do: 'read' },
    ],
  },
  {
    name: 'a-second-ready-call-during-a-running-refresh-joins-it',
    agent: A_AND_DISABLED_B,
    stub: { '/a/v1/models': list('a-1'), '/b/v1/models': list('b-1') },
    steps: [{ do: 'ready', hold: ['/a/v1/models'] }, { do: 'ready' }, { do: 'release' }, { do: 'settle' }, { do: 'read' }],
  },
  {
    name: 'a-provider-set-change-during-a-running-refresh-starts-another',
    agent: A_AND_DISABLED_B,
    stub: { '/a/v1/models': list('a-1'), '/b/v1/models': list('b-1') },
    steps: [
      { do: 'ready', hold: ['/a/v1/models'] },
      { do: 'ready', enable: B, hold: ['/b/v1/models'] },
      { do: 'release' },
      { do: 'settle' },
      { do: 'read' },
    ],
  },
  {
    name: 'a-refresh-that-fails',
    agent: agent({ [A]: provider('Alpha', 'a') }),
    stub: { '/a/v1/models': { __status: 500 } },
    steps: [{ do: 'ready', hold: ['/a/v1/models'] }, { do: 'release' }, { do: 'settle' }, { do: 'read' }],
  },
  {
    name: 'a-failed-refresh-after-a-good-one',
    agent: A_AND_DISABLED_B,
    stub: { '/a/v1/models': list('a-1'), '/b/v1/models': list('b-1') },
    steps: [
      { do: 'ready' },
      { do: 'settle' },
      { do: 'read' },
      { do: 'serve', stub: { '/a/v1/models': { __status: 500 }, '/b/v1/models': list('b-1') } },
      { do: 'ready', enable: B },
      { do: 'settle' },
      { do: 'read' },
    ],
  },
  {
    name: 'providers-without-credentials',
    agent: agent({
      [A]: provider('Alpha', 'a'),
      [C]: provider('Gamma', 'c', { auth: 'key' }),
      [E]: provider('Epsilon', 'e', { auth: 'key', apiKeyEnv: 'MIXDOG_RECORDER_UNSET_KEY' }),
    }),
    stub: { '/a/v1/models': list('a-1'), '/c/v1/models': list('c-1'), '/e/v1/models': list('e-1') },
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'read' }],
  },
  {
    name: 'the-catalog-timer-at-its-boundary',
    agent: agent({ [A]: provider('Alpha', 'a') }),
    stub: { '/a/v1/models': list('a-1') },
    steps: [
      { do: 'ready' },
      { do: 'settle' },
      { do: 'read' },
      { do: 'serve', stub: { '/a/v1/models': list('a-1', 'a-2') } },
      { do: 'advance', ms: DAY_MS - 1 },
      { do: 'ready' },
      { do: 'read' },
      { do: 'advance', ms: 1 },
      { do: 'settleTimer' },
      { do: 'read' },
    ],
  },
  // A provider turned off, then each kind of refresh: none asks it again. The list each refresh asks is the registry's
  // as it stands when that refresh begins (registry.mjs:708, 729, 762; `sharedProviderCatalog`, provider-catalog-cache.mjs:147).
  {
    name: 'a-ready-call-and-a-read-after-a-disable',
    agent: A_AND_B,
    stub: AB_STUB,
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'read' }, { do: 'disable', disable: B }, { do: 'ready' }, { do: 'settle' }, { do: 'read' }],
  },
  {
    name: 'a-forced-refresh-after-a-disable',
    agent: A_AND_B,
    stub: AB_STUB,
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'disable', disable: B }, { do: 'refresh' }, { do: 'settle' }, { do: 'read' }],
  },
  {
    name: 'a-forced-read-of-the-disabled-provider',
    agent: A_AND_B,
    stub: AB_STUB,
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'disable', disable: B }, { do: 'read' }, { do: 'read', force: true, provider: B }],
  },
  {
    name: 'the-catalog-timer-after-a-disable',
    agent: A_AND_B,
    stub: AB_STUB,
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'disable', disable: B }, { do: 'advance', ms: DAY_MS }, { do: 'settleTimer' }, { do: 'read' }],
  },
  {
    name: 'a-disable-during-a-running-refresh',
    agent: A_AND_B,
    stub: AB_STUB,
    steps: [
      { do: 'ready', hold: ['/a/v1/models', '/b/v1/models'] },
      { do: 'disable', disable: B },
      { do: 'release' },
      { do: 'settle' },
      { do: 'read' },
      { do: 'advance', ms: DAY_MS, hold: ['/a/v1/models'] },
      { do: 'disable', disable: A },
      { do: 'release' },
      { do: 'settleTimer' },
      { do: 'refresh' },
      { do: 'settle' },
    ],
  },
  // A provider registered outside the readiness, then the next refreshes: they ask it.
  {
    name: 'the-catalog-timer-after-an-enable',
    agent: A_AND_DISABLED_B,
    stub: AB_STUB,
    steps: [{ do: 'ready' }, { do: 'settle' }, { do: 'init', enable: B }, { do: 'advance', ms: DAY_MS }, { do: 'settleTimer' }, { do: 'read' }],
  },
  {
    name: 'an-enable-during-a-running-refresh',
    agent: A_AND_DISABLED_B,
    stub: AB_STUB,
    steps: [
      { do: 'ready' },
      { do: 'settle' },
      { do: 'advance', ms: DAY_MS, hold: ['/a/v1/models'] },
      { do: 'init', enable: B },
      { do: 'release' },
      { do: 'settleTimer' },
      { do: 'advance', ms: DAY_MS },
      { do: 'settleTimer' },
    ],
  },
];

const args = parseArgs();
if (args.has('child')) await child(args);
else await parent(args);

async function parent(args) {
  const tree = resolveTree(args);
  const work = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
  mkdirSync(work, { recursive: true });
  const only = args.get('only') ?? null;
  const scenarios = SCENARIOS.filter((s) => !only || s.name === only);
  if (!scenarios.length) throw new Error(`no scenario named ${only}`);
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const root = mkdtempSync(join(work, 'catalog-refresh-start-'));
  const startedAt = Date.now();
  const results = await Promise.all(scenarios.map((scenario) => runChild(tree, root, scenario)));
  console.log(`recorded ${results.length} scenario(s) in ${Date.now() - startedAt} ms`);
  rmSync(root, { recursive: true, force: true });
  // `--print`: the results on stdout, no fixture written (a trial run).
  if (args.has('print')) {
    console.log(JSON.stringify(results, null, 1));
    return;
  }
  const finalDir = join(FIXTURES_ROOT, 'catalog-refresh-start');
  const file = join(finalDir, 'node-catalog-refresh-start.json');
  // `--only` re-records one scenario and keeps the others as they were recorded.
  const kept = only ? JSON.parse(readFileSync(file, 'utf8')).scenarios.filter((s) => s.name !== only) : [];
  const byOrder = (s) => SCENARIOS.findIndex((d) => d.name === s.name);
  const all = [...kept, ...results].sort((a, b) => byOrder(a) - byOrder(b));
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'node-catalog-refresh-start.json'), { nodeCommit: NODE_COMMIT, nodeVersion: process.version, now: NOW, baseURL: '__BASE_URL__', seeds: JSON.parse(readFileSync(join(REPO_ROOT, SEEDS), 'utf8')), scenarios: all });
  writeSetManifest(stage, {
    set: 'catalog-refresh-start',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <export of ${NODE_COMMIT}> --work <temp dir>`,
    identity,
    extra: recordingProvenance(RECORDER, [SEEDS, 'benchmarks/rust-core/recorders/lib/common.mjs']),
  });
  commitStage(stage, finalDir);
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

async function runChild(tree, root, scenario) {
  const dir = join(root, scenario.name);
  const home = join(dir, 'home');
  const paths = { dataDir: join(home, '.mixdog', 'data'), appData: join(home, 'AppData', 'Roaming'), localAppData: join(home, 'AppData', 'Local'), tmp: join(dir, 'tmp'), runtime: join(dir, 'runtime') };
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });
  const env = {};
  const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_|XAI_|DEEPSEEK_|OPENROUTER_)/i;
  for (const [name, value] of Object.entries(process.env)) if (!DROP.test(name)) env[name] = value;
  Object.assign(env, {
    MIXDOG_DATA_DIR: paths.dataDir,
    MIXDOG_HOME: join(home, '.mixdog'),
    MIXDOG_RUNTIME_ROOT: paths.runtime,
    HOME: home,
    USERPROFILE: home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    TMPDIR: paths.tmp,
    NO_PROXY: '127.0.0.1,localhost',
  });
  const child = spawn(process.execPath, ['--no-warnings', HERE, '--child', scenario.name, '--tree', tree], { env, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => killTree(child), 120_000);
  try {
    const code = await new Promise((done) => child.once('exit', done));
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) throw new Error(`${scenario.name}: no result (exit ${code})\n${stdout}\n${stderr}`);
    const result = JSON.parse(line.slice(7));
    if (result.failed) throw new Error(`${scenario.name}: ${result.failed}\n${stderr}`);
    return result;
  } finally {
    clearTimeout(timer);
    killTree(child);
  }
}

async function child(args) {
  const name = args.get('child');
  const scenario = SCENARIOS.find((s) => s.name === name);
  const tree = resolve(args.get('tree'));
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setImmediate: globalThis.setImmediate, now: Date.now, fetch: globalThis.fetch };
  const out = { name, agent: scenario.agent, stub: scenario.stub, steps: [] };
  let failure = null;
  let server = null;
  try {
    // The endpoint: each answer is the scenario's stub for the path (an empty list otherwise); a request to a held path
    // waits for `release`.
    let stub = scenario.stub;
    let hold = new Set();
    const held = [];
    const arrivals = [];
    const arrivalWaiters = [];
    server = http.createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      const answer = () => {
        const reply = stub[path] ?? { object: 'list', data: [] };
        response.setHeader('content-type', 'application/json');
        response.statusCode = reply.__status ?? 200;
        response.end(JSON.stringify(reply.__status ? {} : reply));
      };
      arrivals.push(path);
      for (const waiter of arrivalWaiters.splice(0)) waiter();
      if (hold.has(path)) held.push(answer);
      else answer();
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const withBase = (value) => JSON.parse(JSON.stringify(value).replaceAll('__BASE_URL__', baseURL));

    const dataDir = process.env.MIXDOG_DATA_DIR;
    const seeds = JSON.parse(readFileSync(join(REPO_ROOT, SEEDS), 'utf8'));
    writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: NOW, data: seeds.modelsDev }));
    writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: NOW, data: seeds.litellm }));
    writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: withBase(scenario.agent) }, null, 2));

    // The product requests to the endpoint, as handed to fetch; the metadata hosts fail as offline.
    const requests = [];
    const OFFLINE = new Set(['models.dev', 'raw.githubusercontent.com', 'registry.npmjs.org']);
    globalThis.fetch = (input, init = {}) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (OFFLINE.has(new URL(url).hostname)) return Promise.reject(new TypeError(`offline: ${new URL(url).hostname}`));
      if (!url.startsWith(baseURL)) throw new Error(`a request left the scripted endpoint: ${url}`);
      const headers = init.headers instanceof Headers ? [...init.headers] : Object.entries(init.headers ?? {});
      requests.push({ method: init.method ?? 'GET', url: url.replace(baseURL, '__BASE_URL__'), headers: headers.map(([k, v]) => [k, String(v)]), body: init.body == null ? null : String(init.body) });
      return real.fetch(input, init);
    };

    const registry = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');
    const { createProviderReadiness } = await importFrom(tree, 'src/session-runtime/provider-readiness.mjs');
    const { createProviderModels } = await importFrom(tree, 'src/session-runtime/provider-models.mjs');
    const { loadConfig } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
    const { ensureProviderEnabled } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
    const { sortProviderModels, providerModelCacheRow } = await importFrom(tree, 'src/session-runtime/model-recency.mjs');
    const { resolveRoute, webSearchCapableFor } = await importFrom(tree, 'src/session-runtime/boot/shared.mjs');
    const { normalizeWebSearchProviderId, isWebSearchCapableProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');

    // Virtual time from here on.
    let now = NOW;
    let seq = 0;
    let queue = [];
    const timerLog = [];
    const checkpoint = () => new Promise((done) => real.setImmediate(done));
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const timer = { due: now + Math.max(0, Number(ms) || 0), seq: ++seq, fn, rest, cleared: false, ms: Math.max(0, Number(ms) || 0) };
      Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => false, refresh: () => { timer.due = now + timer.ms; timer.seq = ++seq; return timer; }, [Symbol.toPrimitive]: () => timer.seq });
      queue.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      if (timer && typeof timer === 'object') timer.cleared = true;
    };
    Date.now = () => now;
    const pending = () => queue.filter((t) => !t.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq);
    async function advance(ms) {
      const target = now + ms;
      for (;;) {
        const [next] = pending();
        if (!next || next.due > target) break;
        queue = queue.filter((t) => t !== next);
        now = next.due;
        timerLog.push({ at: now - NOW, ms: next.ms });
        next.fn(...next.rest);
        await checkpoint();
      }
      now = target;
    }
    // `promise`, or a failure naming `label` once STEP_MS of real time passed without it.
    async function within(label, promise) {
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = real.setTimeout(() => reject(new Error(`${label}: not within ${STEP_MS} ms`)), STEP_MS);
      });
      try {
        return await Promise.race([promise, deadline]);
      } finally {
        real.clearTimeout(timer);
      }
    }
    // A request to `path` arrived at or after the `from`th arrival.
    function arrived(path, from) {
      return new Promise((done) => {
        const check = () => {
          if (arrivals.indexOf(path, from) !== -1) done();
          else arrivalWaiters.push(check);
        };
        check();
      });
    }

    const rt = { config: loadConfig(), closeRequested: false, wakes: 0 };
    rt.wakeDeferredWarmups = () => {
      rt.wakes += 1;
    };
    rt.route = resolveRoute(rt.config, {});
    const keychain = { prewarmSecrets: () => Promise.resolve(), onKeychainRecovered: () => () => {} };
    const rewarms = [];
    let warm = null;
    const readiness = createProviderReadiness({
      rt,
      keychain,
      getReg: () => registry,
      getWarmProviderModelCache: () => (options) => {
        rewarms.push(options);
        const load = warm(options);
        if (load) loads.push(load);
        return load;
      },
    });
    const loads = [];
    const models = createProviderModels({
      caches: readiness.providerModelCaches,
      modelMetaByRoute: readiness.modelMetaByRoute,
      getRoute: () => rt.route,
      getConfig: () => rt.config,
      getReg: () => registry,
      webSearchCapableFor,
      sortProviderModelsRaw: sortProviderModels,
      providerModelCacheRowRaw: providerModelCacheRow,
      normalizeWebSearchProviderId,
      isWebSearchCapableProvider,
      ensureFullConfig: () => {},
      awaitKeychainPrewarm: readiness.awaitKeychainPrewarm,
      ensureProvidersReady: readiness.ensureProvidersReady,
      bootProfile: () => {},
      scheduleProviderModelWarmup: () => {},
      quickHelpers: {},
    });
    warm = models.warmProviderModelCache;
    const caches = readiness.providerModelCaches;

    const observe = (extra = {}) => ({
      requests: requests.length,
      pending: rt.startupProviderCatalogRefreshPending === true,
      wakes: rt.wakes,
      rewarms: rewarms.map((o) => o ?? null),
      cacheLoaded: Array.isArray(caches.providerModelsCache.models),
      loadInFlight: Boolean(caches.providerModelsPromise),
      ...extra,
    });
    async function settle(label) {
      const refresh = rt.startupProviderCatalogRefreshObserved;
      if (refresh) await within(`${label}: the observed catalog refresh`, Promise.resolve(refresh));
      await checkpoint();
      while (loads.length) await within(`${label}: a re-warm's load`, loads.shift());
      if (caches.providerModelsPromise) await within(`${label}: the provider-model load in flight`, caches.providerModelsPromise);
      await checkpoint();
    }

    for (const step of scenario.steps) {
      const label = `${name} step ${out.steps.length} (${step.do})`;
      // A held path is waited for among the requests this step makes.
      const from = arrivals.length;
      if (step.do === 'ready') {
        hold = new Set(step.hold ?? []);
        const providers = step.enable ? ensureProviderEnabled(rt.config, step.enable) : rt.config.providers || {};
        let result;
        try {
          await within(label, readiness.ensureProvidersReady(providers));
          result = { ok: true };
        } catch (error) {
          result = { ok: false, error: String(error?.message || error) };
        }
        for (const path of step.hold ?? []) await within(`${label}: the held request to ${path}`, arrived(path, from));
        await checkpoint();
        // Without a hold nothing has settled at this point: how many requests the started listings already handed to
        // fetch is a matter of microtask timing, so the count is recorded at the next step that waits for them.
        const { requests: sent, ...state } = observe();
        out.steps.push({ ...step, ...result, observed: step.hold ? { requests: sent, ...state } : state });
      } else if (step.do === 'release') {
        hold = new Set();
        for (const answer of held.splice(0)) answer();
        out.steps.push({ ...step, observed: observe() });
      } else if (step.do === 'settle') {
        await settle(label);
        out.steps.push({ ...step, observed: observe() });
      } else if (step.do === 'read') {
        const options = step.force ? { force: true, provider: step.provider ?? null } : {};
        const rows = await within(label, models.collectProviderModels(options));
        await checkpoint();
        out.steps.push({ ...step, observed: observe({ rows }) });
      } else if (step.do === 'disable') {
        const removed = registry.disableProvider(step.disable);
        await checkpoint();
        out.steps.push({ ...step, removed, observed: observe() });
      } else if (step.do === 'init') {
        await within(label, registry.initProviders(ensureProviderEnabled(rt.config, step.enable)));
        await checkpoint();
        out.steps.push({ ...step, observed: observe() });
      } else if (step.do === 'refresh') {
        await within(label, registry.refreshCatalogs({ force: true }));
        readiness.invalidateProviderCaches({ preserveProviderInit: true });
        await checkpoint();
        out.steps.push({ ...step, observed: observe() });
      } else if (step.do === 'serve') {
        stub = step.stub;
        out.steps.push({ ...step, observed: observe() });
      } else if (step.do === 'advance') {
        const fired = timerLog.length;
        if (step.hold) hold = new Set(step.hold);
        await advance(step.ms);
        for (const path of step.hold ?? []) await within(`${label}: the held request to ${path}`, arrived(path, from));
        await checkpoint();
        // As an unheld `ready`: a refresh the timer started has not settled, so the request count waits for `settleTimer`.
        const { requests: sent, ...state } = observe({ timersFired: timerLog.slice(fired).filter((t) => t.ms === DAY_MS).length });
        out.steps.push({ ...step, observed: step.hold ? { requests: sent, ...state } : state });
      } else if (step.do === 'settleTimer') {
        // The refresh the 24 h timer started (`refreshCatalogs`, single flight while it runs): joined, not started. The
        // timer that fired re-armed itself before its refresh began, so this call cannot arm one either.
        if (!pending().some((t) => t.ms === DAY_MS)) throw new Error(`${label}: no 24 h timer is armed`);
        await within(label, registry.refreshCatalogs());
        await settle(label);
        out.steps.push({ ...step, observed: observe() });
      } else throw new Error(`unknown step ${step.do}`);
    }
    await settle(`${name} end`);
    out.requests = requests;
    out.final = observe();
  } catch (error) {
    failure = error;
  } finally {
    server?.closeAllConnections?.();
    server?.close();
  }
  process.stdout.write(`RESULT ${JSON.stringify(failure ? { name, failed: String(failure?.stack || failure) } : out)}\n`);
  process.exit(failure ? 1 : 0);
}
