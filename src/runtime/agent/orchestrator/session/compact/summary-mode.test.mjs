import '../loop/test-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactionSummaryPlan, runFreshContextCompact } from '../loop/fresh-context.mjs';
import { captureSideQuestionRequest, forgetSideQuestion, sideQuestionRequest } from '../side-question-store.mjs';
import { normalizeCompactionSummaryMode } from './summary-mode.mjs';
import { compactionCacheWarm, lighterSubscriptionModel } from './summary-route.mjs';
import { rmSync } from 'node:fs';
import { makeModelCache } from '../../providers/model-cache.mjs';
import { CODEX_MODEL_CACHE_OPTIONS } from '../../providers/openai-oauth-catalog-store.mjs';

// The providers' saved catalogs (the disk cache their listModels() writes).
const SAVED_CATALOG = {
  'anthropic-oauth': makeModelCache({ fileName: 'anthropic-oauth-models.json', ttlMs: 24 * 60 * 60_000, version: 2 }),
  'openai-oauth': makeModelCache(CODEX_MODEL_CACHE_OPTIONS),
};
function saveCatalog(providerName, models) {
  SAVED_CATALOG[providerName].save(models);
}
function clearCatalogs() {
  for (const cache of Object.values(SAVED_CATALOG)) rmSync(cache.path(), { force: true });
}

const SUMMARY = [
  '## Goal',
  '- continue the parser refactor',
  '## Constraints & Preferences',
  '- (none)',
  '## Progress',
  '### Done',
  '- read the parser',
  '### In Progress',
  '- refactor',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- (none)',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- (none)',
  '## Relevant Files',
  '- parser.mjs',
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

function conversation() {
  return [
    { role: 'system', content: 'You are the Lead.' },
    ...Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `TURN_${i} `.padEnd(1_600, '.'),
    })),
    { role: 'user', content: 'Refactor the parser.' },
  ];
}

