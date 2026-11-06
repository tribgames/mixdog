#!/usr/bin/env node
// Golden twin of the adoption half of `setRoute` and of `setFast` / `setEffort`
// (session-runtime/model-route/set-route.mjs, route-tuning.mjs, route-persist.mjs): Node's real
// route code runs over deterministic scenarios with a scripted catalog, config file and live
// route. Each entry holds the inputs, what Node answered, and the effects it produced (the route
// states it set, the config it saved, the refreshes it asked for). The session half of
// `setRoute` is the Rust `SessionRoutes`; scenarios here are unaddressed, so Node's `followSession`
// leaves the (absent) session alone.
//
//   node benchmarks/rust-core/recorders/record-route-service.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const helpers = await importFrom(tree, `${rc}config-helpers.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const workflow = await importFrom(tree, `${rc}workflow.mjs`);
const catalog = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-catalog.mjs');
const cfgMod = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const patchMod = await importFrom(tree, 'src/runtime/shared/config-patch.mjs');
const { createModelRouteApi } = await importFrom(tree, 'src/session-runtime/model-route-api.mjs');
const { createLeadRouteSync } = await importFrom(tree, 'src/session-runtime/config-lifecycle/lead-route-sync.mjs');

let seed = 0x0a0d17e5;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const KNOWN = ['openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'gemini'];
const MODELS = ['gpt-5', 'gpt-5.4', 'claude-opus-4-1', 'gemini-2.5-pro', 'nope-9', 'o3'];
const EFFORTS = [undefined, null, 'low', 'high', 'medium', 'auto', 'bogus'];
const PARAMS = [undefined, {}, { serviceTier: 'priority' }, { serviceTier: 'ultrafast' }, { a: 1 }];

function randomMeta() {
  const kind = pick(['fast', 'slow', 'placeholder', 'nowindow', 'fast']);
  if (kind === 'placeholder') return { id: 'x', provider: 'y' };
  const meta = { id: 'x', provider: 'y', name: 'Model X', supportsFastMode: kind === 'fast' || kind === 'nowindow' };
  if (kind !== 'nowindow') {
    meta.contextWindow = pick([128000, 200000, 400000]);
    meta.maxContextWindow = pick([200000, 1000000, 400000]);
  }
  if (chance(0.3)) meta.serviceTiers = ['ultrafast'];
  return meta;
}

function randomConfig() {
  const config = { providers: { openai: { apiKey: 'sk-fake' } } };
  if (chance(0.8)) {
    config.presets = [];
    for (const [id, name] of [['workflow-lead', 'WORKFLOW LEAD'], ['quick', 'Quick']].slice(0, pick([1, 2]))) {
      const preset = { id, name, type: 'agent', provider: pick(KNOWN), model: pick(MODELS) };
      if (chance(0.4)) preset.effort = pick(['low', 'high']);
      if (chance(0.3)) preset.fast = true;
      if (chance(0.4) && id === 'workflow-lead') preset.fallbacks = [{ provider: pick(['anthropic', 'gemini', 'openai-oauth']), model: pick(MODELS), effort: 'low' }];
      config.presets.push(preset);
    }
  }
  if (chance(0.8)) config.default = pick(['workflow-lead', 'quick', 'missing']);
  if (chance(0.5)) {
    config.modelSettings = {};
    for (let i = 0; i < pick([1, 2]); i += 1) {
      const s = {};
      if (chance(0.5)) s.effort = pick(['low', 'high']);
      if (chance(0.5)) s.fast = pick([true, false]);
      if (chance(0.3)) s.autoEffort = false;
      if (chance(0.3)) s.contextPercent = pick([30, 50]);
      config.modelSettings[`${pick(KNOWN)}/${pick(MODELS)}`] = s;
    }
  }
  return config;
}

const resolveRoute = (config) =>
  helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => KNOWN.includes(String(p || '').trim())))(config, {});

const knows = {};
for (const p of KNOWN) for (const m of MODELS) knows[`${p}/${m}`] = Boolean(catalog.getModelMetadataSync(m, p));

const SUBSET = ['default', 'presets', 'modelSettings'];
const subset = (config) => plain(Object.fromEntries(SUBSET.filter((k) => config?.[k] !== undefined).map((k) => [k, config[k]])));

