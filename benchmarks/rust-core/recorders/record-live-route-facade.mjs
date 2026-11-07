#!/usr/bin/env node
// Golden twin of the runtime facade's route getters (session-runtime/runtime-facade.mjs
// `provider`, `model`, `effort`, `fast`, `autoEffort`, `fastCapable`, `modelParameters`,
// `effortOptions`, `contextPercent`, `contextTokens`) over the live route `rt.route`, which Node's
// real `refreshRouteEffort` (route-resolution.mjs) fills from the model row. The refreshed route is
// recorded as the cell Rust reads (Rust `refresh_route_effort` fills it from the same catalog
// facts, its own twin), then the getters and the `model` status Node's setup executor prints from
// them. Rust `SessionLiveRoute::route` reads the facade properties off that cell and must give
// the same object.
//
//   node benchmarks/rust-core/recorders/record-live-route-facade.mjs [--tree <dir>]
//
// Output: native/core/fixtures/live-route-facade/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'live-route-facade-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'live-route-facade');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-live-route-facade.mjs';
const { createRouteResolution } = await importFrom(tree, 'src/session-runtime/route-resolution.mjs');
const { createRuntimeFacade } = await importFrom(tree, 'src/session-runtime/runtime-facade.mjs');
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const GPT = { id: 'gpt-5', provider: 'openai', name: 'GPT 5', reasoningLevels: ['low', 'high'], contextWindow: 272000, maxContextWindow: 1000000 };
const OPUS = {
  id: 'claude-opus', provider: 'anthropic', name: 'Opus', supportsFastMode: true, contextWindow: 200000, maxContextWindow: 1000000,
  modelParameterOptions: [{ id: 'context', options: [{ value: '1m', contextWindow: 1000000 }, { value: '200k', contextWindow: 200000 }] }],
};
const GEM = { id: 'x', provider: 'gemini', displayName: 'Gem', reasoningLevels: ['minimal', 'medium'], maxContextWindow: 800000 };
const COLD = { id: 'gpt-5', provider: 'openai' };

const SCENARIOS = [
  ['a resolved route with an effort', { provider: 'openai', model: 'gpt-5', effort: 'high' }, GPT],
  ['an effort the model does not take', { provider: 'openai', model: 'gpt-5', effort: 'ultra' }, GPT],
  ['Fast on a fast-capable model', { provider: 'anthropic', model: 'claude-opus', effort: 'low', fast: true }, OPUS],
  ['Fast requested on a model without it', { provider: 'openai', model: 'gpt-5', fast: true }, GPT],
  ['a context selection', { provider: 'anthropic', model: 'claude-opus', modelParameters: { context: '1m' } }, OPUS],
  ['Auto effort off', { provider: 'openai', model: 'gpt-5', effort: 'low', autoEffort: false }, GPT],
  ['a preset effort', { provider: 'openai', model: 'gpt-5', preset: { effort: 'high' } }, GPT],
  ['a picker context share', { provider: 'gemini', model: 'x', contextPercent: 40 }, GEM],
  ['exact context tokens', { provider: 'openai', model: 'gpt-5', contextTokens: 123456 }, GPT],
  ['a cold catalog row keeps the requested route', { provider: 'openai', model: 'gpt-5', effort: 'high', fast: true }, COLD],
  ['no effort at all', { provider: 'gemini', model: 'x' }, GEM],
];

const cases = [];
async function record(name, requested, meta, { refresh = true, session = null } = {}) {
  const rt = { config: {}, route: structuredClone(requested) };
  if (refresh) {
    const resolution = createRouteResolution({
      rt,
      collectProviderModels: async () => [],
      ensureProvidersReady: async () => {},
      lookupModelMeta: async () => structuredClone(meta),
    });
    await resolution.refreshRouteEffort(null, null, null, null);
  }
  const state = { route: rt.route, session };
  const facade = createRuntimeFacade({
    state, leadingApi: {}, goalApi: {}, trailingApi: {}, deliverToolCompletion: () => false, reserveSessionId: () => {},
    getAutoClear: () => null, getSystemShell: () => null, getWebSearchRoute: () => null, getWorkflow: () => null,
    getOrchestrationMode: () => 'none', getOutputStyle: () => null, getContextStatus: () => null, renameSessionTitle: () => {},
  });
  // The facade's getters, in the order Rust prints them.
  const properties = {};
  for (const key of ['provider', 'model', 'effort', 'fast', 'autoEffort', 'fastCapable', 'modelParameters', 'effortOptions', 'contextPercent', 'contextTokens']) {
    properties[key] = facade[key];
  }
  const executor = createSetupToolExecutor({ getApi: () => facade, getConfig: () => ({}), getSessionId: () => null });
  const status = JSON.parse(await executor.execute({ action: 'status', domain: 'model' }, {}));
  cases.push({
    name, requested: plain(requested), meta: plain(meta), refreshed: refresh, session: plain(session),
    route: plain(rt.route), facade: plain(properties), model: plain({ route: status.route, effortOptions: status.effortOptions }),
  });
}

for (const [name, requested, meta] of SCENARIOS) {
  await record(name, requested, meta);
  await record(`${name}, not refreshed`, requested, meta, { refresh: false });
}
await record('a session context share behind an empty route share', { provider: 'openai', model: 'gpt-5' }, GPT, { refresh: false, session: { contextPercent: 55 } });
await record('a route share wins over the session', { provider: 'openai', model: 'gpt-5', contextPercent: 30 }, GPT, { refresh: false, session: { contextPercent: 55 } });
await record('an empty route', {}, null, { refresh: false });

writeJson(join(stage, 'golden.json'), { domain: 'live-route-facade', recorder, cases });
writeSetManifest(stage, {
  set: 'live-route-facade',
  recorder,
  command: 'node benchmarks/rust-core/recorders/record-live-route-facade.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} live-route facade cases`);