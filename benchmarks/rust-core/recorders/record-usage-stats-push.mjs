#!/usr/bin/env node
// What the statistics dialog is shown, recorded from the real Node service: `getUsageStats({ view: 'hour' })` of
// `createUsageStatsApi` (the question `refreshStatsDataCache` asks) over a real `UsageLedger`, after the empty ledger
// and after each of a series of single appended usage rows, with the clock (`Date.now()`) fixed per step. The Rust
// `usage` section feed (`mixdog-core` `usage_stats_feed`) publishes the answer for the same ledger and clock and must
// equal these bytes, key order included.
//
// The recording is made from a git clone of the Mixdog repository at the pinned Node commit (never a working tree):
// the recorder clones it, checks the commit out, links `node_modules` into it with a junction, and removes the junction
// with `rmdir` before the clone is deleted. The manifest's identity is that clone, so `product.refComparison.exact`
// is true only when the clone is exactly the commit.
//
//   node benchmarks/rust-core/recorders/record-usage-stats-push.mjs [--source C:/Project/mixdog] [--tree <dir with node_modules>]
//   --source: the repository to clone (default C:/Project/mixdog); --tree: where node_modules comes from (default: the source).
// Day keys and hour buckets depend on the machine's time zone; the golden records it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const source = resolve(args.get('source') ?? 'C:/Project/mixdog');
const modulesFrom = resolve(args.get('tree') ?? source);
if (!existsSync(join(modulesFrom, 'node_modules'))) throw new Error(`${modulesFrom} has no node_modules`);

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const work = mkdtempSync(join(tmpdir(), 'usage-stats-push-'));
const clone = join(work, 'clone');
const junction = join(clone, 'node_modules');
let linked = false;
const cleanup = () => {
  // A junction is removed as a directory entry: a recursive delete must never see through it.
  if (linked && existsSync(junction)) rmdirSync(junction);
  linked = false;
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', cleanup);

git(work, 'clone', '--no-checkout', source, clone);
git(clone, 'checkout', '--detach', NODE_COMMIT);
if (git(clone, 'rev-parse', 'HEAD') !== NODE_COMMIT) throw new Error('the clone is not at the pinned commit');
if (git(clone, 'status', '--porcelain')) throw new Error('the clone is not clean');
symlinkSync(join(modulesFrom, 'node_modules'), junction, 'junction');
linked = true;

// Nothing the service reads outside the ledger file may come from the recording PC's profile.
process.env.MIXDOG_DATA_DIR = join(work, 'data');
const { UsageLedger, makeUsageRecord, usageLedgerIfOpen, closeUsageLedgers } = await importFrom(clone, 'src/runtime/shared/llm/usage-ledger.mjs');
const { createUsageStatsApi } = await importFrom(clone, 'src/session-runtime/usage-stats-api.mjs');

const T0 = Date.UTC(2026, 8, 21, 12, 30, 0);
const MIN = 60_000;
const usage = (responseId, ts, extra = {}) =>
  makeUsageRecord({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    ts,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 4000,
    cacheWriteTokens: 500,
    durationMs: 2500,
    ttftMs: 400,
    // A provider-reported bill: the recording does not depend on a price table (a cold catalog prices nothing).
    costUsd: 0.0123,
    sessionId: 'session-a',
    sourceType: 'lead',
    responseId,
    ...extra,
  });
// [clock after the row, the row]. The clock only moves forward; two rows are older than the clock they arrive at.
const series = [
  [T0 + MIN, usage('turn-1', T0)],
  [T0 + 5 * MIN, usage('turn-2', T0 + 4 * MIN, { costUsd: 0.0456, inputTokens: 800, outputTokens: 900, cacheReadTokens: 0, durationMs: 9000, ttftMs: 1500 })],
  [T0 + 9 * MIN, usage('other-provider', T0 + 8 * MIN, { provider: 'openai', model: 'gpt-5', costUsd: 0.0031, sessionId: 'session-b' })],
  [T0 + 12 * MIN, usage('agent', T0 + 11 * MIN, { provider: 'openai', model: 'gpt-5', costUsd: 0.0007, sessionId: 'agent-1', ownerSessionId: 'session-a', sourceType: 'agent' })],
  [T0 + 15 * MIN, usage('failed', T0 + 14 * MIN, { costUsd: null, status: 'failed', attempts: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, elapsedMs: 31_000, durationMs: 0, ttftMs: null })],
  [T0 + 17 * MIN, usage('local', T0 + 16 * MIN, { provider: 'mixdog-local', model: 'local-model', costUsd: null })],
  [T0 + 20 * MIN, usage('gateway', T0 + 19 * MIN, { origin: 'gateway', sessionId: '' })],
  [T0 + 25 * MIN, usage('earlier-hour', T0 - 90 * MIN)],
  [T0 + 30 * MIN, usage('compaction', T0 + 29 * MIN, { sourceType: 'compact', outputTokens: 40 })],
  [T0 + 125 * MIN, usage('next-hour', T0 + 124 * MIN, { sessionId: 'session-c', inputTokens: 90, outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0 })],
];
for (const [, row] of series) {
  if (row.costUsd === null) throw new Error(`${row.responseId} is unpriced: the recording must not depend on a price refresh`);
}

const path = join(work, 'ledger.sqlite');
const ledger = new UsageLedger(path);
const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
const realNow = Date.now;
const answer = async (now) => {
  Date.now = () => now;
  try {
    return await api.getUsageStats({ view: 'hour' });
  } finally {
    Date.now = realNow;
  }
};
const steps = [{ now: T0, rows: [], stats: await answer(T0) }];
for (const [now, row] of series) {
  ledger.record([row]);
  await ledger.settleWrites();
  steps.push({ now, rows: [row], stats: await answer(now) });
}
ledger.close();

// The dashboard entry: `getUsageDashboard({ refresh: true, refreshSetup: false })` (the question `usage-dashboard-store`'s
// `runRefresh` asks) of Node's real `createProviderUsage` over the real `createUsageDashboard` and the real OAuth quota
// reader/fetcher, at each step's clock. The provider setup, the display config and the provider objects are the inputs
// (a provider object answers `getUsageSnapshot()` from a per-step script); nothing reaches a network. Beside each answer
// the recording holds what the quota readers answered the dashboard in that step: the Rust twin's `UsageSources` replays
// exactly those, so the rows it builds are the rows of the same readings.
const { createProviderUsage } = await importFrom(clone, 'src/session-runtime/provider-usage.mjs');
const { createUsageDashboard } = await importFrom(clone, 'src/session-runtime/services/usage-dashboard.mjs');
const oauthUsage = await importFrom(clone, 'src/runtime/agent/orchestrator/providers/oauth-usage.mjs');
const apiUsage = await importFrom(clone, 'src/runtime/agent/orchestrator/providers/api-usage.mjs');

const dashboardQuestion = { refresh: true, refreshSetup: false };
const dashboardSetup = {
  api: [
    { id: 'custom-budget', name: 'Budget API', type: 'api', enabled: true, authenticated: true },
    { id: 'custom-bare', name: 'Bare API', type: 'api', enabled: true, authenticated: true },
    { id: 'custom-nokey', name: 'No-key API', type: 'api', enabled: false, authenticated: false },
  ],
  oauth: [
    { id: 'cursor-oauth', name: 'Cursor', type: 'oauth', enabled: true, authenticated: true },
    { id: 'antigravity-oauth', name: 'Antigravity', type: 'oauth', enabled: true, authenticated: true },
    { id: 'openai-oauth', name: 'OpenAI', type: 'oauth', enabled: false, authenticated: false },
  ],
};
const windowsOf = (n, base) => ({
  source: 'provider-api',
  quotaWindows: [
    { label: '5H', usedPct: base + 3 * n, resetAt: T0 + (n + 3) * 60 * MIN },
    { label: '7D', usedPct: base / 2 + n, resetAt: T0 + (n + 70) * 60 * MIN },
  ],
});
// What each provider object answers in step n: a reading, nothing (an empty answer), or an error.
const providerScripts = {
  'cursor-oauth': (n) => {
    if (n === 5) return null;
    if (n === 8) throw new Error('cursor usage offline');
    return windowsOf(n, 20);
  },
  'antigravity-oauth': (n) => {
    if (n <= 2 || n === 7) throw new Error('antigravity usage unavailable');
    return windowsOf(n, 55);
  },
};
let step = 0;
const produced = {};
const providers = Object.fromEntries(
  Object.entries(providerScripts).map(([id, script]) => [
    id,
    {
      getUsageSnapshot: async () => {
        produced[id] = false;
        const snapshot = script(step);
        produced[id] = !!snapshot;
        return snapshot;
      },
    },
  ])
);
let displayConfig = {};
const providerUsage = createProviderUsage({
  caches: {
    usageDashboardCache: { dashboard: null, at: 0 },
    usageDashboardPromise: null,
    providerSetupCache: { setup: null, at: 0 },
    providerSetupQuickCache: { setup: null, at: 0 },
    providerSetupPromise: null,
  },
  getReg: () => ({ getProvider: (id) => providers[id] ?? null }),
  displayConfig: () => displayConfig,
  providerSetup: async () => dashboardSetup,
  createUsageDashboard,
  fetchOAuthUsageSnapshot: oauthUsage.fetchOAuthUsageSnapshot,
  consumeOpenAICodexResetCredit: async () => ({}),
  isCloseRequested: () => false,
  getProviderSetupWarmupTimer: () => null,
  scheduleProviderSetupWarmup: () => {},
});
const quotaOf = (id, options) => oauthUsage.readCachedOAuthUsageSnapshot({ provider: id, model: '' }, options) ?? null;
for (const [n, entry] of steps.entries()) {
  step = n;
  Date.now = () => entry.now;
  displayConfig = { providers: { 'custom-budget': { limitUsd: 20, usedUsd: 1.5 * n + 1 } } };
  Object.keys(produced).forEach((id) => delete produced[id]);
  const oauth = Object.fromEntries(dashboardSetup.oauth.filter((item) => item.authenticated).map((item) => [item.id, { cached: quotaOf(item.id) }]));
  const apiCached = Object.fromEntries(dashboardSetup.api.filter((item) => item.authenticated).map((item) => [item.id, apiUsage.readCachedApiUsageSnapshot(item.id) ?? null]));
  const answer = await providerUsage.getUsageDashboard(dashboardQuestion);
  for (const [id, reading] of Object.entries(oauth)) {
    reading.fetched = produced[id] ? quotaOf(id) : null;
    reading.stale = quotaOf(id, { allowStale: true });
    if (produced[id] && reading.fetched?.cachedAt !== entry.now) throw new Error(`${id} step ${n}: the reading was not cached at the step clock`);
  }
  const apiReadings = {};
  for (const [id, cached] of Object.entries(apiCached)) apiReadings[id] = { cached, fetched: (await apiUsage.fetchApiUsageSnapshot(id, { force: true })) ?? null };
  entry.dashboard = { config: displayConfig, oauth, api: apiReadings, answer };
}
Date.now = realNow;
// The quota cache writes its disk copy on exit, and each reading's quota history went to the process's own ledger
// (under the work directory): write, settle and close them now, before the directory goes.
process.emit('beforeExit', 0);
await usageLedgerIfOpen()?.settleWrites();
closeUsageLedgers();

const finalOut = join(FIXTURES_ROOT, 'usage-stats-push');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: "Per step, Date.now() fixed to `now`: `stats` is getUsageStats({ view: 'hour' }) of the real createUsageStatsApi over a real UsageLedger (the empty ledger, then after each appended row); `dashboard.answer` is getUsageDashboard(dashboardQuestion) of the real createProviderUsage/createUsageDashboard over `dashboardSetup`, `dashboard.config` and scripted provider objects, with the quota readings the dashboard was answered from (`oauth`: cached before, fetched, stale after; `api`: cached, fetched)",
  question: { view: 'hour' },
  dashboardQuestion,
  dashboardSetup,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  steps,
});
writeSetManifest(out, {
  set: 'usage-stats-push',
  recorder: 'benchmarks/rust-core/recorders/record-usage-stats-push.mjs',
  command: 'node benchmarks/rust-core/recorders/record-usage-stats-push.mjs --source <mixdog repository> --tree <dir with node_modules>',
  extra: { nodeCommit: NODE_COMMIT, nodeModulesFrom: 'junction to the tree given by --tree' },
  identityTree: clone,
  identityRef: NODE_COMMIT,
});
commitStage(out, finalOut);
console.log(`steps=${steps.length}`);
