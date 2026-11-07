#!/usr/bin/env node
// The process's cache-warm dependencies (session/cache-warm.mjs `DEFAULT_DEPS`) as the product
// runs them: `defaultPrices` (per-token rates of a warm, over a models.dev catalog holding the
// usage suites' list rates, including a prompt-length tier) and `defaultRecordUsage` (the
// ledger row of a finished warm, reached through the real chain: only `send` is scripted, the
// ledger is a real one in a temp directory whose `recordQueued` is captured). Rust
// `mixdog_ai::warmer::process::ProcessWarmDeps` must answer the same prices and write the same rows.
//
//   node benchmarks/rust-core/recorders/record-cache-warm-deps.mjs [--tree <dir>]
//
// Output: native/core/fixtures/cache-warm-deps/golden.json (the catalog data is part of it, so the
// replay prices over the same table).
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'cache-warm-deps');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-cache-warm-deps.mjs';
const at = (path) => importFrom(tree, path);
// Sets MIXDOG_DATA_DIR to a folder holding the models.dev catalog with the suites' list rates.
await at('src/runtime/shared/llm/usage-test-support.mjs');
await (await at('src/runtime/shared/llm/model-catalog.mjs')).warmCatalogFromDisk();
const modelsdev = JSON.parse(readFileSync(join(process.env.MIXDOG_DATA_DIR, 'modelsdev-catalog.json'), 'utf8')).data;
process.env.MIXDOG_USAGE_LEDGER_PATH = join(mkdtempSync(join(tmpdir(), 'cache-warm-deps-')), 'ledger.sqlite');
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'cache-warm-deps-home-'));

const warm = await at('src/runtime/agent/orchestrator/session/cache-warm.mjs');
const { createPromptCacheTouchStore } = await at('src/runtime/agent/orchestrator/session/prompt-cache-touch-store.mjs');
const { createIdleGapStore } = await at('src/runtime/agent/orchestrator/session/prompt-cache-idle-gaps.mjs');
const { UsageLedger } = await at('src/runtime/shared/llm/usage-ledger.mjs');
const { supportsAnthropicFastMode } = await at('src/runtime/shared/llm/anthropic-betas.mjs');
const { fastModeAvailable } = await at('src/runtime/agent/orchestrator/providers/anthropic-fast-mode.mjs');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW0 = 4_000_000_000_000;
let clock = NOW0;
Date.now = () => clock;

// ---- defaultPrices ----------------------------------------------------------------------------
const PRICE_CASES = [
  ['anthropic', 'claude-opus-4-8', false],
  ['anthropic', 'claude-opus-4-8', true],
  ['anthropic-oauth', 'claude-opus-4-8', false],
  ['xai', 'grok-4.20', false],
  ['anthropic', 'zz-unpriced', false],
];
const prices = [];
for (const [provider, model, fast] of PRICE_CASES) {
  for (const ttlMs of [5 * MINUTE, HOUR]) {
    for (const promptTokens of [1000, 70_000, 250_000]) {
      const request = { model, provider: { name: provider }, opts: { fast } };
      prices.push({
        provider,
        model,
        fast,
        fastPriced: fast && supportsAnthropicFastMode(model) && fastModeAvailable(),
        ttlMs,
        promptTokens,
        prices: await warm.defaultPrices(request, ttlMs, promptTokens),
      });
    }
  }
}