const cases = [];
// The last 60 cases are `continueSessionInModel` (set-route.mjs): the quota escape hatch that
// adopts a selection and switches the addressed session in place.
for (let i = 0; i < 320; i += 1) {
  const kind = i >= 260 ? 'continue' : pick(['setRoute', 'setRoute', 'setRoute', 'setFast', 'setEffort']);
  const config = randomConfig();
  // The file may hold a Lead route this runtime has not read yet; only a conditional fill
  // re-reads the file before it writes (any other save applies to the document in memory).
  let fileOverride = null;
  const emptyLive = chance(0.25);
  const live = emptyLive
    ? { provider: 'openai', model: '', preset: null, effort: null, fast: false, autoEffort: true, modelParameters: {} }
    : { ...resolveRoute(config), effectiveEffort: pick([null, 'low', 'high']) };
  if (!emptyLive && chance(0.3)) live.model = pick(MODELS);
  const meta = randomMeta();
  const request = {};
  const options = {};
  let setFastValue = null;
  let effortValue = null;
  if (kind === 'setRoute' || kind === 'continue') {
    for (const key of ['provider', 'model']) {
      const v = pick(key === 'provider' ? [undefined, ...KNOWN, ' openai '] : [undefined, ...MODELS, 'quick', 'workflow-lead']);
      if (v !== undefined) request[key] = v;
    }
    const e = pick(EFFORTS);
    if (e !== undefined) request.effort = e;
    for (const key of ['fast', 'autoEffort']) if (chance(0.3)) request[key] = chance(0.5);
    const p = pick(PARAMS);
    if (p !== undefined) request.modelParameters = p;
    if (chance(0.25)) request.contextPercent = pick([30, 50, 100]);
    if (chance(0.2)) request.contextTokens = pick([100000, 128000, 200000]);
    if (chance(0.3)) request.fallbacks = pick([[], [{ provider: pick(['anthropic', 'gemini']), model: pick(MODELS) }], [{ provider: 'openai', model: 'gpt-5' }]]);
    if (chance(0.4)) options.keepMainModel = pick([false, false, true]);
    if (chance(0.25)) options.onlyIfEmpty = true;
    if (chance(0.15)) options.sessionOnly = true;
    if (chance(0.1)) options.validateOnly = true;
  } else if (kind === 'setFast') {
    setFastValue = pick([true, false, 'ultrafast']);
  } else {
    effortValue = pick(['low', 'HIGH', 'auto', '', 'bogus', 'medium']);
  }
  // The session a continue addresses, and the id it is asked for (a wrong or empty id is refused).
  let continueSessionId = null;
  let continueSession = null;
  let continueSessionBefore = null;
  if (kind === 'continue') {
    for (const key of Object.keys(options)) delete options[key];
    continueSessionId = pick(['t', 't', 't', 't', 'other', '']);
    continueSession = { id: 't', provider: pick(KNOWN), model: pick(MODELS), messages: [{ role: 'assistant', content: 'a' }] };
    // The route the session ran on, before the switch rewrites it.
    continueSessionBefore = { provider: continueSession.provider, model: continueSession.model };
  }
  if (options.onlyIfEmpty && chance(0.5)) {
    fileOverride = { ...config, default: 'workflow-lead', presets: [{ id: 'workflow-lead', name: 'WORKFLOW LEAD', type: 'agent', provider: 'anthropic', model: 'claude-opus-4-1' }] };
  }
  const fastTable = Object.fromEntries(KNOWN.map((p) => [p, Boolean(caps.fastCapableFor(p, meta, null, {}))]));
  const ultraTable = Object.fromEntries(KNOWN.map((p) => [p, Boolean(caps.ultrafastCapableFor(p, meta))]));

  const state = { config: structuredClone(config), route: structuredClone(live), file: structuredClone(config) };
  const log = { routeStates: [], refreshes: [], ensured: [], statusline: 0, saves: [] };
  const lifecycle = createLeadRouteSync({
    getRoute: () => state.route,
    getConfig: () => state.config,
    setRouteState: (r) => { state.route = r; log.routeStates.push(plain(r)); },
    resolveRoute: (c, r) => resolveRouteFn(c, r),
    clean: (v) => String(v ?? '').trim(),
  });
  const resolveRouteFn = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => KNOWN.includes(String(p || '').trim())));
  if (fileOverride) state.file = structuredClone(fileOverride);
  // The save is the lifecycle's: the stored-form difference to the last saved config, applied to
  // the file (a conditional Lead fill is skipped while the file holds a Lead route).
  let baseline = structuredClone(config);
  const writeFile = (next, leadFill) => {
    const changes = cfgMod.createConfigPatch(baseline, next).map((change) =>
      leadFill && ['default', 'presets'].includes(change.path[0]) ? { ...change, unlessSet: ['default'] } : change
    );
    baseline = structuredClone(next);
    state.file = patchMod.applyConfigPatch(state.file, changes);
  };
  const reloadFullConfig = () => {
    state.config = structuredClone(state.file);
    lifecycle.syncEmptyMainRoute(state.config);
    return state.config;
  };
  const saveConfigAndAdopt = (next, { leadFill = false } = {}) => {
    state.config = next;
    log.saves.push({ leadFill });
    writeFile(next, leadFill);
    return next;
  };
  const api = createModelRouteApi({
    getConfig: () => state.config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (r) => { state.route = r; log.routeStates.push(plain(r)); },
    getSession: () => continueSession,
    getSessionGeneration: () => 0,
    setSession: () => {},
    cfgMod: { loadConfig: () => state.config },
    resolveRoute: resolveRouteFn,
    lookupModelMeta: async () => structuredClone(meta),
    ensureProvidersReady: async (providers) => { log.ensured.push(plain(Object.keys(providers || {}))); },
    adoptConfig: (value) => { state.config = value; return value; },
    saveConfigAndAdopt,
    persistLeadRoute: (routeLike, { onlyIfAbsent = false } = {}) => {
      const leadRoute = workflow.normalizeWorkflowRoute(routeLike);
      if (!leadRoute) return null;
      const nextConfig = { ...state.config };
      nextConfig.presets = workflow.upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
      nextConfig.default = workflow.workflowPresetId('lead');
      saveConfigAndAdopt(nextConfig, { leadFill: onlyIfAbsent });
      return leadRoute;
    },
    reloadFullConfig,
    confirmLeadFill: async (filled) => {
      reloadFullConfig();
      return lifecycle.adoptFillWinner(filled);
    },
    refreshRouteEffort: async (m, expected, _unused, lease) => {
      log.refreshes.push({ meta: plain(m), expectedIsLive: expected === state.route, lease: plain(lease?.token ?? null) });
    },
    refreshStatuslineUsageSnapshot: () => { log.statusline += 1; },
    invalidateContextStatusCache: () => {},
    statusRoutes: {},
    mgr: {},
  });
  // Facts the scripted catalog cannot give Node: the real functions answer, recorded per case.
  let result;
  try {
    if (kind === 'setRoute') result = { value: plain(await api.setRoute(structuredClone(request), structuredClone(options))) };
    else if (kind === 'continue') {
      const got = plain(await api.continueSessionInModel(continueSessionId, structuredClone(request)));
      // The boundary's `at` is the clock's.
      if (got?.modelSwitch) got.modelSwitch.at = 0;
      result = { value: got };
    } else if (kind === 'setFast') result = { value: await api.setFast(setFastValue) };
    else result = { value: plain(await api.setEffort(effortValue)) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  cases.push({
    kind, config, fileOverride, live, meta, fastTable, ultraTable, knows, request, options, setFastValue, effortValue,
    continueSessionId, continueSession: continueSessionBefore,
    ...result,
    after: { route: plain(state.route), config: subset(state.config), file: subset(state.file) },
    log,
  });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'route-service-twin.json'), {
  domain: 'route-service-twin',
  recorder: 'benchmarks/rust-core/recorders/record-route-service.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-route-service.mjs',
  command: 'node benchmarks/rust-core/recorders/record-route-service.mjs --tree <tree>',
  identityTree: tree,
});
const errors = cases.filter((c) => c.error).length;
console.log(`recorded ${cases.length} route-service cases (${errors} errors)`);
