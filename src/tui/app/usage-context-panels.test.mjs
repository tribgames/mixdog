import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageContextPanels } from './usage-context-panels.mjs';

// Pins the /usage and /context panel builders: the rows and detail the
// context panel derives from the runtime status getters, and the claim-owned
// paint sequence the usage dashboard streams through.
function createSurface({ ownsAfterAwait = true } = {}) {
  const paints = [];
  const contexts = [];
  const usagePaints = [];
  let claimed = 0;
  return {
    paints,
    contexts,
    usagePaints,
    get claimed() {
      return claimed;
    },
    claim: () => {
      claimed += 1;
      return {
        owns: () => ownsAfterAwait,
        paint: (value) => paints.push(value),
        context: (value) => contexts.push(value),
      };
    },
    claimUsage: () => ({
      owns: () => true,
      paint: (value) => usagePaints.push(value),
    }),
  };
}

const contextStatus = {
  measurement: { tokens: 50_000, source: 'last_api_request', updatedAt: 1234 },
  effectiveContextWindow: 180_000,
  rawContextWindow: 200_000,
  usage: {
    lastContextTokens: 50_000,
    lastInputTokens: 48_000,
    lastCachedReadTokens: 40_000,
    lastCacheWriteTokens: 2_000,
    lastOutputTokens: 900,
  },
  messages: {
    estimatedTokens: 30_000,
    count: 14,
    toolCallCount: 3,
    toolCallTokens: 1_200,
    toolResultCount: 3,
    toolResultTokens: 9_500,
    semantic: { kinds: 2 },
  },
  request: {
    toolSchemaBreakdown: { code: { tokens: 4_000 }, web: { tokens: 1_000 }, mcp: { tokens: 2_500 } },
    requestOverheadTokens: 800,
    reserveTokens: 16_000,
  },
  compaction: {
    lastStage: 'compacted',
    lastChanged: true,
    lastTrigger: 'reactive',
    lastDurationMs: 4200,
    boundaryTokens: 150_000,
    triggerTokens: 140_000,
    pressureTokens: 60_000,
    reserveTokens: 20_000,
  },
  inspection: { entries: [] },
};

function createStore(overrides = {}) {
  const notices = [];
  const contextCalls = [];
  return {
    notices,
    contextCalls,
    toolsStatus: async () => ({ activeCount: 12, count: 20, mcpToolCount: 5, activeMcpToolCount: 3, activeTools: [] }),
    mcpStatus: async () => ({ connectedCount: 1, configuredCount: 2, failedCount: 1 }),
    skillsStatus: async () => ({ count: 7 }),
    pluginsStatus: async () => ({ count: 2 }),
    contextStatus: async (options) => {
      contextCalls.push(options);
      return contextStatus;
    },
    pushNotice: (text, level) => notices.push([text, level]),
    ...overrides,
  };
}

function createPanels({ surface, store, state = { contextWindow: 200_000, rawContextWindow: 250_000 } }) {
  const prompts = [];
  const closes = [];
  const panels = createUsageContextPanels({
    store,
    state,
    surface,
    setProviderPrompt: (value) => prompts.push(['provider', value]),
    setSettingsPrompt: (value) => prompts.push(['settings', value]),
    closeUsagePanel: () => closes.push(1),
  });
  return { panels, prompts, closes };
}

test('openContextPicker renders the context rows from the runtime status getters', async () => {
  const surface = createSurface();
  const store = createStore();
  const { panels, prompts } = createPanels({ surface, store });
  await panels.openContextPicker();

  assert.deepEqual(store.contextCalls, [{ inspect: true }]);
  assert.deepEqual(prompts, [
    ['provider', null],
    ['settings', null],
  ]);
  assert.deepEqual(surface.paints, [null]);
  assert.equal(surface.contexts.length, 1);
  const panel = surface.contexts[0];
  assert.equal(panel.kind, 'context');
  assert.equal(panel.title, 'Context Usage');
  assert.deepEqual(
    panel.rows.map((row) => [row.value, row.label, row.description, row._action]),
    [
      ['summary', 'Context Usage', '50k/180k (27.8%) · 130k free · Last measured input · effective', 'summary'],
      [
        'compaction',
        'Compaction',
        'Compact complete (overflow recovery) · 5s · 60k pressure · 20k reserve',
        'compaction',
      ],
      ['messages', 'Messages', '30k tokens (16.7%) · 14 messages', 'messages'],
      ['tools', 'Tools', '5.0k schema tokens (2.8%) · 12/20 active', 'tools'],
      ['tool-io', 'Tool calls/results', '3 calls (1.2k) · 3 results (9.5k)', 'tool-io'],
      ['request', 'Request overhead', '800 framing · 16k reserve incl. tools', 'request'],
      ['last-api', 'Last API usage', '50k context · 6.0k uncached input · 900 output · last API request', 'last-api'],
      ['reasoning', 'Reasoning tokens', '≈0 tokens (0%) · current context estimate', 'reasoning'],
      ['cache', 'Prompt cache', '80% hit · 40k read · 2.0k write · 6.0k new (last request)', 'cache'],
      ['free', 'Free space', '130k tokens (72.2%) · raw window 200k', 'free'],
      ['extensions', 'Skills/plugins', '7 skills · 2 plugins', 'extensions'],
    ]
  );
  assert.deepEqual(panel.detail.usage, {
    usedTokens: 50_000,
    windowTokens: 180_000,
    freeTokens: 130_000,
    rawWindowTokens: 200_000,
    source: 'Last measured input',
    measurementSource: 'last_api_request',
    measuredAt: 1234,
    effective: true,
  });
  assert.deepEqual(panel.detail.compaction, {
    stage: 'compacted',
    state: 'Compact complete (overflow recovery)',
    triggerTokens: 140_000,
    boundaryTokens: 150_000,
    bufferTokens: 10_000,
    pressureTokens: 60_000,
    reserveTokens: 20_000,
    lastChanged: true,
  });
  assert.deepEqual(panel.detail.mcp, {
    connected: 1,
    configured: 2,
    failed: 1,
    tools: 5,
    activeTools: 3,
    schemaTokens: 2_500,
  });
  assert.deepEqual(panel.detail.lastApi, {
    contextTokens: 50_000,
    inputTokens: 6_000,
    rawInputTokens: 48_000,
    outputTokens: 900,
  });
  assert.equal(panel.detail.inspection, contextStatus.inspection);
  assert.equal(panel.onRefresh, panels.openContextPicker);

  await panel.onInspect('entry-1', 4);
  assert.deepEqual(store.contextCalls.at(-1), { inspect: true, entryId: 'entry-1', revision: 4 });
});

