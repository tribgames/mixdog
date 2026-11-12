#!/usr/bin/env node
// Golden twin of `src/session-runtime/session-lifecycle.test.mjs`: route effort / Fast / context-window resolution
// (`resolveRouteEffortState`, `resolveRouteContextState`, `saveModelSettings` + `selectionFastCapable`,
// `makeResolveRoute`) and session inheritance (`inheritanceFit`, `createLifecycleApi().inheritancePreflight/inheritFrom`).
// The compactor is a scripted endpoint: every call it receives is recorded.
//
//   node benchmarks/rust-core/recorders/record-session-route-state.mjs --tree <dir>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exact as encode, exactArgs as encodeArgs, fromExact } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

// The session store and the provider catalog's roster files live in the plugin data dir: a fixed scratch one, emptied first.
const DATA = join(tmpdir(), 'rec-session-route-state');
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
process.env.MIXDOG_DATA_DIR = DATA;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

// A copy of a value as it is at this moment (later mutation of the original does not reach it), still a plain value:
// `add` encodes the whole case through `exact` once, so a snapshot must not be encoded already.
const exact = (value) => fromExact(encode(value));
const exactArgs = (args) => fromExact(encodeArgs(args));
async function outcome(fn) {
  try {
    return { ok: exact(await fn()) };
  } catch (error) {
    return { error: exact(error) };
  }
}