// ---- defaultRecordUsage ------------------------------------------------------------------------
const STRATEGY_1H = { tools: 'none', system: '1h', tier3: '1h', messages: '1h' };
const HISTORY = [9, 8, 7, 6].map((h) => ({ at: NOW0 - h * HOUR, ms: 2 * HOUR }));
const FIRE = NOW0 + 59 * MINUTE;
const HIT = (accountId) => ({
  usage: { cachedTokens: 69000, cacheWriteTokens: 1000, cacheWrite1hTokens: 1000 },
  ...(accountId ? { providerMetadata: { accountRouting: { accountId } } } : {}),
});
const ROW_CASES = [
  { name: 'subscription provider, owner session', provider: 'anthropic-oauth', model: 'claude-opus-4-8', session: { id: 's1', ownerSessionId: 'owner-1' }, account: 'acct-1', send: { usage: { inputTokens: 12, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'parent session when there is no owner', provider: 'anthropic-oauth', model: 'claude-opus-4-8', session: { id: 's1', parentSessionId: 'parent-1' }, account: 'acct-1', send: { usage: { inputTokens: 12, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'no owner and no parent', provider: 'anthropic', model: 'claude-opus-4-8', session: { id: 's1' }, account: 'acct-1', send: { usage: { inputTokens: 12, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'an API key route is priced from the catalog', provider: 'anthropic', model: 'claude-opus-4-8', session: { id: 's1' }, account: 'acct-1', send: { usage: { inputTokens: 12, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 800, cacheWrite1hTokens: 300 } } },
  { name: 'no account routing', provider: 'anthropic', model: 'claude-opus-4-8', session: { id: 's1' }, account: '', send: { usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'the send takes time', provider: 'anthropic', model: 'claude-opus-4-8', session: { id: 's1' }, account: 'acct-1', send: { advance: 1500, usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'an unpriced model', provider: 'anthropic', model: 'zz-unpriced', session: { id: 's1' }, account: 'acct-1', send: { usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 69000, cacheWriteTokens: 0 } } },
  { name: 'a failed warm is billed from its partial usage', provider: 'anthropic', model: 'claude-opus-4-8', session: { id: 's1' }, account: 'acct-1', send: { error: 'boom', usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 5, cacheWriteTokens: 0 } } },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const rows = [];
const captured = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  captured.push({ at: Date.now(), row });
};
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

for (const spec of ROW_CASES) {
  clock = NOW0;
  captured.length = 0;
  const dir = mkdtempSync(join(tmpdir(), 'cache-warm-deps-w-'));
  const touches = createPromptCacheTouchStore(join(dir, 'touches.json'), { log: () => {} });
  const gaps = createIdleGapStore({
    path: join(dir, 'gaps.json'),
    lookbackMs: warm.IDLE_RETURN_LOOKBACK_MS,
    windowMs: warm.IDLE_RETURN_MEASURED_WINDOW_MS,
    minMs: warm.cacheWarmDelayMs(5 * MINUTE),
    now: () => clock,
    log: () => {},
  });
  for (const gap of HISTORY) {
    gaps.open('s1', gap.at);
    gaps.close('s1', gap.at + gap.ms);
  }
  const timers = [];
  let sentAt = null;
  const provider = { name: spec.provider, forAccount: () => provider, sendCacheWarm: async () => ({}) };
  warm._setCacheWarmDepsForTest({
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        const timer = { at: clock + Math.max(0, ms), fn, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    enabled: async () => true,
    readConfigEnabled: () => true,
    turnInFlight: () => false,
    lastSentRequest: async () => null,
    providersReady: async () => {},
    registeredProvider: async () => provider,
    prices: async () => ({ read: 0.5e-6, write: 6.25e-6, output: 25e-6 }),
    send: async () => {
      sentAt = clock;
      if (spec.send.advance) clock += spec.send.advance;
      if (spec.send.error) throw Object.assign(new Error(spec.send.error), { usage: spec.send.usage });
      return spec.send.usage;
    },
    touches: () => touches,
    gaps: () => gaps,
    log: () => {},
  });
  warm.armCacheWarm('s1', { provider, model: spec.model, messages: [{ role: 'user', content: 'U' }], tools: [], sentAt: NOW0, opts: { session: spec.session, cacheStrategy: STRATEGY_1H } }, HIT(spec.account));
  await settle();
  for (;;) {
    const due = timers.filter((t) => t.at <= FIRE).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    if (due.at > clock) clock = due.at;
    due.fn();
    await settle();
  }
  if (captured.length !== 1) throw new Error(`${spec.name}: ${captured.length} rows`);
  const { at: recordedAt, row } = captured[0];
  rows.push({
    name: spec.name,
    provider: spec.provider,
    model: spec.model,
    session: spec.session,
    account: spec.account,
    usage: spec.send.usage,
    startedAt: sentAt,
    recordedAt,
    row: { ...row, id: row.id.replace(UUID, '<req>'), rates: JSON.stringify(row.rates) },
  });
  warm._setCacheWarmDepsForTest();
}

writeJson(join(stage, 'golden.json'), { modelsdev, prices, rows });
writeSetManifest(stage, { set: 'cache-warm-deps', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