function fakeProvider(name, { models = [], reply = { content: SUMMARY }, info = { contextWindow: 200_000 } } = {}) {
  const calls = [];
  let listed = 0;
  return {
    name,
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
      const value = typeof reply === 'function' ? reply(model, calls.length) : reply;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

// The session's last request, settled `ageMs` ago with `cacheStrategy`.
function captureMain(t, sessionId, provider, { ageMs = 0, cacheStrategy = { messages: '5m' } } = {}) {
  t.after(() => forgetSideQuestion(sessionId));
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
  sideQuestionRequest(sessionId).sentAt = Date.now() - ageMs;
}

function sessionRef(id, provider, model = 'main-model') {
  return { id, provider: provider.name, model, contextWindow: 200_000, compaction: { conversationThresholdTokens: 1 } };
}

function plan({ sessionId, provider, maintenance, config = {}, model = 'main-model' }) {
  return compactionSummaryPlan({
    sessionRef: sessionRef(sessionId, provider, model),
    provider,
    model,
    config,
    initProvidersFn: async () => {},
    getProviderFn: (name) => (name === maintenance?.name ? maintenance : provider),
  });
}

async function firstRoute(summaryPlan) {
  for (const step of summaryPlan.steps) {
    const route = await step();
    if (route) return route;
  }
  return null;
}

function compact({
  sessionId,
  provider,
  maintenance,
  config = {},
  model = 'main-model',
  initProvidersFn = async () => {},
  signal,
}) {
  return runFreshContextCompact({
    sessionRef: sessionRef(sessionId, provider, model),
    messages: conversation(),
    provider,
    model,
    compactBudgetTokens: 50_000,
    compactPolicy: { contextWindow: 200_000 },
    config,
    signal,
    initProvidersFn,
    getProviderFn: (name) => (name === maintenance?.name ? maintenance : provider),
    sendOpts: {},
  });
}

function status(code, message = `status ${code}`) {
  return Object.assign(new Error(message), { status: code });
}

test('summaryMode: smart by default, the saved mode, useMaintainer:false migrates to self', () => {
  assert.equal(normalizeCompactionSummaryMode(undefined), 'smart');
  assert.equal(normalizeCompactionSummaryMode({}), 'smart');
  assert.equal(normalizeCompactionSummaryMode({ useMaintainer: true }), 'smart');
  assert.equal(normalizeCompactionSummaryMode({ useMaintainer: false }), 'self');
  for (const mode of ['smart', 'maintainer', 'self']) {
    assert.equal(normalizeCompactionSummaryMode({ summaryMode: mode, useMaintainer: false }), mode);
  }
  assert.equal(normalizeCompactionSummaryMode({ summaryMode: 'other' }), 'smart');
});

test('the cache is warm only inside the lifetime the last request used, less a safety margin', (t) => {
  const warm = (name, ageMs, cacheStrategy, options) => {
    const sessionId = `warm-${name}-${ageMs}-${cacheStrategy?.messages}`;
    captureMain(t, sessionId, fakeProvider(name, options), { ageMs, cacheStrategy });
    return compactionCacheWarm(sessionId);
  };
  assert.equal(compactionCacheWarm('warm-no-request'), false);
  // Anthropic: the request's message-tail tier.
  assert.equal(warm('anthropic-oauth', 4 * MINUTE, { messages: '5m' }), true);
  assert.equal(warm('anthropic-oauth', 4.75 * MINUTE, { messages: '5m' }), false);
  assert.equal(warm('anthropic', 50 * MINUTE, { messages: '1h' }), true);
  assert.equal(warm('anthropic', 56 * MINUTE, { messages: '1h' }), false);
  assert.equal(warm('anthropic', 0, { messages: 'none' }), false);
  // OpenAI API: the 30m tail holds the conversation.
  assert.equal(warm('openai', 20 * MINUTE, {}), true);
  assert.equal(warm('openai', 28 * MINUTE, {}), false);
  // Codex login: the cache does not expire.
  assert.equal(warm('openai-oauth', 30 * 24 * 60 * MINUTE, {}), true);
  // Other providers: cold unless the catalog marks prompt caching.
  assert.equal(warm('fixture-other', 0, {}, { info: { contextWindow: 200_000 } }), false);
  assert.equal(warm('fixture-cached', 3 * MINUTE, {}, { info: { supportsPromptCaching: true } }), true);
  assert.equal(warm('fixture-cached', 5 * MINUTE, {}, { info: { supportsPromptCaching: true } }), false);
});

test('the lighter model is the newest of its family in the saved catalog of a subscription provider, none elsewhere', async (t) => {
  t.after(clearCatalogs);
  saveCatalog('anthropic-oauth', HAIKU_ROWS);
  saveCatalog('openai-oauth', LUNA_ROWS);
  assert.equal(await lighterSubscriptionModel('anthropic-oauth'), 'claude-haiku-5-5');
  assert.equal(await lighterSubscriptionModel('openai-oauth'), 'gpt-6-luna');
  for (const name of ['anthropic', 'openai', 'openrouter', 'grok-oauth']) {
    assert.equal(await lighterSubscriptionModel(name), null, name);
  }
  saveCatalog('openai-oauth', [{ id: 'gpt-6-luna-2026-09-01' }, { id: 'gpt-6-luna' }]);
  assert.equal(await lighterSubscriptionModel('openai-oauth'), 'gpt-6-luna');
  saveCatalog('anthropic-oauth', [HAIKU_ROWS[2]]);
  saveCatalog('openai-oauth', [{ id: 'gpt-6-astra' }]);
  assert.equal(await lighterSubscriptionModel('anthropic-oauth'), null);
  assert.equal(await lighterSubscriptionModel('openai-oauth'), null);
  clearCatalogs();
  assert.equal(await lighterSubscriptionModel('anthropic-oauth'), null);
  assert.equal(await lighterSubscriptionModel('openai-oauth'), null);
});

test('the lighter step reads the saved catalog only: without one it is skipped and no catalog is fetched', async () => {
  clearCatalogs();
  for (const name of ['anthropic-oauth', 'openai-oauth']) {
    const provider = fakeProvider(name, { models: [...HAIKU_ROWS, ...LUNA_ROWS] });
    const route = await firstRoute(plan({ sessionId: `saved-only-${name}`, provider }));
    assert.equal(route.source, 'session', name);
    assert.equal(provider.listed, 0, name);
  }
});

test('smart: warm forks on the conversation model; cold tries Maintainer, lighter, then the conversation model', async (t) => {
  t.after(clearCatalogs);
  saveCatalog('anthropic-oauth', HAIKU_ROWS);
  saveCatalog('openai-oauth', LUNA_ROWS);
  const maintenance = fakeProvider('fixture-maintenance');
  const warmMain = fakeProvider('anthropic-oauth', { models: HAIKU_ROWS });
  captureMain(t, 'smart-warm', warmMain);
  const warm = plan({ sessionId: 'smart-warm', provider: warmMain, maintenance, config: MAINTAINER });
  assert.equal(warm.mode, 'smart');
  assert.equal(warm.warm, true);
  assert.equal(warm.steps.length, 1);
  assert.equal((await firstRoute(warm)).source, 'session');

  const coldMain = fakeProvider('anthropic-oauth', { models: HAIKU_ROWS });
  captureMain(t, 'smart-cold', coldMain, { ageMs: 10 * MINUTE });
  const withMaintainer = plan({ sessionId: 'smart-cold', provider: coldMain, maintenance, config: MAINTAINER });
  assert.equal(withMaintainer.warm, false);
  assert.equal((await firstRoute(withMaintainer)).source, 'maintenance');

  const lighter = await firstRoute(plan({ sessionId: 'smart-cold', provider: coldMain }));
  assert.equal(lighter.source, 'lighter');
  assert.equal(lighter.provider, coldMain);
  assert.equal(lighter.model, 'claude-haiku-5-5');

  const codex = fakeProvider('openai-oauth', { models: LUNA_ROWS });
  const luna = await firstRoute(plan({ sessionId: 'smart-codex', provider: codex }));
  assert.equal(luna.source, 'lighter');
  assert.equal(luna.model, 'gpt-6-luna');

  // Already on the newest lighter model, or none listed: the conversation model.
  const onHaiku = await firstRoute(plan({ sessionId: 'smart-haiku', provider: coldMain, model: 'claude-haiku-5-5' }));
  assert.equal(onHaiku.source, 'session');

  // API-key providers never get the lighter step.
  for (const name of ['anthropic', 'openai', 'openrouter']) {
    const apiKey = fakeProvider(name, { models: [...HAIKU_ROWS, ...LUNA_ROWS] });
    const route = await firstRoute(plan({ sessionId: `smart-${name}`, provider: apiKey }));
    assert.equal(route.source, 'session', name);
    assert.equal(route.model, 'main-model', name);
  }

  saveCatalog('openai-oauth', [{ id: 'gpt-6-astra' }]);
  const noLuna = fakeProvider('openai-oauth');
  assert.equal((await firstRoute(plan({ sessionId: 'smart-none', provider: noLuna }))).source, 'session');
  for (const provider of [warmMain, coldMain, codex, noLuna]) assert.equal(provider.listed, 0);
});

test('maintainer: the Maintainer warm or cold, else the conversation model; self: always the conversation model', async (t) => {
  const maintenance = fakeProvider('fixture-maintenance');
  const main = fakeProvider('anthropic-oauth', { models: HAIKU_ROWS });
  captureMain(t, 'mode-warm', main);
  const maintainerMode = { ...MAINTAINER, compaction: { summaryMode: 'maintainer' } };
  const warmMaintainer = plan({ sessionId: 'mode-warm', provider: main, maintenance, config: maintainerMode });
  assert.equal(warmMaintainer.warm, true);
  assert.equal((await firstRoute(warmMaintainer)).source, 'maintenance');
  const unset = plan({ sessionId: 'mode-cold', provider: main, config: { compaction: { summaryMode: 'maintainer' } } });
  const fallback = await firstRoute(unset);
  assert.equal(fallback.source, 'session', 'no lighter step in maintainer mode');
  assert.equal(main.listed, 0);

  for (const sessionId of ['mode-warm', 'mode-cold']) {
    const self = plan({
      sessionId,
      provider: main,
      maintenance,
      config: { ...MAINTAINER, compaction: { summaryMode: 'self' } },
    });
    assert.equal(self.steps.length, 1);
    assert.equal((await firstRoute(self)).source, 'session');
  }
});

test('cold smart: a Maintainer out of quota falls to the lighter model, an unavailable lighter model to the conversation model', async (t) => {
  t.after(clearCatalogs);
  saveCatalog('anthropic-oauth', HAIKU_ROWS);
  saveCatalog('openai-oauth', LUNA_ROWS);
  const maintenance = fakeProvider('fixture-maintenance', { reply: status(429) });
  const main = fakeProvider('anthropic-oauth', {
    models: HAIKU_ROWS,
    reply: (model) => (model === 'claude-haiku-5-5' ? status(404, 'model not found') : { content: SUMMARY }),
  });
  const result = await compact({ sessionId: 'chain-cold', provider: main, maintenance, config: MAINTAINER });
  assert.equal(maintenance.calls.length, 1);
  assert.deepEqual(
    main.calls.map((call) => call.model),
    ['claude-haiku-5-5', 'main-model']
  );
  assert.equal(result.summaryModel, 'main-model');
  assert.equal(result.diagnostics.pipeline.summaryRoute, 'session');
  assert.equal(result.diagnostics.pipeline.generated.sharedPrefixFallback, 'cold_cache');

  const lighterOk = fakeProvider('openai-oauth', { models: LUNA_ROWS });
  const viaLuna = await compact({ sessionId: 'chain-luna', provider: lighterOk, maintenance, config: MAINTAINER });
  assert.equal(viaLuna.summaryModel, 'gpt-6-luna');
  assert.equal(viaLuna.diagnostics.pipeline.summaryRoute, 'lighter');
});

test('a quota or availability failure while resolving the Maintainer route moves to the next route', async (t) => {
  t.after(clearCatalogs);
  saveCatalog('openai-oauth', LUNA_ROWS);
  for (const failure of [status(429), status(404), Object.assign(new Error('gone'), { code: 'model_not_found' })]) {
    const maintenance = fakeProvider('fixture-maintenance');
    const main = fakeProvider('openai-oauth');
    const result = await compact({
      sessionId: 'resolve-quota',
      provider: main,
      maintenance,
      config: MAINTAINER,
      initProvidersFn: async () => {
        throw failure;
      },
    });
    assert.equal(maintenance.calls.length, 0);
    assert.equal(result.summaryModel, 'gpt-6-luna');
    assert.equal(result.diagnostics.pipeline.summaryRoute, 'lighter');
  }
});

test('any other route resolution failure, or cancellation during it, ends the compaction', async () => {
  const main = fakeProvider('anthropic');
  await assert.rejects(
    compact({
      sessionId: 'resolve-error',
      provider: main,
      maintenance: fakeProvider('fixture-maintenance'),
      config: MAINTAINER,
      initProvidersFn: async () => {
        throw new Error('provider init broke');
      },
    }),
    /provider init broke/
  );
  const controller = new AbortController();
  await assert.rejects(
    compact({
      sessionId: 'resolve-abort',
      provider: main,
      maintenance: fakeProvider('fixture-maintenance'),
      config: MAINTAINER,
      signal: controller.signal,
      initProvidersFn: async () => {
        controller.abort(new Error('turn cancelled'));
        throw status(429);
      },
    }),
    /turn cancelled/
  );
  assert.equal(main.calls.length, 0);
});

test('a Maintainer failure other than quota or availability is not rerouted', async () => {
  const maintenance = fakeProvider('fixture-maintenance', { reply: status(400, 'bad request') });
  const main = fakeProvider('anthropic-oauth', { models: HAIKU_ROWS });
  await assert.rejects(
    compact({ sessionId: 'chain-error', provider: main, maintenance, config: MAINTAINER }),
    (error) => {
      assert.deepEqual(error.compactRoute, { provider: 'fixture-maintenance', model: 'maintenance-model' });
      return true;
    }
  );
  assert.equal(main.calls.length, 0);
});

test('self: a warm cache forks, a cold one or a failed fork runs the isolated request on the same route', async (t) => {
  const config = { ...MAINTAINER, compaction: { summaryMode: 'self' } };
  const warm = fakeProvider('anthropic');
  captureMain(t, 'self-warm', warm);
  const forked = await compact({ sessionId: 'self-warm', provider: warm, config });
  assert.equal(warm.calls.length, 1);
  assert.equal(forked.diagnostics.pipeline.generated.mode, 'shared-prefix');
  assert.equal(forked.diagnostics.pipeline.cacheWarm, true);

  const cold = fakeProvider('anthropic');
  captureMain(t, 'self-cold', cold, { ageMs: 10 * MINUTE });
  const isolated = await compact({ sessionId: 'self-cold', provider: cold, config });
  assert.equal(isolated.diagnostics.pipeline.generated.mode, 'isolated');
  assert.equal(isolated.diagnostics.pipeline.generated.sharedPrefixFallback, 'cold_cache');
  assert.equal(cold.calls[0].opts.sessionId, 'self-cold:compact');

  const failing = fakeProvider('anthropic', {
    reply: (_model, n) => (n === 1 ? status(500, 'fork failed') : { content: SUMMARY }),
  });
  captureMain(t, 'self-fork-fails', failing);
  const recovered = await compact({ sessionId: 'self-fork-fails', provider: failing, config });
  assert.equal(failing.calls.length, 2);
  assert.equal(failing.calls[1].model, 'main-model');
  assert.equal(failing.calls[1].opts.sessionId, 'self-fork-fails:compact');
  assert.equal(recovered.diagnostics.pipeline.generated.sharedPrefixFallback, 'error');
  assert.equal(recovered.diagnostics.pipeline.summaryRoute, 'session');
});