await runSessionRecorder(import.meta.url, {
  set: 'session-route-state',
  testFile: 'src/session-runtime/session-lifecycle.test.mjs',
  entry: 'Ran the product modules session-lifecycle.mjs (resolveRouteEffortState/resolveRouteContextState), route-state.mjs (selectionFastCapable), model-capabilities.mjs (saveModelSettings with a null path, in memory), config-helpers.mjs (makeResolveRoute), inheritance-fit.mjs and lifecycle-api.mjs (createLifecycleApi with a scripted session store and compactor) with the test file\'s inputs. Did not run createSessionLifecycle (timers: see warmup-schedulers) nor the real compactor (runHandoffCompaction). Cases 27, 49, 74, 149 and 229 also carry `routeSets`: the client\'s `route/set` (createModelRouteApi setRoute with the options routes-write.mjs passes: switchEstablished, deferUntilNextTurn, keepMainModel true) over the real route-resolution.mjs refreshRouteEffort (the provider catalog\'s roster files written to the data dir), the real session store (saveSessionAsync / loadSession on a temp MIXDOG_DATA_DIR) and the config save as the lifecycle writes it (createConfigPatch applied to the file document, as record-route-service.mjs); each records the call\'s inputs, the whole reply as JSON, the session record before and after and the config document after.',
  replay: 'mixdog-core run_host/session_route_state_replay.rs: mixdog_ai::service::admin_route (resolve_route_context_state, save_model_settings, window_meta_of) for cases 10 and 104 directly, and mixdog_core_session::session::inheritance::inheritance_fit over run_host::inheritance_fit::HostInheritanceFit for 255, each result compared whole. Cases 27, 49, 74, 149 and 229 are played through `route/set` (RouteSetService over the real RouteService, SessionRoutes, SessionRouteAdapter, the real thread store created from the recorded session record and the real config file): the whole reply, the whole stored session record and the whole stored config document are compared with `routeSets`. Cases 306 and 372 (inheritFrom) are played through thread/inheritancePreflight, thread/fork and thread/messages/read on a real session directory and compared at what a client observes: the verdict, the answer or refusal text, the heir\'s conversation. Not compared: the compactor calls Node\'s mock counted (budgetTokens, threshold, copy-not-source) — no client sees them; the heir\'s conversation and the refusal text are their observable consequence.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'routeSets session record: the top-level fields of the stored session are compared in key order sorted on both sides (Node\'s loader assembles the record as header fields, messages, then tools; the core\'s thread keeps the order the fields were written); every value, every nested order and the set of fields are compared whole',
    'routeSets reply: the top-level fields are compared in key order sorted on both sides (Node\'s route object keeps the position of a key first set to undefined, such as contextPercent, which JSON key order of the core\'s reply does not reproduce; no client reads key order); every value, nested order and the set of fields are compared whole. The reply is the JSON the client receives (a property Node leaves undefined is absent)',
    'routeSets config document: the file\'s `agent` section, compared whole in recorded order',
    'no value is normalised: every message, route, state and compactor argument is recorded whole; Date.now() is fixed at 1700000000000 for the run (input.clock) because the inheritance record stamps it'],
}, async ({ imp }) => {
  const { makeResolveRoute } = await imp('src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
  const { resolveRouteContextState, resolveRouteEffortState } = await imp('src/session-runtime/session-lifecycle.mjs');
  const { createLifecycleApi } = await imp('src/session-runtime/lifecycle-api.mjs');
  const { inheritanceFit, inheritanceRouteTarget } = await imp('src/session-runtime/inheritance-fit.mjs');
  const { selectionFastCapable } = await imp('src/session-runtime/route-state.mjs');
  const { saveModelSettings } = await imp('src/runtime/agent/orchestrator/runtime-core/model-capabilities.mjs');
  const { createModelRouteApi } = await imp('src/session-runtime/model-route-api.mjs');
  const { createRouteResolution } = await imp('src/session-runtime/route-resolution.mjs');
  const cfgMod = await imp('src/runtime/agent/orchestrator/config.mjs');
  const patchMod = await imp('src/runtime/shared/config-patch.mjs');
  const store = await imp('src/runtime/agent/orchestrator/session/store.mjs');

  const cases = [];
  // Input and result are encoded here, right after the case computed them. `routeSets` (lines driven through `route/set`) are
  // the client's calls: each holds the call's inputs and what Node answered and stored.
  const FIXED_NOW = 1_700_000_000_000; // the inheritance record stamps Date.now(): a recorded input, fixed here
  Date.now = () => FIXED_NOW;
  const add = (name, line, input, result, routeSets) =>
    cases.push({ name, testLine: line, input: encode({ ...input, clock: { 'Date.now()': FIXED_NOW } }), result: encode(result), ...(routeSets ? { routeSets: encode(routeSets) } : {}) });

  // The client's `route/set` (`createRouteWrite.setRoute`, tui/session/session-api/routes-write.mjs) of one session: Node's
  // real setRoute with the options that write passes (switchEstablished + deferUntilNextTurn; keepMainModel true unless named),
  // over the real route resolution (refreshRouteEffort, which reads the provider catalog's cached windows from the data dir's
  // roster files), the real session store and the config as the lifecycle's save writes it (the stored-form patch applied to the
  // file's document, as record-route-service.mjs). Answers the inputs and the whole outcome: the reply as the client's JSON
  // carries it, the session record before and after (store.loadSession) and the config document in the file after.
  const dataDir = process.env.MIXDOG_DATA_DIR;
  let sessions = 0;
  const routeSet = async ({ config, meta, route, windows = {}, defaultProvider = 'cursor-oauth' }) => {
    const SESSION_ID = `sess_route_set_${(sessions += 1)}`;
    const rosters = {};
    for (const [key, row] of Object.entries(windows)) {
      const [provider, model] = key.split('/');
      (rosters[`${provider}-models.json`] ??= []).push({ id: model, ...row });
    }
    for (const [file, models] of Object.entries(rosters)) writeFileSync(join(dataDir, file), JSON.stringify({ models }));
    try {
      const state = { config: structuredClone(config), route: {}, file: structuredClone(config) };
      let baseline = structuredClone(config);
      const session = { id: SESSION_ID, generation: 0, closed: false, provider: 'openai-oauth', model: 'gpt-6-astra', messages: [] };
      await store.saveSessionAsync(structuredClone(session), {});
      const before = exact(store.loadSession(SESSION_ID));
      const resolveRoute = makeResolveRoute(() => defaultProvider);
      const lookupModelMeta = async () => structuredClone(meta);
      const ensureProvidersReady = async () => {};
      const rt = { get route() { return state.route; }, set route(next) { state.route = next; }, get config() { return state.config; } };
      const { refreshRouteEffort } = createRouteResolution({ rt, collectProviderModels: async () => [], ensureProvidersReady, lookupModelMeta });
      const saveConfigAndAdopt = (next) => {
        state.config = next;
        state.file = patchMod.applyConfigPatch(state.file, cfgMod.createConfigPatch(baseline, next));
        baseline = structuredClone(next);
        return next;
      };
      let persisted = Promise.resolve();
      const api = createModelRouteApi({
        getConfig: () => state.config,
        getConfigHasSecrets: () => false,
        getRoute: () => state.route,
        setRouteState: (next) => { state.route = next; },
        getSession: () => session,
        getSessionGeneration: () => 0,
        getAddressedSessionId: () => SESSION_ID,
        setSession: () => {},
        persistSession: (held) => { persisted = store.saveSessionAsync(held, { expectedGeneration: held.generation }); },
        cfgMod: { loadConfig: () => state.config },
        resolveRoute,
        lookupModelMeta,
        ensureProvidersReady,
        adoptConfig: (value) => { state.config = value; return value; },
        saveConfigAndAdopt,
        persistLeadRoute: () => { throw new Error('route/set keeps the main model'); },
        refreshRouteEffort,
        refreshStatuslineUsageSnapshot: () => {},
        invalidateContextStatusCache: () => {},
        statusRoutes: {},
        mgr: {},
      });
      const reply = await api.setRoute(structuredClone(route), { applyToCurrentSession: false, keepMainModel: true, switchEstablished: true, deferUntilNextTurn: true });
      await persisted;
      return {
        input: { config, meta, route, windows, defaultProvider, session: before },
        outcome: { reply: JSON.parse(JSON.stringify(reply)), session: exact(store.loadSession(SESSION_ID)), file: JSON.parse(JSON.stringify(state.file)) },
      };
    } finally {
      for (const file of Object.keys(rosters)) rmSync(join(dataDir, file), { force: true });
    }
  };

  // 1 placeholder metadata keeps a saved Fast setting
  {
    const route = { provider: 'openai-oauth', model: 'gpt-6-astra', effort: 'high', fast: true };
    const baseConfig = { modelSettings: { 'openai-oauth/gpt-6-astra': { effort: 'high', fast: true } } };
    const metas = [
      { id: 'gpt-6-astra', provider: 'openai-oauth' },
      { id: 'gpt-6-astra', provider: 'openai-oauth', serviceTiers: [{ id: 'priority' }] },
      { id: 'gpt-6-astra', provider: 'openai-oauth', serviceTiers: [] },
    ];
    const results = metas.map((meta) => {
      const fastCapable = selectionFastCapable(route.provider, meta, route.effort, {});
      const saved = exact(saveModelSettings(null, route, { fastCapable, baseConfig }).modelSettings['openai-oauth/gpt-6-astra']);
      return { fastCapable, saved };
    });
    add('placeholder-metadata-keeps-saved-fast', 10, { route, baseConfig, metas }, results);
  }

  // 2-4 effort state
  const effort = async (name, line, route, meta) =>
    add(name, line, { route, meta }, resolveRouteEffortState(route, meta), [await routeSet({ config: {}, meta, route })]);
  await effort('cold-metadata-preserves-effort-and-fast', 27,
    { provider: 'cursor-oauth', model: 'kimi-k3', effort: 'high', fast: true }, { id: 'kimi-k3', provider: 'cursor-oauth' });
  await effort('resolved-metadata-is-authoritative', 49,
    { provider: 'cursor-oauth', model: 'kimi-k3', effort: 'max', fast: true },
    { id: 'kimi-k3', provider: 'cursor-oauth', reasoningLevels: ['high'], fastCapable: false, fastEfforts: [] });
  await effort('cursor-parameter-variants-validate-fast', 74,
    { provider: 'cursor-oauth', model: 'gpt-5.6-sol', effort: 'high', fast: true, modelParameters: { context: '272k' } },
    {
      id: 'gpt-5.6-sol', provider: 'cursor-oauth', reasoningLevels: ['high', 'max'], fastCapable: true, fastEfforts: ['high'],
      parameterVariants: [{ effort: 'high', fast: 'true', context: '272k' }, { effort: 'max', fast: 'false', context: '272k' }],
    });

  // 5 context percentage
  {
    const meta = { contextWindow: 200_000, maxContextWindow: 1_000_000 };
    const routes = [{}, { contextPercent: 34 }, { contextPercent: null }];
    add('context-percent-model-default-and-ten-point-steps', 104, { meta, routes }, routes.map((route) => resolveRouteContextState(route, meta)));
  }

  // 6 placeholder meta + catalog window lookup. The lookup is a scripted table; its calls are recorded.
  {
    const table = {
      'anthropic-oauth/claude-opus-5': { contextWindow: 1_000_000, maxContextWindow: 0 },
      'openai-oauth/gpt-5.6-sol': { contextWindow: 272_000, maxContextWindow: 1_000_000 },
    };
    const lookups = [];
    const windowLookup = (provider, model) => { lookups.push([provider, model]); return table[`${provider}/${model}`] ?? null; };
    const opus = { provider: 'anthropic-oauth', model: 'claude-opus-5' };
    const placeholder = (route) => ({ id: route.model, provider: route.provider });
    const inputs = [
      { ...opus, contextPercent: 50 },
      opus,
      { ...opus, contextPercent: 100 },
      { provider: 'openai-oauth', model: 'gpt-5.6-sol', contextPercent: 30 },
      { provider: 'anthropic-oauth', model: 'unknown-model', contextPercent: 50 },
    ];
    const results = inputs.map((route) => {
      const before = lookups.length;
      const state = exact(resolveRouteContextState(route, placeholder(route), windowLookup));
      return { route, meta: placeholder(route), state, lookups: lookups.slice(before) };
    });
    const routeSets = [];
    for (const route of inputs) routeSets.push(await routeSet({ config: {}, meta: placeholder(route), route, windows: table }));
    add('placeholder-model-meta-resolves-selected-window-from-catalog', 149, { table }, results, routeSets);
  }

  // 7 cleared context percentage
  {
    const resolveRoute = makeResolveRoute(() => 'cursor-oauth');
    const config = { modelSettings: { 'cursor-oauth/gpt-5.4': { contextPercent: null } } };
    const route = { provider: 'cursor-oauth', model: 'gpt-5.4' };
    add('cleared-context-percent-is-model-default-intent', 229, { config, route, defaultProvider: 'cursor-oauth' }, resolveRoute(config, route).contextPercent,
      [await routeSet({ config, meta: {}, route, defaultProvider: 'cursor-oauth' })]);
  }

  // inheritance
  const CONVERSATION = [
    { role: 'system', content: 'source instructions' },
    { role: 'user', content: 'carry this conversation '.repeat(6000) },
    { role: 'assistant', content: 'understood '.repeat(200) },
  ];

  {
    const heir = (overrides = {}) => ({
      provider: 'openai-oauth', model: 'gpt-6-astra', contextWindow: 500_000, compactBoundaryTokens: 500_000,
      compaction: { auto: true }, tools: [], ...overrides,
    });
    const variants = [
      ['roomy', heir()],
      ['anthropic-heir', heir({ provider: 'anthropic-oauth', model: 'claude-opus-5' })],
      ['tight-heir', heir({ contextWindow: 10_000, compactBoundaryTokens: 10_000 })],
      ['unmeasurable-route', { provider: 'openai-oauth', model: 'gpt-6-astra' }],
    ];
    add('inheritance-fit-is-judged-on-the-heir-route', 255, { conversation: CONVERSATION, variants },
      variants.map(([label, route]) => ({ label, fit: exact(inheritanceFit(CONVERSATION, route)) })));
  }

  const source = () => ({ id: 'source', provider: 'openai-oauth', model: 'gpt-6-astra', messages: CONVERSATION });
  const open = (src, selectedContextWindow, compactConversation) => {
    const route = { provider: 'anthropic-oauth', model: 'claude-opus-5', selectedContextWindow };
    const target = { id: 'heir', messages: [], ...inheritanceRouteTarget(route) };
    const saves = [];
    const api = createLifecycleApi({
      getSession: () => target,
      getRoute: () => route,
      mgr: { getSession: (id) => (id === src.id ? src : null) },
      invalidateContextStatusCache() {},
      saveSession(...args) { saves.push(exactArgs(args)); },
      ...(compactConversation ? { compactConversation } : {}),
    });
    return { api, target, route, saves };
  };
  const shape = (target) => ({ target: exact(target) });

  // The scripted compactor's answers (recorded as inputs): what it returns for each scenario that compacts.
  const COMPACTOR_ANSWERS = {
    compacting: { messages: [{ role: 'user', content: 'Compacted for the heir.' }] },
    compact: { messages: [{ role: 'user', content: 'Summarized on request.' }] },
  };

  // 9 preflight is the same verdict the carry reaches
  {
    const out = {};
    {
      const src = source();
      const calls = [];
      const h = open(src, 20_000, async ({ budgetTokens, session }) => {
        calls.push({ budgetTokens, isSource: session === src, session: exact(session) });
        return structuredClone(COMPACTOR_ANSWERS.compacting);
      });
      const fit = exact(h.api.inheritancePreflight(src.id, h.route));
      out.compacting = { fit, inherit: await outcome(() => h.api.inheritFrom(src.id)), calls, ...shape(h.target), saves: h.saves };
    }
    {
      const src = source();
      const calls = [];
      const h = open(src, 20_000, async (args) => { calls.push(exact(args)); return { messages: [] }; });
      const fit = exact(h.api.inheritancePreflight(src.id, h.route));
      out.emptyCompaction = { fit, first: await outcome(() => h.api.inheritFrom(src.id)), second: await outcome(() => h.api.inheritFrom(src.id)), calls, ...shape(h.target), saves: h.saves };
    }
    {
      const src = source();
      const h = open(src, 500_000);
      const fit = exact(h.api.inheritancePreflight(src.id, h.route));
      out.accepted = { fit, inherit: await outcome(() => h.api.inheritFrom(src.id)), ...shape(h.target), saves: h.saves };
    }
    add('inheritance-preflight-is-the-verdict-the-carry-reaches', 306, { conversation: CONVERSATION, heirRoute: { provider: 'anthropic-oauth', model: 'claude-opus-5' }, windows: [20_000, 20_000, 500_000], compactorAnswers: { compacting: COMPACTOR_ANSWERS.compacting, emptyCompaction: { messages: [] } } }, out);
  }

  // 10 compact:true
  {
    const out = {};
    {
      const src = source();
      const calls = [];
      const h = open(src, 500_000, async ({ session }) => {
        calls.push({ session: exact(session), isSource: session === src });
        return structuredClone(COMPACTOR_ANSWERS.compact);
      });
      out.preflight = exact(h.api.inheritancePreflight(src.id, h.route));
      out.compact = { inherit: await outcome(() => h.api.inheritFrom(src.id, { compact: true })), calls, sourceCompaction: exact(src.compaction), ...shape(h.target) };
    }
    out.default = [];
    for (const args of [[], [{ compact: false }]]) {
      const src = source();
      let calls = 0;
      const h = open(src, 500_000, async () => { calls += 1; return { messages: [] }; });
      const inherit = await outcome(() => h.api.inheritFrom(src.id, ...args));
      out.default.push({ args: exactArgs(args), inherit, calls, expectedMessages: exact(h.api.inheritancePreflight(src.id, h.route).messages), ...shape(h.target) });
    }
    {
      const src = source();
      const h = open(src, 500_000, async () => { throw new Error('compactor down'); });
      out.failing = { inherit: await outcome(() => h.api.inheritFrom(src.id, { compact: true })), ...shape(h.target) };
    }
    {
      const src = source();
      const h = open(src, 500_000, async () => ({ messages: [] }));
      out.empty = { inherit: await outcome(() => h.api.inheritFrom(src.id, { compact: true })), ...shape(h.target) };
    }
    add('compact-true-compacts-a-conversation-that-fits', 372, { conversation: CONVERSATION, window: 500_000, compactor: { compact: 'returns one user message', failing: 'throws Error(compactor down)', empty: 'returns no messages' }, compactorAnswers: { compact: COMPACTOR_ANSWERS.compact, empty: { messages: [] } } }, out);
  }

  return { cases };
});
