import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-usage-dashboard-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { createUsageDashboard } = await import('./usage-dashboard.mjs');
const { creditsFromSnapshot } = await import('./usage-dashboard-model.mjs');
after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const options = {
  setup: {
    api: [],
    oauth: [{ id: 'test-dashboard-oauth', name: 'Fixture quota', authenticated: true }],
    local: [],
  },
  getProvider: () => null,
};

test('usage progress snapshots retain the state and totals from their publication', async () => {
  const updates = [];
  const dashboard = await createUsageDashboard(
    {},
    {
      ...options,
      onUpdate: (snapshot) => updates.push(snapshot),
    }
  );
  assert.equal(updates[0].checking, true);
  assert.equal(updates[0].rows[0].status, 'checking');
  assert.equal(updates[0].total.checkingCount, 1);
  assert.equal(dashboard.checking, false);
  assert.equal(dashboard.rows[0].status, 'hidden');
  assert.equal(dashboard.total.hiddenCount, 1);
});

test('a scoped refresh re-queries only the named provider and keeps the rest on their snapshots', async () => {
  let cursorFetches = 0;
  const cursor = {
    async getUsageSnapshot() {
      cursorFetches += 1;
      return { quotaWindows: [{ label: '7D', usedPct: 40 + cursorFetches, resetAt: Date.now() + 3_600_000 }] };
    },
  };
  const scopedOptions = {
    setup: {
      api: [],
      oauth: [
        { id: 'cursor-oauth', name: 'Cursor', authenticated: true },
        { id: 'test-dashboard-oauth', name: 'Fixture quota', authenticated: true },
      ],
      local: [],
    },
    getProvider: (id) => (id === 'cursor-oauth' ? cursor : null),
  };
  const cursorWindow = (dashboard) => dashboard.rows.find((row) => row.id === 'cursor-oauth').windows[0];

  const first = await createUsageDashboard({}, { ...scopedOptions, refresh: true });
  assert.equal(cursorFetches, 1);
  assert.equal(cursorWindow(first).usedPct, 41);

  // Another provider was refreshed: Cursor answers from its snapshot.
  const scoped = await createUsageDashboard(
    {},
    {
      ...scopedOptions,
      refresh: true,
      refreshProviders: ['test-dashboard-oauth'],
    }
  );
  assert.equal(cursorFetches, 1);
  assert.equal(cursorWindow(scoped).usedPct, 41);

  const targeted = await createUsageDashboard(
    {},
    {
      ...scopedOptions,
      refresh: true,
      refreshProviders: ['cursor-oauth'],
    }
  );
  assert.equal(cursorFetches, 2);
  assert.equal(cursorWindow(targeted).usedPct, 42);
});

test('usage progress observers cannot modify the collector through a published row', async () => {
  const dashboard = await createUsageDashboard(
    {},
    {
      ...options,
      onUpdate(snapshot) {
        if (!snapshot.checking) return;
        for (const row of snapshot.rows) {
          row.label = 'Observer-only label';
          row.windows.push({ label: 'Observer-only window', usedPct: 100 });
        }
      },
    }
  );
  assert.equal(dashboard.rows[0].label, 'Fixture quota');
  assert.deepEqual(dashboard.rows[0].windows, []);
});

test('dashboard rows keep provider priority, label ordering and stable ties without reordering setup', async () => {
  const setup = {
    api: [
      { id: 'custom-b', name: 'Beta' },
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'custom-a-first', name: 'Alpha' },
      { id: 'openai', name: 'OpenAI' },
      { id: 'custom-a-second', name: 'Alpha' },
    ],
    oauth: [
      { id: 'antigravity-oauth', name: 'Antigravity' },
      { id: 'cursor-oauth', name: 'Cursor' },
      { id: 'openai-oauth', name: 'OpenAI OAuth' },
    ],
    local: [],
  };
  const originalSetup = structuredClone(setup);
  const dashboard = await createUsageDashboard({}, { setup, preview: true });
  assert.deepEqual(
    dashboard.rows.map((row) => row.id),
    [
      'openai-oauth',
      'cursor-oauth',
      'antigravity-oauth',
      'openai',
      'deepseek',
      'custom-a-first',
      'custom-a-second',
      'custom-b',
    ]
  );
  assert.deepEqual(setup, originalSetup);
});

test('credits appear only when the account credit feature is enabled', () => {
  const codex = (balance) => creditsFromSnapshot('openai-oauth', { balance });
  assert.equal(codex({ unit: 'credits', remainingCredits: 0, unlimited: false, hasCredits: false }), null);
  assert.equal(codex(null), null);
  assert.deepEqual(codex({ unit: 'credits', remainingCredits: 12, unlimited: false, hasCredits: false }), {
    unit: 'credits',
    balance: 12,
  });
  assert.deepEqual(codex({ unit: 'credits', remainingCredits: 0, unlimited: true, hasCredits: true }), {
    unit: 'credits',
    balance: 0,
    unlimited: true,
  });
  const claude = (snapshot) => creditsFromSnapshot('anthropic-oauth', snapshot);
  assert.equal(claude({ quotaWindows: [{ label: '5H', usedPct: 4 }], balance: null }), null);
  assert.deepEqual(
    claude({
      quotaWindows: [{ label: 'EXTRA', limitUsd: 50, usedUsd: 12.5, remainingUsd: 37.5 }],
      balance: { budgetUsd: 50, spentUsd: 12.5, remainingUsd: 37.5 },
    }),
    { unit: 'usd', balance: 37.5, monthlyLimit: 50, spent: 12.5 }
  );
  assert.equal(creditsFromSnapshot('cursor-oauth', { balance: { remainingUsd: 1 } }), null);
});

test('subscription rows carry useCredits from the account pool', async () => {
  const dashboard = await createUsageDashboard(
    {},
    {
      setup: { api: [], oauth: [{ id: 'openai-oauth', name: 'Codex', authenticated: false }], local: [] },
      getProvider: () => null,
    }
  );
  assert.equal(dashboard.rows[0].useCredits, false);
  assert.equal('credits' in dashboard.rows[0], false);
});
