#!/usr/bin/env node
// Golden twin of the pure route helpers behind `route/set`, `fast/set` and the setup tool's
// route actions: `resolveRoute`, `saveModelSettings`, `normalizeWorkflowRoute`,
// `upsertWorkflowPreset`, `resolveRouteContextState`, effort and model-selector checks.
// Deterministic cases over fake configs; each entry holds the inputs and what Node answered
// (a value, or the error text). Rust `mixdog_ai::service::admin_route` must equal all of it.
//
//   node benchmarks/rust-core/recorders/record-route-admin.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

// The set is shared by the ai-admin recorders: each one re-lists it after its own write.
const refreshAdminManifest = (dir, tree) =>
  writeSetManifest(dir, {
    set: 'ai-admin',
    recorder: 'benchmarks/rust-core/recorders/record-route-admin.mjs',
    command: 'node benchmarks/rust-core/recorders/record-route-admin.mjs --tree <tree>',
    identityTree: tree,
  });

const cli = parseArgs();
const tree = resolveTree(cli);
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const helpers = await importFrom(tree, `${rc}config-helpers.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const workflow = await importFrom(tree, `${rc}workflow.mjs`);
const effort = await importFrom(tree, `${rc}effort.mjs`);
const ctx = await importFrom(tree, `${rc}route-context-state.mjs`);

let seed = 0x5a17e0de;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const PROVIDERS = ['openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'gemini', 'custom-x', 'xai-api', 'openai-api', ' openai '];
const KNOWN = ['openai', 'openai-oauth', 'anthropic', 'anthropic-oauth', 'gemini'];
const MODELS = ['gpt-5', 'claude-opus', 'gemini-2.5-pro', 'm 1', '', ' gpt-5 ', '~rolling', 'a/b:c@d+e', 'x'.repeat(161), 'é', '\u0085x'];
const EFFORTS = [undefined, null, '', 'auto', 'low', ' HIGH ', 'ultra', 'max', 'bogus', 7];
const PARAMS = [undefined, {}, { serviceTier: 'priority' }, { serviceTier: '', a: 1 }, { ' k ': ' v ', n: null }, [1, 2], null];
const PERCENT = [undefined, null, 0, -5, 5, 14, 15, 25, 95, 100, 120, '30', 'x', 33.5];
const TOKENS = [undefined, null, 0, -1, 1000, 123456.5, 600000, '200000', 'x'];

function maybe(obj, key, values) {
  const v = pick(values);
  if (v !== undefined || chance(0.1)) obj[key] = v;
}

function randomSettings() {
  const s = {};
  if (chance(0.5)) s.effort = pick(['low', 'high', 'bogus', null]);
  if (chance(0.5)) s.fast = pick([true, false, 'yes']);
  if (chance(0.3)) s.autoEffort = pick([true, false]);
  if (chance(0.4)) s.modelParameters = pick(PARAMS.filter((p) => p !== undefined));
  if (chance(0.3)) s.contextPercent = pick([30, 50, 100, 'x']);
  if (chance(0.3)) s.contextTokens = pick([100000, 300000]);
  return s;
}

function randomConfig() {
  const config = { providers: { openai: { apiKey: 'sk-fake' } } };
  if (chance(0.8)) {
    config.presets = [];
    for (let i = 0; i < pick([1, 2, 3]); i += 1) {
      const preset = { id: pick(['workflow-lead', 'main', 'P2', 'quick']), name: pick(['Main', 'Quick', 'WORKFLOW LEAD']), provider: pick(PROVIDERS), model: pick(MODELS) };
      if (chance(0.4)) preset.effort = pick(['low', 'xhigh', 'bad']);
      if (chance(0.3)) preset.fast = pick([true, false]);
      if (chance(0.2)) preset.autoEffort = false;
      if (chance(0.3)) preset.modelParameters = pick([{ serviceTier: 'flex' }, {}]);
      if (chance(0.3)) preset.contextPercent = pick([40, 80]);
      if (chance(0.2)) preset.contextTokens = 250000;
      config.presets.push(preset);
    }
  }
  if (chance(0.7)) config.default = pick(['workflow-lead', 'main', 'Quick', 'missing', 3, null]);
  if (chance(0.7)) {
    config.modelSettings = {};
    for (let i = 0; i < pick([1, 2, 3]); i += 1) config.modelSettings[`${pick(['openai', 'anthropic-oauth', 'gemini'])}/${pick(['gpt-5', 'claude-opus', 'm'])}`] = randomSettings();
  }
  return config;
}

function randomRequest() {
  const r = {};
  maybe(r, 'provider', [undefined, undefined, ...PROVIDERS]);
  maybe(r, 'model', [undefined, ...MODELS, 'Main', 'workflow-lead', 'quick']);
  maybe(r, 'effort', EFFORTS);
  maybe(r, 'fast', [undefined, true, false, null, 'x']);
  maybe(r, 'autoEffort', [undefined, true, false, null]);
  maybe(r, 'modelParameters', PARAMS);
  maybe(r, 'contextPercent', PERCENT);
  maybe(r, 'contextTokens', TOKENS);
  return r;
}

const outcome = (call) => {
  try {
    const value = call();
    return { value: value === undefined ? null : value };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

const resolveCases = [];
for (let i = 0; i < 400; i += 1) {
  const config = randomConfig();
  const request = randomRequest();
  const known = chance(0.5) ? KNOWN : ['openai'];
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const route = outcome(() => plain(resolveRoute(structuredClone(config), structuredClone(request))));
  const entry = { config, request, known, resolve: route };
  if (route.value) {
    const fastCapable = chance(0.5);
    const withDefault = { ...route.value, contextDefaultPercent: pick([undefined, 50, 70, 100]) };
    entry.save = { fastCapable, route: plain(withDefault), config: plain(caps.saveModelSettings({ loadConfig: () => ({}) }, withDefault, { fastCapable, baseConfig: structuredClone(config) })) };
  }
  resolveCases.push(entry);
}

const routeLeaf = () => {
  const r = {};
  maybe(r, 'provider', [...PROVIDERS, undefined, '']);
  maybe(r, 'model', [...MODELS, undefined]);
  maybe(r, 'effort', EFFORTS);
  maybe(r, 'fast', [undefined, true, false, null]);
  maybe(r, 'autoEffort', [undefined, true, false, null]);
  maybe(r, 'modelParameters', PARAMS);
  maybe(r, 'contextPercent', PERCENT);
  maybe(r, 'contextTokens', TOKENS);
  return r;
};
const normalizeCases = [];
for (let i = 0; i < 400; i += 1) {
  const route = routeLeaf();
  if (chance(0.4)) route.fallbacks = pick([[routeLeaf()], [routeLeaf(), routeLeaf()], [], null, 'x', [{ fallbacks: [] }]]);
  const fallback = chance(0.3) ? routeLeaf() : {};
  const strict = chance(0.4);
  const entry = { route, fallback, strict, normalize: outcome(() => plain(workflow.normalizeWorkflowRoute(structuredClone(route), structuredClone(fallback), { strict }))) };
  if (chance(0.5)) {
    const presets = chance(0.8) ? [{ id: 'workflow-lead', name: 'x' }, { id: 'keep', name: 'WORKFLOW AGENT' }, { id: 'other', name: 'y' }] : pick([undefined, null, 'x']);
    const slot = pick(['lead', 'agent']);
    entry.upsert = { slot, presets, ...outcome(() => plain(workflow.upsertWorkflowPreset(structuredClone(presets), slot, structuredClone(route)))) };
  }
  normalizeCases.push(entry);
}

const contextCases = [];
for (let i = 0; i < 300; i += 1) {
  const route = { provider: pick(['openai', 'mixdog-local', 'Local', 'anthropic']) };
  maybe(route, 'contextPercent', PERCENT);
  maybe(route, 'contextTokens', TOKENS);
  const meta = pick([null, {}, { contextWindow: 200000 }, { contextWindow: 272000, maxContextWindow: 1000000 }, { contextWindow: 1000000 }, { contextWindow: 520000, maxContextWindow: 560000 }, { contextWindow: '400000', maxContextWindow: 800000 }, { maxContextWindow: 100000 }]);
  const cached = pick([null, null, { contextWindow: 272000, maxContextWindow: 1000000 }, { contextWindow: 128000, maxContextWindow: 0 }]);
  contextCases.push({ route, meta, cached, state: plain(ctx.resolveRouteContextState(route, meta, () => cached)) });
}

const textCases = [];
for (const v of [...EFFORTS, 'Auto', 'MIN', '\ufeffhigh', ' none ', {}, true]) {
  textCases.push({ kind: 'effort', input: v === undefined ? { absent: true } : { value: v }, ...outcome(() => effort.normalizeEffortInput(v)) });
}
for (const v of [...MODELS, undefined, null, 5, 'a b', 'Z', '-a', '~', '~~a', 'ab\u00a0c', 'ab\ufeffc']) {
  textCases.push({ kind: 'rawModelId', input: v === undefined ? { absent: true } : { value: v }, ...outcome(() => helpers.isLikelyRawModelId(v)) });
}
const selectorConfig = { presets: [{ id: 'Main', name: 'Quick one', provider: 'openai', model: 'gpt-5' }] };
for (const v of ['Main', 'quick one', 'free text here', 'gpt-5', '', undefined, '  ']) {
  textCases.push({ kind: 'selector', config: selectorConfig, input: v === undefined ? { absent: true } : { value: v }, ...outcome(() => helpers.validateRequestedModelSelector(selectorConfig, v === undefined ? {} : { model: v })) });
}

// requiredModelSelection (desktop IPC validation): what route/set accepts.
const { requiredModelSelection } = await importFrom(tree, 'apps/desktop/src/main/ipc-validation.ts');
const leaf = () => {
  const r = {};
  maybe(r, 'provider', [' openai ', 'anthropic', '', 5, undefined, 'p'.repeat(257)]);
  maybe(r, 'model', [' gpt-5 ', '', 'm'.repeat(513), 7, undefined]);
  maybe(r, 'effort', [undefined, 'high', '', 5, 'e'.repeat(65)]);
  maybe(r, 'fast', [undefined, true, 'x']);
  maybe(r, 'autoEffort', [undefined, false, 0]);
  maybe(r, 'modelParameters', [undefined, { a: 'b' }, { '': 'x' }, { a: 1 }, [], null]);
  maybe(r, 'contextPercent', [undefined, 10, 30, 35, 5, 110, '30', 100.0]);
  maybe(r, 'contextTokens', [undefined, 1, 0, 1.5, 9007199254740992, 'x']);
  maybe(r, 'onlyIfEmpty', [undefined, true, false, 'x']);
  if (chance(0.05)) r.extra = 1;
  return r;
};
const selectionCases = [];
for (let i = 0; i < 400; i += 1) {
  let input = leaf();
  if (chance(0.3)) input.fallbacks = pick([[leaf()], [leaf(), leaf()], [], null, 'x', Array.from({ length: 17 }, leaf), [{ ...leaf(), fallbacks: [] }], [null]]);
  if (chance(0.03)) input = pick([null, [], 'x', 5]);
  selectionCases.push({ input, ...outcome(() => plain(requiredModelSelection(structuredClone(input)))) });
}

// persistLeadRoute (boot/providers.mjs) and tunesNonMainModel (route-persist.mjs).
const { createRoutePersistence } = await importFrom(tree, 'src/session-runtime/model-route/route-persist.mjs');
const leadCases = [];
for (let i = 0; i < 300; i += 1) {
  const config = randomConfig();
  const route = { ...routeLeaf(), ...(chance(0.7) ? { provider: pick(KNOWN), model: pick(['gpt-5', 'claude-opus']) } : {}) };
  if (chance(0.3)) route.fallbacks = [{ provider: pick(KNOWN), model: 'fb' }];
  const known = KNOWN;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const live = chance(0.5) ? resolveRoute(config, {}) : { provider: pick(KNOWN), model: pick(['gpt-5', 'claude-opus']) };
  const keepMainModel = pick([undefined, true, false]);
  const onlyIfAbsent = chance(0.3);
  let current = structuredClone(config);
  const saves = [];
  const persist = createRoutePersistence({
    getConfig: () => current,
    getRoute: () => live,
    resolveRoute,
    saveConfigAndAdopt: (next) => { current = structuredClone(next); saves.push(plain(next)); },
    persistLeadRoute: (routeLike) => {
      const lead = workflow.normalizeWorkflowRoute(routeLike);
      if (!lead) return null;
      const next = { ...current };
      next.presets = workflow.upsertWorkflowPreset(next.presets, 'lead', lead);
      next.default = workflow.workflowPresetId('lead');
      current = structuredClone(next);
      saves.push(plain(next));
      return lead;
    },
  });
  leadCases.push({ config, route: plain(route), live: plain(live), keepMainModel: keepMainModel ?? null, onlyIfAbsent, known, ...outcome(() => ({ lead: plain(persist.persistAdoptedModelSettings(structuredClone(route), { keepMainModel, onlyIfAbsent })), config: plain(current), saves })) });
}

// resolveChainEntry (workflow-agents-api/agent-route.mjs): the one normalizer of a chain entry.
const { resolveChainEntry } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/agent-route.mjs');
const METAS = [
  null,
  { id: 'gpt-5', provider: 'openai' },
  { id: 'gpt-5', provider: 'openai', supportsFastMode: true, contextWindow: 272000, maxContextWindow: 1000000 },
  { id: 'gpt-5', provider: 'openai', supportsFastMode: false, contextWindow: 200000 },
  { id: 'claude-opus', provider: 'anthropic', supportsFastMode: true, contextWindow: 1000000, maxContextWindow: 1000000 },
  { id: 'x', provider: 'gemini', contextWindow: 400000, maxContextWindow: 800000, supportsFastMode: true },
];
const chainCases = [];
for (let i = 0; i < 400; i += 1) {
  const config = randomConfig();
  const requested = {};
  maybe(requested, 'provider', [pick(KNOWN), pick(KNOWN), undefined, ' openai ']);
  maybe(requested, 'model', ['gpt-5', 'claude-opus', ' gemini-2.5-pro ', undefined]);
  maybe(requested, 'effort', EFFORTS);
  maybe(requested, 'fast', [undefined, true, false]);
  maybe(requested, 'autoEffort', [undefined, true, false]);
  maybe(requested, 'modelParameters', PARAMS);
  maybe(requested, 'contextPercent', PERCENT);
  maybe(requested, 'contextTokens', TOKENS);
  const stored = chance(0.7) ? { ...routeLeaf(), ...(chance(0.6) ? { provider: pick(KNOWN), model: pick(['gpt-5', 'claude-opus']) } : {}) } : {};
  if (chance(0.5)) stored.fast = true;
  if (chance(0.4)) stored.contextPercent = pick([30, 60]);
  if (chance(0.4)) stored.contextTokens = pick([150000, 500000]);
  const meta = pick(METAS);
  const known = KNOWN;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const fastByProvider = Object.fromEntries(KNOWN.map((p) => [p, caps.fastCapableFor(p, meta)]));
  let result;
  try {
    const value = await resolveChainEntry(
      { getConfig: () => structuredClone(config), resolveRoute, lookupModelMeta: async () => structuredClone(meta), ensureProvidersReady: async () => {} },
      structuredClone(requested),
      structuredClone(stored)
    );
    result = { value: plain(value) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  chainCases.push({ config, requested, stored, meta, known, fastByProvider, ...result });
}

// setRoute (model-route/set-route.mjs) and setFast (route-tuning.mjs) over fake runtime state:
// an unaddressed selection with no session, so the follow step only returns the live route
// (the session side is the core's SessionRoutes). The refresh of the effort is a stub both
// sides share: effectiveEffort = effort || null.
const { createSetRoute } = await importFrom(tree, 'src/session-runtime/model-route/set-route.mjs');
const { createRouteTuning } = await importFrom(tree, 'src/session-runtime/model-route/route-tuning.mjs');
const { getModelMetadataSync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-catalog.mjs');
const SERVICE_MODELS = ['gpt-5', 'claude-opus', 'gemini-2.5-pro'];
const knowsTable = {};
for (const p of KNOWN) for (const m of SERVICE_MODELS) knowsTable[`${p}\n${m}`] = Boolean(getModelMetadataSync(m, p));

function serviceRig(config, liveSeed, meta, known) {
  const rt = { config: structuredClone(config), route: liveSeed ? structuredClone(liveSeed) : {} };
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const log = { saves: [], ensured: [], statusline: 0 };
  const persistLeadRoute = (routeLike, { onlyIfAbsent = false } = {}) => {
    const lead = workflow.normalizeWorkflowRoute(routeLike);
    if (!lead) return null;
    const next = { ...rt.config };
    next.presets = workflow.upsertWorkflowPreset(next.presets, 'lead', lead);
    next.default = workflow.workflowPresetId('lead');
    rt.config = structuredClone(next);
    log.saves.push({ leadFill: onlyIfAbsent, config: plain(next) });
    return lead;
  };
  const deps = {
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    getSession: () => null,
    getSessionGeneration: () => 0,
    setRouteState: (route) => { rt.route = route; },
    resolveRoute,
    ensureProvidersReady: async (providers) => { log.ensured.push(plain(providers)); },
    lookupModelMeta: async () => structuredClone(meta),
    refreshRouteEffort: async (_meta, expected, _signal, lease) => {
      const target = expected || rt.route;
      if (lease && !lease.valid()) return null;
      rt.route = { ...target, effectiveEffort: target.effort || null };
      return rt.route;
    },
    refreshStatuslineUsageSnapshot: () => { log.statusline += 1; },
    invalidateContextStatusCache: () => {},
    reloadFullConfig: () => {},
    confirmLeadFill: async () => false,
  };
  const persist = createRoutePersistence({
    ...deps,
    cfgMod: { loadConfig: () => ({}) },
    getConfigHasSecrets: () => true,
    adoptConfig: (next) => { rt.config = next; return next; },
    saveConfigAndAdopt: (next, opts = {}) => { rt.config = structuredClone(next); log.saves.push({ leadFill: opts.leadFill === true, config: plain(next) }); },
    persistLeadRoute,
  });
  return { rt, deps, persist, log };
}

const serviceCases = [];
for (let i = 0; i < 300; i += 1) {
  const config = randomConfig();
  const known = KNOWN;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  let live = null;
  if (chance(0.6)) {
    live = { ...(helpers.makeResolveRoute ? resolveRoute(config, {}) : {}), effectiveEffort: null };
  }
  const next = {};
  maybe(next, 'provider', [pick(KNOWN), pick(KNOWN), undefined, ' openai ']);
  maybe(next, 'model', [pick(SERVICE_MODELS), pick(SERVICE_MODELS), ' gemini-2.5-pro ', undefined, 'unknownmodel']);
  maybe(next, 'effort', EFFORTS);
  maybe(next, 'fast', [undefined, true, false]);
  maybe(next, 'autoEffort', [undefined, true, false]);
  maybe(next, 'modelParameters', PARAMS);
  maybe(next, 'contextPercent', PERCENT);
  maybe(next, 'contextTokens', TOKENS);
  if (chance(0.15)) next.fallbacks = pick([[{ provider: pick(KNOWN), model: 'fb' }], [], [{ provider: pick(KNOWN), model: 'fb' }, { provider: pick(KNOWN), model: 'fc' }]]);
  const options = {};
  if (chance(0.6)) options.keepMainModel = pick([true, false]);
  if (chance(0.2)) options.onlyIfEmpty = true;
  if (chance(0.15)) options.sessionOnly = true;
  const meta = pick(METAS);
  const rig = serviceRig(config, live, meta, known);
  const setRoute = createSetRoute(rig.deps, rig.persist);
  const fastByProvider = Object.fromEntries(KNOWN.map((p) => [p, caps.fastCapableFor(p, meta)]));
  let result;
  try {
    result = { value: plain(await setRoute(structuredClone(next), structuredClone(options))) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  serviceCases.push({ config, live: plain(live), next, options, meta, known, fastByProvider, knows: knowsTable, ...result, after: { config: plain(rig.rt.config), route: plain(rig.rt.route), saves: rig.log.saves, ensured: rig.log.ensured, statusline: rig.log.statusline } });
}

const fastCases = [];
for (let i = 0; i < 250; i += 1) {
  const config = randomConfig();
  const known = KNOWN;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const live = chance(0.9) ? { ...resolveRoute(config, {}), effectiveEffort: pick([null, 'low', 'high']) } : null;
  const value = pick([true, false, 'ultrafast', undefined, 'x']);
  const meta = pick(METAS);
  const rig = serviceRig(config, live, meta, known);
  const tuning = createRouteTuning(rig.deps, rig.persist);
  const oracleProviders = [...new Set([...PROVIDERS, ...KNOWN].map((p) => p.trim()))];
  const fastByProvider = Object.fromEntries(oracleProviders.map((p) => [p, caps.fastCapableFor(p, meta)]));
  const ultraByProvider = Object.fromEntries(oracleProviders.map((p) => [p, caps.ultrafastCapableFor(p, meta)]));
  let result;
  try {
    result = { value: await tuning.setFast(value) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  fastCases.push({ config, live: plain(live), arg: value === undefined ? { absent: true } : { value }, meta, known, fastByProvider, ultraByProvider, ...result, after: { config: plain(rig.rt.config), route: plain(rig.rt.route), saves: rig.log.saves, ensured: rig.log.ensured } });
}

// setAgentRoute (workflow-agents-api/agent-route.mjs) for agents routed in the config file: the
// store behind it (AgentRoutes) is faked as "config.agents[id] + the disabled list", and the
// agent id helpers (agentEditorId, isHiddenAgent) are recorded as oracles.
const { createAgentRouteApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/agent-route.mjs');
const { agentEditorId } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/shared.mjs');
const { isHiddenAgent } = await importFrom(tree, 'src/runtime/agent/orchestrator/internal-agents.mjs');
const { isAgentDisabled } = await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');
const { subscribeAgentRouteChanges } = await importFrom(tree, 'src/session-runtime/agent-profile-changes.mjs');
const AGENT_IDS = ['worker', 'reviewer', 'custom-x', 'explore', 'Worker', 'my agent', '', '   ', 'cycle', 'heavy-worker', 'maintainer', 'explore-agent', 'cycle1-agent', 'title-agent', 'Maint', 'memory', 'a.b_c', '-bad'];
const agentRouteFromConfig = (cfg, id) => {
  const r = cfg.agents?.[id];
  return r && String(r.provider || '').trim() && String(r.model || '').trim() ? structuredClone(r) : null;
};
const agentCases = [];
for (let i = 0; i < 400; i += 1) {
  const config = randomConfig();
  const agentId = pick(AGENT_IDS);
  const id = agentEditorId(agentId);
  if (id && chance(0.55)) {
    config.agents = { ...(config.agents || {}), [id]: { provider: pick(KNOWN), model: pick(SERVICE_MODELS), ...(chance(0.5) ? { effort: pick(['low', 'high']) } : {}), ...(chance(0.3) ? { fast: true } : {}), ...(chance(0.3) ? { fallbacks: [{ provider: pick(KNOWN), model: 'fb' }] } : {}) } };
  }
  if (id && chance(0.35)) config.disabledAgents = [id];
  const next = {};
  maybe(next, 'provider', [pick(KNOWN), pick(KNOWN), '', ' openai ', undefined, undefined]);
  maybe(next, 'model', [pick(SERVICE_MODELS), pick(SERVICE_MODELS), '', undefined, undefined]);
  maybe(next, 'effort', EFFORTS);
  maybe(next, 'fast', [undefined, true, false]);
  maybe(next, 'autoEffort', [undefined, true, false]);
  maybe(next, 'modelParameters', PARAMS);
  maybe(next, 'contextPercent', PERCENT);
  maybe(next, 'contextTokens', TOKENS);
  maybe(next, 'disabled', [undefined, undefined, true, false]);
  maybe(next, 'onlyIfEmpty', [undefined, true, true, false]);
  if (chance(0.2)) next.fallbacks = pick([[{ provider: pick(KNOWN), model: 'fb' }], [], [{ provider: pick(KNOWN), model: 'fb' }, { provider: pick(KNOWN), model: 'fc' }]]);
  const request = JSON.parse(JSON.stringify(next));
  const meta = pick(METAS);
  const known = KNOWN;
  const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => known.includes(String(p || '').trim())));
  const rt = { config: structuredClone(config) };
  const log = { saves: 0, reloads: 0, ensured: [] };
  const published = [];
  const sub = subscribeAgentRouteChanges((agent, route) => { published.push({ id: agent, route: plain(route) }); });
  const api = createAgentRouteApi({
    getConfig: () => rt.config,
    resolveRoute,
    saveConfigAndAdopt: (nextConfig) => { rt.config = structuredClone(nextConfig); log.saves += 1; },
    agentRouteFromConfig,
    ensureProvidersReady: async (providers) => { log.ensured.push(plain(providers)); },
    lookupModelMeta: async () => structuredClone(meta),
    reloadFullConfig: () => { log.reloads += 1; },
  });
  const fastByProvider = Object.fromEntries(KNOWN.map((p) => [p, caps.fastCapableFor(p, meta)]));
  const own0 = id ? plain(agentRouteFromConfig(config, id)) : null;
  let result;
  try {
    result = { value: plain(await api.setAgentRoute(agentId, structuredClone(request))) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  sub.unsubscribe();
  agentCases.push({
    config, agentId, request, meta, known, fastByProvider,
    oracle: { editorId: id || '', hidden: Boolean(id && isHiddenAgent(id)), disabled0: id ? isAgentDisabled(config, id) : false },
    ...result,
    after: { own: id ? plain(agentRouteFromConfig(rt.config, id)) : null, disabled: id ? isAgentDisabled(rt.config, id) : false, config: plain(rt.config), saves: log.saves, reloads: log.reloads, ensured: log.ensured, published },
    own0,
  });
}

// refreshRouteEffort (route-resolution.mjs): the effort, Fast, context and display fields of the
// live route. The effort ladders (coerceEffortFor, effortItemsFor) and fastCapableFor are recorded
// per case as the facts the Rust function is given; Rust computes everything around them.
const { createRouteResolution } = await importFrom(tree, 'src/session-runtime/route-resolution.mjs');
const effortMod = await importFrom(tree, `${rc}effort.mjs`);
const REFRESH_METAS = [
  ...METAS,
  { id: 'gpt-5', provider: 'openai', name: 'GPT 5', reasoningLevels: ['low', 'high'], contextWindow: 272000, maxContextWindow: 1000000 },
  { id: 'gpt-5', provider: 'openai', name: 'gpt-5', display: 'GPT Five', contextWindow: 400000 },
  { id: 'x', provider: 'gemini', displayName: 'Gem', reasoningLevels: ['minimal', 'medium'], maxContextWindow: 800000 },
  { id: 'claude-opus', provider: 'anthropic', name: 'Opus', supportsFastMode: true, contextWindow: 200000, maxContextWindow: 1000000, modelParameterOptions: [{ id: 'context', options: [{ value: '1m', contextWindow: 1000000 }, { value: '200k', contextWindow: 200000 }] }] },
];
const refreshCases = [];
for (let i = 0; i < 400; i += 1) {
  const config = randomConfig();
  const route = { ...routeLeaf(), provider: pick(KNOWN), model: pick(['gpt-5', 'claude-opus', 'x']) };
  if (chance(0.4)) route.effectiveEffort = pick(['low', 'high']);
  if (chance(0.4)) route.modelDisplay = pick(['Old Name', '']);
  if (chance(0.4)) route.modelParameters = pick([{ context: '1m' }, { context: '200k' }, { context: ' 1m ' }, { serviceTier: 'priority' }, {}]);
  if (chance(0.3)) route.selectedContextWindow = pick([300000, 0, 'x']);
  if (chance(0.4)) route.fast = pick([true, false]);
  const meta = pick(REFRESH_METAS);
  const useOverride = chance(0.5);
  const rt = { config: structuredClone(config), route: structuredClone(route) };
  const expectedMode = pick(['none', 'same', 'other']);
  const leaseMode = pick(['none', 'none', 'valid', 'ended']);
  const target = expectedMode === 'same' ? rt.route : expectedMode === 'other' ? structuredClone(route) : null;
  const resolution = createRouteResolution({
    rt,
    collectProviderModels: async () => [],
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => structuredClone(meta),
  });
  const lease = leaseMode === 'none' ? null : { valid: () => leaseMode === 'valid' };
  const before = plain(rt.route);
  let result;
  try {
    result = { value: plain(await resolution.refreshRouteEffort(useOverride ? structuredClone(meta) : null, target, null, lease)) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  const provider = route.provider;
  const requested = Object.hasOwn(route, 'effort') ? route.effort : route.preset?.effort || null;
  const resolved = meta && Object.keys(meta).some((k) => k !== 'id' && k !== 'provider');
  const effective = resolved ? effortMod.coerceEffortFor(provider, meta, requested) : requested || null;
  refreshCases.push({
    config, route: before, meta, useOverride, expectedMode, leaseMode,
    ladder: {
      effective: plain(effective),
      items: plain(effortMod.effortItemsFor(provider, meta, effective)),
      fast: Boolean(caps.fastCapableFor(provider, meta, effective, route.modelParameters)),
    },
    ...result,
    after: plain(rt.route),
  });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'route-admin-twin.json'), {
  domain: 'route-admin-twin',
  recorder: 'benchmarks/rust-core/recorders/record-route-admin.mjs',
  resolveCases,
  normalizeCases,
  contextCases,
  textCases,
  selectionCases,
  leadCases,
  chainCases,
  serviceCases,
  fastCases,
  agentCases,
  refreshCases,
});
refreshAdminManifest(outDir, tree);
console.log(`recorded ${resolveCases.length} resolve, ${normalizeCases.length} normalize, ${contextCases.length} context, ${textCases.length} text cases`);