test('openContextPicker falls back to the visible window and placeholders when getters fail', async () => {
  const surface = createSurface();
  const failing = async () => {
    throw new Error('daemon offline');
  };
  const store = createStore({
    toolsStatus: failing,
    mcpStatus: failing,
    skillsStatus: failing,
    pluginsStatus: failing,
    contextStatus: failing,
  });
  const { panels } = createPanels({ surface, store, state: { contextWindow: 100_000 } });
  await panels.openContextPicker();
  const panel = surface.contexts[0];
  const rows = Object.fromEntries(panel.rows.map((row) => [row.value, row.description]));
  assert.equal(rows.summary, '—/100k (—) · — free · Awaiting measurement · effective');
  assert.equal(rows.compaction, 'Compact checked · 0 pressure · 0 reserve');
  assert.equal(rows.tools, '0 schema tokens (0%) · 0/0 active');
  assert.equal(rows.cache, 'N/A hit · — read · 0 new (last request)');
  assert.equal(rows.free, '— tokens (—) · raw window 100k');
  assert.deepEqual(panel.detail.compaction, {
    stage: 'pending',
    state: 'Compact checked',
    triggerTokens: 100_000,
    boundaryTokens: 100_000,
    bufferTokens: 0,
    pressureTokens: null,
    reserveTokens: null,
    lastChanged: false,
  });
});

test('openContextPicker paints nothing when the claim was lost during the fetch', async () => {
  const surface = createSurface({ ownsAfterAwait: false });
  const { panels, prompts } = createPanels({ surface, store: createStore() });
  await panels.openContextPicker();
  assert.equal(surface.claimed, 1);
  assert.deepEqual(surface.paints, []);
  assert.deepEqual(surface.contexts, []);
  assert.deepEqual(prompts, []);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('openUsagePanel streams dashboard updates through the usage claim', async () => {
  const surface = createSurface();
  const requests = [];
  const store = createStore({
    getUsageDashboard: async ({ refresh, onUpdate }) => {
      requests.push(refresh);
      onUpdate({ title: 'partial', rows: [1] });
      onUpdate(null);
      return { title: 'final', rows: [1, 2] };
    },
  });
  const { panels, prompts, closes } = createPanels({ surface, store });
  panels.openUsagePanel('--refresh');
  assert.deepEqual(prompts, [
    ['provider', null],
    ['settings', null],
  ]);
  assert.deepEqual(surface.paints, [null]);
  assert.deepEqual(surface.contexts, [null]);
  assert.deepEqual(surface.usagePaints, [
    {
      title: 'Provider Quotas',
      subtitle: 'Statusline-style provider quota windows.',
      checking: true,
      refresh: true,
      rows: [],
      total: null,
    },
  ]);
  await tick();
  assert.deepEqual(requests, [true]);
  assert.deepEqual(surface.usagePaints.slice(1), [
    { title: 'partial', rows: [1] },
    { title: 'final', rows: [1, 2] },
  ]);
  assert.deepEqual(closes, []);

  panels.openUsagePanel('');
  await tick();
  assert.deepEqual(requests, [true, false]);
});

test('openUsagePanel closes the panel and notifies when the dashboard is unavailable or fails', async () => {
  const unavailable = createStore({ getUsageDashboard: async () => null });
  const first = createPanels({ surface: createSurface(), store: unavailable });
  first.panels.openUsagePanel();
  await tick();
  assert.deepEqual(first.closes, [1]);
  assert.deepEqual(unavailable.notices, [['usage dashboard unavailable', 'warn']]);

  const failing = createStore({
    getUsageDashboard: async () => {
      throw new Error('quota api down');
    },
  });
  const second = createPanels({ surface: createSurface(), store: failing });
  second.panels.openUsagePanel();
  await tick();
  assert.deepEqual(second.closes, [1]);
  assert.deepEqual(failing.notices, [['usage failed: quota api down', 'error']]);
});
