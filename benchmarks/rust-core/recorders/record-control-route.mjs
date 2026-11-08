#!/usr/bin/env node
// Golden twin of the desktop control session's route (`ensureControlSession`: created before any model is chosen, so its
// runtime route has no model). Node's real code runs: a config adoption (`adoptFullConfig`, config-lifecycle.mjs) calls
// `syncEmptyMainRoute` (lead-route-sync.mjs), which gives a model-less Main route the model the config resolves to; the
// sessionless `setFast` (route-tuning.mjs) then acts on that route. Each entry holds the config, the live route before, the
// route after the sync, and what `setFast(true)` answered (the refusal text names the route's provider/model).
//
//   node benchmarks/rust-core/recorders/record-control-route.mjs --tree <dir>
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
// The Node commit the fixture is recorded from; the manifest names it only when the tree is exactly this commit.
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const rc = 'src/runtime/agent/orchestrator/runtime-core/';
const helpers = await importFrom(tree, `${rc}config-helpers.mjs`);
const caps = await importFrom(tree, `${rc}model-capabilities.mjs`);
const { createModelRouteApi } = await importFrom(tree, 'src/session-runtime/model-route-api.mjs');
const { createLeadRouteSync } = await importFrom(tree, 'src/session-runtime/config-lifecycle/lead-route-sync.mjs');

const KNOWN = ['openai', 'custom-harness'];
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const EMPTY = { provider: 'openai', model: '', preset: null, effort: null, fast: false, autoEffort: true, modelParameters: {} };
const lead = (provider, model) => ({
  presets: [{ id: 'workflow-lead', name: 'WORKFLOW LEAD', type: 'agent', provider, model }],
  default: 'workflow-lead',
});
// Resolved metadata of a model without fast support (placeholder metadata is unknown, which keeps the requested fast).
const bare = { id: 'harness-model', provider: 'custom-harness', name: 'harness-model', supportsFastMode: false, contextWindow: 128000, maxContextWindow: 128000 };
const fastMeta = { id: 'gpt-5', provider: 'openai', name: 'GPT-5', supportsFastMode: true, contextWindow: 400000, maxContextWindow: 400000 };

const scenarios = [
  { label: 'a custom model without fast support, the Main route empty', config: lead('custom-harness', 'harness-model'), live: EMPTY, meta: bare },
  { label: 'a model with fast support, the Main route empty', config: lead('openai', 'gpt-5'), live: EMPTY, meta: fastMeta },
  { label: 'a config that resolves to no model, the Main route empty', config: {}, live: EMPTY, meta: bare },
  {
    label: 'a Main route that already has a model stays',
    config: lead('openai', 'gpt-5'),
    live: { ...EMPTY, provider: 'custom-harness', model: 'harness-model' },
    meta: bare,
  },
  // The control session is created while the config resolves no model, and the model arrives with a later adoption
  // (adoptions: the configs adopted in order, the last is `config`). `syncEmptyMainRoute` runs at every adoption, so the
  // route takes the first model a config brings and keeps it when a later config names another.
  { label: 'a model that arrives with a later config adoption, a custom model without fast support', adoptions: [{}, lead('custom-harness', 'harness-model')], live: EMPTY, meta: bare },
  { label: 'a model that arrives with a later config adoption, a model with fast support', adoptions: [{}, lead('openai', 'gpt-5')], live: EMPTY, meta: fastMeta },
  { label: 'a model A, then a model B: the route keeps A', adoptions: [{}, lead('openai', 'gpt-5'), lead('custom-harness', 'harness-model')], live: EMPTY, meta: fastMeta },
  { label: 'a model A, then a model B: the route keeps A (custom first)', adoptions: [{}, lead('custom-harness', 'harness-model'), lead('openai', 'gpt-5')], live: EMPTY, meta: bare },
];

const resolveRoute = helpers.makeResolveRoute(helpers.makeResolveDefaultProvider((p) => KNOWN.includes(String(p || '').trim())));
const cases = [];
for (const scenario of scenarios) {
  const adoptions = scenario.adoptions ?? [scenario.config];
  const config = adoptions.at(-1);
  const { live, meta } = scenario;
  let adopted = adoptions[0];
  const state = { route: structuredClone(live) };
  const lifecycle = createLeadRouteSync({
    getRoute: () => state.route,
    getConfig: () => adopted,
    setRouteState: (r) => { state.route = r; },
    resolveRoute,
    clean: (v) => String(v ?? '').trim(),
  });
  const api = createModelRouteApi({
    getConfig: () => config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (r) => { state.route = r; },
    getSession: () => null,
    getSessionGeneration: () => 0,
    setSession: () => {},
    cfgMod: { loadConfig: () => config },
    resolveRoute,
    lookupModelMeta: async () => structuredClone(meta),
    ensureProvidersReady: async () => {},
    adoptConfig: (value) => value,
    saveConfigAndAdopt: (next) => next,
    persistLeadRoute: () => null,
    reloadFullConfig: () => config,
    confirmLeadFill: async () => null,
    refreshRouteEffort: async () => {},
    refreshStatuslineUsageSnapshot: () => {},
    invalidateContextStatusCache: () => {},
    statusRoutes: {},
    mgr: {},
  });
  const afterAdoptions = [];
  for (const next of adoptions) {
    adopted = next;
    lifecycle.syncEmptyMainRoute(adopted);
    afterAdoptions.push(plain(state.route));
  }
  const afterSync = afterAdoptions.at(-1);
  let result;
  try {
    result = { value: await api.setFast(true) };
  } catch (error) {
    result = { error: String(error?.message ?? error) };
  }
  cases.push({
    label: scenario.label,
    config,
    live,
    meta,
    fastTable: Object.fromEntries(KNOWN.map((p) => [p, Boolean(caps.fastCapableFor(p, meta, null, {}))])),
    ...(scenario.adoptions ? { adoptions, afterAdoptions } : {}),
    afterSync,
    setFast: result,
    afterSetFast: plain(state.route),
  });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'control-route');
writeJson(join(outDir, 'control-route-twin.json'), {
  domain: 'control-route-twin',
  recorder: 'benchmarks/rust-core/recorders/record-control-route.mjs',
  cases,
});
writeSetManifest(outDir, {
  set: 'control-route',
  recorder: 'benchmarks/rust-core/recorders/record-control-route.mjs',
  command: 'node benchmarks/rust-core/recorders/record-control-route.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
console.log(`recorded ${cases.length} control-route cases (${cases.filter((c) => c.setFast.error).length} refusals)`);
