#!/usr/bin/env node
// Records every case of src/runtime/agent/orchestrator/session/compact/summary-mode.test.mjs after its first (:157,
// recorded by record-compact-node-cases.mjs): the cache-warm answers, the lighter model of the saved catalogs, the
// summary route plans and the compactions the test runs, through Node's own `compactionCacheWarm`,
// `lighterSubscriptionModel`, `compactionSummaryPlan`, `runFreshContextCompact` and `captureSideQuestionRequest`, over
// the test's own fake providers (driven here by a JSON reply rule each, so the replay builds the same fakes).
//
//   node benchmarks/rust-core/recorders/record-summary-mode-routing.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/summary-mode-routing/golden.json (+ MANIFEST.json). Each query carries the saved catalog
// files as they stood (their text) and the clock it ran at, so the replay reads the same files at the same moment.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-summary-mode-routing.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const S = 'src/runtime/agent/orchestrator/session';
// The test's preload: every home and data dir under a fresh temp root, no network.
await importFrom(tree, `${S}/loop/test-isolation.mjs`);
const { compactionSummaryPlan, runFreshContextCompact } = await importFrom(tree, `${S}/loop/fresh-context.mjs`);
const { captureSideQuestionRequest, forgetSideQuestion, sideQuestionRequest } = await importFrom(tree, `${S}/side-question-store.mjs`);
const { compactionCacheWarm, lighterSubscriptionModel } = await importFrom(tree, `${S}/compact/summary-route.mjs`);
const { makeModelCache } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/model-cache.mjs');
const { CODEX_MODEL_CACHE_OPTIONS } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-oauth-catalog-store.mjs');

const SAVED_CATALOG = {
  'anthropic-oauth': makeModelCache({ fileName: 'anthropic-oauth-models.json', ttlMs: 24 * 60 * 60_000, version: 2 }),
  'openai-oauth': makeModelCache(CODEX_MODEL_CACHE_OPTIONS),
};
async function saveCatalog(name, models) {
  await SAVED_CATALOG[name].save(models);
}
function clearCatalogs() {
  for (const cache of Object.values(SAVED_CATALOG)) rmSync(cache.path(), { force: true });
}
// The saved catalog files as they stand: file name → text, or null when absent.
function catalogs() {
  return Object.fromEntries(
    Object.values(SAVED_CATALOG).map((cache) => [basename(cache.path()), existsSync(cache.path()) ? readFileSync(cache.path(), 'utf8') : null])
  );
}

const SUMMARY = [
  '## Goal', '- continue the parser refactor', '## Constraints & Preferences', '- (none)', '## Progress', '### Done',
  '- read the parser', '### In Progress', '- refactor', '### Blocked', '- (none)', '## Key Decisions', '- (none)',
  '## Next Steps', '- continue', '## Critical Context', '- (none)', '## Relevant Files', '- parser.mjs',
].join('\n');
const MINUTE = 60_000;
const MAINTAINER = { agents: { maintainer: { provider: 'fixture-maintenance', model: 'maintenance-model' } } };
const HAIKU_ROWS = [
  { id: 'claude-haiku-4-5', family: 'haiku' },
  { id: 'claude-haiku-5-5', family: 'haiku' },
  { id: 'claude-opus-5-7', family: 'opus' },
  { id: 'claude-haiku-5-1', family: 'haiku' },
];
const LUNA_ROWS = [{ id: 'gpt-5.6-luna' }, { id: 'gpt-6-luna' }, { id: 'gpt-6-astra' }, { id: 'gpt-5.5' }];
const OK = { content: SUMMARY };
const status = (code, message = `status ${code}`) => ({ status: code, message });

function conversation() {
  return [
    { role: 'system', content: 'You are the Lead.' },
    ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `TURN_${i} `.padEnd(1_600, '.') })),
    { role: 'user', content: 'Refactor the parser.' },
  ];
}

