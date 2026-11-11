#!/usr/bin/env node
// Golden twin of `src/session-runtime/session-lifecycle.test.mjs`: route effort / Fast / context-window resolution
// (`resolveRouteEffortState`, `resolveRouteContextState`, `saveModelSettings` + `selectionFastCapable`,
// `makeResolveRoute`) and session inheritance (`inheritanceFit`, `createLifecycleApi().inheritancePreflight/inheritFrom`).
// The compactor is a scripted endpoint: every call it receives is recorded.
//
//   node benchmarks/rust-core/recorders/record-session-route-state.mjs --tree <dir>
import { exact as encode, exactArgs as encodeArgs, fromExact } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

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
  entry: 'Ran the product modules session-lifecycle.mjs (resolveRouteEffortState/resolveRouteContextState), route-state.mjs (selectionFastCapable), model-capabilities.mjs (saveModelSettings with a null path, in memory), config-helpers.mjs (makeResolveRoute), inheritance-fit.mjs and lifecycle-api.mjs (createLifecycleApi with a scripted session store and compactor) with the test file\'s inputs. Did not run createSessionLifecycle (timers: see warmup-schedulers) nor the real compactor (runHandoffCompaction).',
  replay: 'mixdog-core run_host/session_route_state_replay.rs: mixdog_ai::service::admin_route (resolve_route_effort_state, resolve_route_context_state, selection_fast_capable, save_model_settings, resolve_route, window_meta_of) for cases 10, 27, 49, 74, 104, 149, 229, and mixdog_core_session::session::inheritance::inheritance_fit over run_host::inheritance_fit::HostInheritanceFit for 255, each result compared whole. Cases 306 and 372 (inheritFrom) are played through thread/inheritancePreflight, thread/fork and thread/messages/read on a real session directory and compared at what a client observes: the verdict, the answer or refusal text, the heir\'s conversation. Not compared: the compactor calls Node\'s mock counted (budgetTokens, threshold, copy-not-source) — no client sees them; the heir\'s conversation and the refusal text are their observable consequence.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: ['no value is normalised: every message, route, state and compactor argument is recorded whole; Date.now() is fixed at 1700000000000 for the run (input.clock) because the inheritance record stamps it'],
}, async ({ imp }) => {
  const { makeResolveRoute } = await imp('src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
  const { resolveRouteContextState, resolveRouteEffortState } = await imp('src/session-runtime/session-lifecycle.mjs');
  const { createLifecycleApi } = await imp('src/session-runtime/lifecycle-api.mjs');
  const { inheritanceFit, inheritanceRouteTarget } = await imp('src/session-runtime/inheritance-fit.mjs');
  const { selectionFastCapable } = await imp('src/session-runtime/route-state.mjs');
  const { saveModelSettings } = await imp('src/runtime/agent/orchestrator/runtime-core/model-capabilities.mjs');

  const cases = [];
  // Input and result are encoded here, right after the case computed them.
  const FIXED_NOW = 1_700_000_000_000; // the inheritance record stamps Date.now(): a recorded input, fixed here
  Date.now = () => FIXED_NOW;
  const add = (name, line, input, result) => cases.push({ name, testLine: line, input: encode({ ...input, clock: { 'Date.now()': FIXED_NOW } }), result: encode(result) });

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
  const effort = (name, line, route, meta) => add(name, line, { route, meta }, resolveRouteEffortState(route, meta));
  effort('cold-metadata-preserves-effort-and-fast', 27,
    { provider: 'cursor-oauth', model: 'kimi-k3', effort: 'high', fast: true }, { id: 'kimi-k3', provider: 'cursor-oauth' });
  effort('resolved-metadata-is-authoritative', 49,
    { provider: 'cursor-oauth', model: 'kimi-k3', effort: 'max', fast: true },
    { id: 'kimi-k3', provider: 'cursor-oauth', reasoningLevels: ['high'], fastCapable: false, fastEfforts: [] });
  effort('cursor-parameter-variants-validate-fast', 74,
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
    add('placeholder-model-meta-resolves-selected-window-from-catalog', 149, { table }, results);
  }

  // 7 cleared context percentage
  {
    const resolveRoute = makeResolveRoute(() => 'cursor-oauth');
    const config = { modelSettings: { 'cursor-oauth/gpt-5.4': { contextPercent: null } } };
    const route = { provider: 'cursor-oauth', model: 'gpt-5.4' };
    add('cleared-context-percent-is-model-default-intent', 229, { config, route, defaultProvider: 'cursor-oauth' }, resolveRoute(config, route).contextPercent);
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