// A reply of the test's fakes: `{ content }`, or an error with a `status` and/or a `code`.
function answer(reply) {
  if (reply.content !== undefined) return { content: reply.content };
  return Object.assign(new Error(reply.message), reply.status !== undefined ? { status: reply.status } : {}, reply.code !== undefined ? { code: reply.code } : {});
}
// The test's `fakeProvider`, its reply chosen by a JSON rule: `byCall[n]`, else `byModel[model]`, else `reply`.
function fakeProvider(spec) {
  const { name, models = [], info = { contextWindow: 200_000 }, rule = { reply: OK } } = spec;
  const calls = [];
  let listed = 0;
  return {
    name,
    spec: { name, models, info, rule },
    calls,
    get listed() {
      return listed;
    },
    getCachedModelInfo: () => info,
    async listModels() {
      listed += 1;
      return models;
    },
    async send(messages, model, tools, opts) {
      calls.push({ messages, model, tools, opts });
      const reply = rule.byCall?.[calls.length] ?? rule.byModel?.[model] ?? rule.reply;
      const value = answer(reply);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

// The session's saved requests, as the replay rebuilds them: session id → the capture.
const captured = new Map();
function captureMain(sessionId, provider, { ageMs = 0, cacheStrategy = { messages: '5m' } } = {}) {
  forgetSideQuestion(sessionId);
  const handle = captureSideQuestionRequest({
    sessionId,
    sessionRef: { id: sessionId },
    provider,
    model: 'main-model',
    messages: conversation(),
    tools: [],
    opts: { sessionId, cacheStrategy },
  });
  handle.settle({ content: 'ok' });
  const sentAt = Date.now() - ageMs;
  sideQuestionRequest(sessionId).sentAt = sentAt;
  captured.set(sessionId, { provider: provider.spec, cacheStrategy, sentAt });
}
function forgetAll() {
  for (const id of captured.keys()) forgetSideQuestion(id);
  captured.clear();
}

function sessionRef(id, provider, model = 'main-model') {
  return { id, provider: provider.name, model, contextWindow: 200_000, compaction: { conversationThresholdTokens: 1 } };
}
const routeOf = (route) => route && { source: route.source, provider: route.providerName, model: route.model };

const plans = [];
async function plan(test, { sessionId, provider, maintenance, config = {}, model = 'main-model' }) {
  const listedBefore = provider.listed;
  const now = Date.now();
  const summaryPlan = compactionSummaryPlan({
    sessionRef: sessionRef(sessionId, provider, model),
    provider,
    model,
    config,
    initProvidersFn: async () => {},
    getProviderFn: (name) => (name === maintenance?.name ? maintenance : provider),
  });
  let first = null;
  for (const step of summaryPlan.steps) {
    first = await step();
    if (first) break;
  }
  plans.push({
    test,
    sessionId,
    provider: provider.spec,
    maintenance: maintenance?.spec ?? null,
    config,
    model,
    capture: captured.get(sessionId) ?? null,
    catalogs: catalogs(),
    now,
    out: { mode: summaryPlan.mode, warm: summaryPlan.warm, steps: summaryPlan.steps.length, first: routeOf(first), listed: provider.listed - listedBefore },
  });
}

const compacts = [];
async function compact(test, { sessionId, provider, maintenance, config = {}, model = 'main-model', init = null }) {
  const before = { main: provider.calls.length, maintenance: maintenance?.calls.length ?? 0 };
  const controller = init?.abort ? new AbortController() : null;
  const now = Date.now();
  const at = { capture: captured.get(sessionId) ?? null, catalogs: catalogs() };
  let out;
  try {
    const result = await runFreshContextCompact({
      sessionRef: sessionRef(sessionId, provider, model),
      messages: conversation(),
      provider,
      model,
      compactBudgetTokens: 50_000,
      compactPolicy: { contextWindow: 200_000 },
      config,
      signal: controller?.signal,
      initProvidersFn: init
        ? async () => {
            if (init.abort) controller.abort(new Error('turn cancelled'));
            throw answer(init.failure);
          }
        : async () => {},
      getProviderFn: (name) => (name === maintenance?.name ? maintenance : provider),
      sendOpts: {},
    });
    const pipeline = result.diagnostics.pipeline;
    out = {
      ok: {
        summaryModel: result.summaryModel,
        summaryRoute: pipeline.summaryRoute,
        cacheWarm: pipeline.cacheWarm,
        mode: pipeline.generated.mode,
        sharedPrefixFallback: pipeline.generated.sharedPrefixFallback ?? null,
      },
    };
  } catch (error) {
    out = { error: { message: error.message, aborted: controller?.signal.aborted ?? false, compactRoute: error.compactRoute ?? null } };
  }
  // Each send of the case in order: the fork keeps the session id, the isolated request is `<id>:compact`.
  const sends = (fake, from) =>
    fake.calls.slice(from).map((call) => ({ provider: fake.name, model: call.model, kind: call.opts?.sessionId === `${sessionId}:compact` ? 'isolated' : 'fork' }));
  out.calls = [...(maintenance ? sends(maintenance, before.maintenance) : []), ...sends(provider, before.main)];
  compacts.push({ test, sessionId, provider: provider.spec, maintenance: maintenance?.spec ?? null, config, model, init, ...at, now, out });
}

// --- :168 the cache is warm only inside the lifetime the last request used ---------------------------------------
const warm = [];
{
  const query = (name, ageMs, cacheStrategy, options = {}) => {
    const sessionId = `warm-${name}-${ageMs}-${cacheStrategy?.messages}`;
    captureMain(sessionId, fakeProvider({ name, ...options }), { ageMs, cacheStrategy });
    const now = Date.now();
    warm.push({ sessionId, capture: captured.get(sessionId), now, warm: compactionCacheWarm(sessionId) });
  };
  warm.push({ sessionId: 'warm-no-request', capture: null, now: Date.now(), warm: compactionCacheWarm('warm-no-request') });
  query('anthropic-oauth', 4 * MINUTE, { messages: '5m' });
  query('anthropic-oauth', 4.75 * MINUTE, { messages: '5m' });
  query('anthropic', 50 * MINUTE, { messages: '1h' });
  query('anthropic', 56 * MINUTE, { messages: '1h' });
  query('anthropic', 0, { messages: 'none' });
  query('openai', 20 * MINUTE, {});
  query('openai', 28 * MINUTE, {});
  query('openai-oauth', 30 * 24 * 60 * MINUTE, {});
  query('fixture-other', 0, {}, { info: { contextWindow: 200_000 } });
  query('fixture-cached', 3 * MINUTE, {}, { info: { supportsPromptCaching: true } });
  query('fixture-cached', 5 * MINUTE, {}, { info: { supportsPromptCaching: true } });
  forgetAll();
}

// --- :192 the lighter model is the newest of its family in a subscription provider's saved catalog ---------------
const lighter = [];
{
  const query = async (name) => lighter.push({ provider: name, catalogs: catalogs(), now: Date.now(), model: await lighterSubscriptionModel(name) });
  await saveCatalog('anthropic-oauth', HAIKU_ROWS);
  await saveCatalog('openai-oauth', LUNA_ROWS);
  await query('anthropic-oauth');
  await query('openai-oauth');
  for (const name of ['anthropic', 'openai', 'openrouter', 'grok-oauth']) await query(name);
  await saveCatalog('openai-oauth', [{ id: 'gpt-6-luna-2026-09-01' }, { id: 'gpt-6-luna' }]);
  await query('openai-oauth');
  await saveCatalog('anthropic-oauth', [HAIKU_ROWS[2]]);
  await saveCatalog('openai-oauth', [{ id: 'gpt-6-astra' }]);
  await query('anthropic-oauth');
  await query('openai-oauth');
  clearCatalogs();
  await query('anthropic-oauth');
  await query('openai-oauth');
}

// --- :212 the lighter step reads the saved catalog only ----------------------------------------------------------
clearCatalogs();
for (const name of ['anthropic-oauth', 'openai-oauth']) {
  await plan(':212', { sessionId: `saved-only-${name}`, provider: fakeProvider({ name, models: [...HAIKU_ROWS, ...LUNA_ROWS] }) });
}

// --- :222 smart: warm forks on the conversation model; cold tries Maintainer, lighter, then the conversation model
{
  await saveCatalog('anthropic-oauth', HAIKU_ROWS);
  await saveCatalog('openai-oauth', LUNA_ROWS);
  const maintenance = fakeProvider({ name: 'fixture-maintenance' });
  const warmMain = fakeProvider({ name: 'anthropic-oauth', models: HAIKU_ROWS });
  captureMain('smart-warm', warmMain);
  await plan(':222', { sessionId: 'smart-warm', provider: warmMain, maintenance, config: MAINTAINER });
  const coldMain = fakeProvider({ name: 'anthropic-oauth', models: HAIKU_ROWS });
  captureMain('smart-cold', coldMain, { ageMs: 10 * MINUTE });
  await plan(':222', { sessionId: 'smart-cold', provider: coldMain, maintenance, config: MAINTAINER });
  await plan(':222', { sessionId: 'smart-cold', provider: coldMain });
  const codex = fakeProvider({ name: 'openai-oauth', models: LUNA_ROWS });
  await plan(':222', { sessionId: 'smart-codex', provider: codex });
  await plan(':222', { sessionId: 'smart-haiku', provider: coldMain, model: 'claude-haiku-5-5' });
  for (const name of ['anthropic', 'openai', 'openrouter']) {
    await plan(':222', { sessionId: `smart-${name}`, provider: fakeProvider({ name, models: [...HAIKU_ROWS, ...LUNA_ROWS] }) });
  }
  await saveCatalog('openai-oauth', [{ id: 'gpt-6-astra' }]);
  await plan(':222', { sessionId: 'smart-none', provider: fakeProvider({ name: 'openai-oauth' }) });
  clearCatalogs();
  forgetAll();
}

// --- :269 maintainer: the Maintainer warm or cold, else the conversation model; self: always the conversation model
{
  const maintenance = fakeProvider({ name: 'fixture-maintenance' });
  const main = fakeProvider({ name: 'anthropic-oauth', models: HAIKU_ROWS });
  captureMain('mode-warm', main);
  await plan(':269', { sessionId: 'mode-warm', provider: main, maintenance, config: { ...MAINTAINER, compaction: { summaryMode: 'maintainer' } } });
  await plan(':269', { sessionId: 'mode-cold', provider: main, config: { compaction: { summaryMode: 'maintainer' } } });
  for (const sessionId of ['mode-warm', 'mode-cold']) {
    await plan(':269', { sessionId, provider: main, maintenance, config: { ...MAINTAINER, compaction: { summaryMode: 'self' } } });
  }
  forgetAll();
}

// --- :294 cold smart: a Maintainer out of quota falls to the lighter model, an unavailable one to the conversation's
{
  await saveCatalog('anthropic-oauth', HAIKU_ROWS);
  await saveCatalog('openai-oauth', LUNA_ROWS);
  const maintenance = fakeProvider({ name: 'fixture-maintenance', rule: { reply: status(429) } });
  const main = fakeProvider({ name: 'anthropic-oauth', models: HAIKU_ROWS, rule: { reply: OK, byModel: { 'claude-haiku-5-5': status(404, 'model not found') } } });
  await compact(':294', { sessionId: 'chain-cold', provider: main, maintenance, config: MAINTAINER });
  const lighterOk = fakeProvider({ name: 'openai-oauth', models: LUNA_ROWS });
  await compact(':294', { sessionId: 'chain-luna', provider: lighterOk, maintenance, config: MAINTAINER });
  clearCatalogs();
}

// --- :319 a quota or availability failure while resolving the Maintainer route moves to the next route -----------
{
  await saveCatalog('openai-oauth', LUNA_ROWS);
  for (const failure of [status(429), status(404), { code: 'model_not_found', message: 'gone' }]) {
    await compact(':319', {
      sessionId: 'resolve-quota',
      provider: fakeProvider({ name: 'openai-oauth' }),
      maintenance: fakeProvider({ name: 'fixture-maintenance' }),
      config: MAINTAINER,
      init: { failure, abort: false },
    });
  }
  clearCatalogs();
}

// --- :340 any other route resolution failure, or cancellation during it, ends the compaction ---------------------
{
  const main = fakeProvider({ name: 'anthropic' });
  await compact(':340', { sessionId: 'resolve-error', provider: main, maintenance: fakeProvider({ name: 'fixture-maintenance' }), config: MAINTAINER, init: { failure: { message: 'provider init broke' }, abort: false } });
  await compact(':340', { sessionId: 'resolve-abort', provider: main, maintenance: fakeProvider({ name: 'fixture-maintenance' }), config: MAINTAINER, init: { failure: status(429), abort: true } });
}

// --- :372 a Maintainer failure other than quota or availability is not rerouted ----------------------------------
await compact(':372', {
  sessionId: 'chain-error',
  provider: fakeProvider({ name: 'anthropic-oauth', models: HAIKU_ROWS }),
  maintenance: fakeProvider({ name: 'fixture-maintenance', rule: { reply: status(400, 'bad request') } }),
  config: MAINTAINER,
});

// --- :385 self: a warm cache forks, a cold one or a failed fork runs the isolated request on the same route -------
{
  const config = { ...MAINTAINER, compaction: { summaryMode: 'self' } };
  const warmMain = fakeProvider({ name: 'anthropic' });
  captureMain('self-warm', warmMain);
  await compact(':385', { sessionId: 'self-warm', provider: warmMain, config });
  const cold = fakeProvider({ name: 'anthropic' });
  captureMain('self-cold', cold, { ageMs: 10 * MINUTE });
  await compact(':385', { sessionId: 'self-cold', provider: cold, config });
  const failing = fakeProvider({ name: 'anthropic', rule: { reply: OK, byCall: { 1: status(500, 'fork failed') } } });
  captureMain('self-fork-fails', failing);
  await compact(':385', { sessionId: 'self-fork-fails', provider: failing, config });
  forgetAll();
}

const finalDir = `${FIXTURES_ROOT}/summary-mode-routing`;
const stage = stageSet(finalDir);
writeJson(`${stage}/golden.json`, {
  note: `Node's summary route plan at ${NODE_COMMIT} over the cases of summary-mode.test.mjs after :157`,
  conversation: conversation(),
  warm,
  lighter,
  plans,
  compacts,
});
writeSetManifest(stage, {
  set: 'summary-mode-routing',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: [`${S}/compact/summary-mode.test.mjs (:168, :192, :212, :222, :269, :294, :319, :340, :372, :385)`],
    exclusions: {
      firstCase: ':157 (normalisation) is recorded by record-compact-node-cases.mjs',
      fakes: "the test's fake providers are built from a JSON rule (`byCall`, `byModel`, `reply`) instead of closures, so the replay builds the same fakes",
      catalogSaves: "each catalog save is awaited before the next query, so the file on disk is the save's (the test reads the cache's unsettled save; the text is the same)",
      calls: "a send's kind is `isolated` when its opts.sessionId is `<id>:compact` (the isolated request), else `fork`",
    },
  },
});
commitStage(stage, finalDir);
console.log(`warm=${warm.length} lighter=${lighter.length} plans=${plans.length} compacts=${compacts.length}`);
