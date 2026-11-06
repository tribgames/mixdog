#!/usr/bin/env node
// The prompt-cache warmer (session/cache-warm.mjs) as the product runs it: the planner's pure
// functions over grids, the chain's behaviour through scripted steps on a fake clock and fake
// timers (what it sends, bills, logs and keeps in the touch and idle-gap stores), the stores'
// files, and the warm's SSE stream reader (providers/anthropic-cache-warm.mjs). Rust
// `mixdog_ai::warmer` must give the same answers for the same inputs.
//
//   node benchmarks/rust-core/recorders/record-cache-warm.mjs [--tree <dir>]
//
// Output: native/core/fixtures/cache-warm/golden.json.
process.env.TZ = 'UTC';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'cache-warm');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-cache-warm.mjs';
const at = (path) => importFrom(tree, path);
const warm = await at('src/runtime/agent/orchestrator/session/cache-warm.mjs');
const { createPromptCacheTouchStore } = await at('src/runtime/agent/orchestrator/session/prompt-cache-touch-store.mjs');
const { createIdleGapStore } = await at('src/runtime/agent/orchestrator/session/prompt-cache-idle-gaps.mjs');
const { readCacheWarmStream } = await at('src/runtime/agent/orchestrator/providers/anthropic-cache-warm.mjs');
const work = mkdtempSync(join(tmpdir(), 'cache-warm-rec-'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW0 = 4_000_000_000_000;
const ACCOUNT = 'acct-1';
const MODEL = 'claude-opus-4-7';
const STRATEGY_1H = { tools: 'none', system: '1h', tier3: '1h', messages: '1h' };
const STRATEGY_5M = { tools: 'none', system: '1h', tier3: '1h', messages: '5m' };
const PRICES = { read: 0.5e-6, write: 6.25e-6, output: 25e-6 };

// ---- pure functions -------------------------------------------------------------------------
const pure = {};
pure.wilson = [[0, 0], [0, 5], [1, 1], [1, 2], [3, 10], [7, 10], [10, 10], [50, 100], [2, 3]].map(([hits, n]) => ({ hits, n, bound: warm.wilsonLowerBound(hits, n) }));
const GAPS = [
  { at: 1, ms: 10 * MINUTE },
  { at: 2, ms: 70 * MINUTE },
  { at: 3, ms: 70 * MINUTE },
  { at: 4, ms: 130 * MINUTE },
  { at: 5, ms: 12 * HOUR, censored: true },
  { at: 6, ms: 200 * MINUTE },
];
pure.gaps = GAPS;
pure.chance = [[0, 0], [20 * MINUTE, 59 * MINUTE], [20 * MINUTE, 2 * 59 * MINUTE], [65 * MINUTE, 59 * MINUTE], [65 * MINUTE, 5 * HOUR], [11 * HOUR, HOUR], [13 * HOUR, HOUR]].map(([elapsed, within]) => ({
  elapsed,
  within,
  ...warm.sessionReturnChance(GAPS, elapsed, within),
}));
pure.rewrote = [
  {},
  { cachedTokens: 0, cacheWriteTokens: 4095 },
  { cachedTokens: 0, cacheWriteTokens: 4096 },
  { cachedTokens: 4096, cacheWriteTokens: 4096 },
  { cachedTokens: 4095, cacheWriteTokens: 4096 },
  { cachedTokens: 69000, cacheWriteTokens: 1000 },
].map((usage) => ({ usage, rewrote: warm.warmRewrote(usage) }));
pure.delay = [1, 100, MINUTE, 5 * MINUTE, HOUR].map((ttl) => ({ ttl, delay: warm.cacheWarmDelayMs(ttl) }));
pure.ttl = [
  [{}, STRATEGY_1H],
  [{ cacheWriteTokens: 100 }, STRATEGY_1H],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 100 }, STRATEGY_5M],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 0 }, STRATEGY_1H],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, STRATEGY_1H],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, STRATEGY_5M],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, { tools: 'none', system: '1h', tier3: '1h', messages: 'none' }],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, { tools: '5m', system: '1h', tier3: '1h', messages: '5m' }],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, { tools: 'none', system: '5m', tier3: '1h', messages: '1h' }],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 400 }, null],
  [{ cacheWriteTokens: 100, cacheWrite1hTokens: 40 }, null],
].map(([usage, strategy]) => ({ usage, strategy, ttl: warm.writtenCacheTtlMs(usage, strategy) }));
pure.economics = [
  [70000, PRICES],
  [0, PRICES],
  [70000, { read: 0.5e-6, write: 6.25e-6 }],
  [70000, { read: 0.5e-6, write: 6.25e-6, output: -1 }],
  [1000, { read: 0, write: 0, output: 0 }],
].map(([tokens, prices]) => ({ tokens, prices, economics: warm.cacheWarmEconomics(tokens, prices) ?? null }));
const planBase = { now: NOW0 + 59 * MINUTE, touchAt: NOW0, ttlMs: HOUR, lastCallAt: NOW0, gaps: GAPS, promptTokens: 70000, prices: PRICES, latencyMs: null };
pure.plan = [
  ['base', {}],
  ['no last call', { lastCallAt: 0 }],
  ['reaches the window', { lastCallAt: NOW0 - 12 * HOUR }],
  ['late timer', { now: NOW0 + HOUR }],
  ['late by latency', { now: NOW0 + 59 * MINUTE, latencyMs: 61_000 }],
  ['unpriced', { prices: { read: null, write: 1, output: 1 } }],
  ['no tokens', { promptTokens: 0 }],
  ['no gaps', { gaps: [] }],
  ['no idle history this long', { now: NOW0 + 13 * HOUR, touchAt: NOW0 + 12 * HOUR - 10 * MINUTE, lastCallAt: NOW0 + 12 * HOUR - 10 * MINUTE }],
  ['costly warms', { prices: { read: 5e-6, write: 6e-6, output: 25e-6 } }],
  ['5m tier', { ttlMs: 5 * MINUTE, touchAt: NOW0, now: NOW0 + 4 * MINUTE, lastCallAt: NOW0 }],
  ['later elapsed', { now: NOW0 + 3 * HOUR, touchAt: NOW0 + 2 * HOUR + 59 * MINUTE - 59 * MINUTE, lastCallAt: NOW0 }],
].map(([name, over]) => {
  const input = { ...planBase, ...over };
  return { name, input, plan: warm.planCacheWarm(input) };
});
const kindInputs = [
  [{ promptSource: 'goal-continuation' }, null],
  [{ promptSource: { source: 'goal-closeout' } }, null],
  [{ promptSource: 'task-notification' }, null],
  [{ promptSource: 'task-notification', promptOrigin: 'channel' }, null],
  [{ promptOrigin: 'agent-report' }, null],
  [{ promptSource: 'user' }, null],
  [{}, null],
  [{ retryFailedTurn: true }, []],
  [{ retryTurnId: 't1' }, [{ role: 'user', content: 'x', meta: { transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryFailedTurn: true }, [{ role: 'user', content: 'x', meta: { source: 'goal-continuation', transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryFailedTurn: true }, [{ role: 'user', content: 'x', meta: { source: 'goal-continuation', origin: 'channel', transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryFailedTurn: true }, [{ role: 'user', content: 'x', meta: { provenance: { source: 'task-notification' }, transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryFailedTurn: true }, [{ role: 'user', content: 'x', meta: { origin: 'agent-report', transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryTurnId: 'other' }, [{ role: 'user', content: 'x', meta: { transcript: { messageId: 't1', completion: { status: 'failed' } } } }]],
  [{ retryFailedTurn: true }, [
    { role: 'user', content: 'a', meta: { source: 'task-notification', transcript: { attemptId: 'A1', at: 5 } } },
    { role: 'assistant', content: 'b', meta: { transcript: { completion: { status: 'failed', attemptId: 'A1', at: 9 } } } },
  ]],
];
pure.turnKind = kindInputs.map(([input, messages]) => ({ input, messages, kind: warm.cacheWarmTurnKind(input, messages) }));
pure.enabled = [{}, { promptCacheWarming: true }, { promptCacheWarming: 'yes' }, null].map((config) => ({ config, enabled: warm.cacheWarmingEnabled(config) }));

// ---- eligibility ----------------------------------------------------------------------------
const providers = new Map();
const providerOf = (name, over = {}) => {
  const key = `${name}:${Object.keys(over).sort().join(',')}`;
  if (!providers.has(key)) providers.set(key, { name, forAccount: () => providers.get(key), sendCacheWarm: async () => ({}), ...over });
  return providers.get(key);
};
const requestOf = (spec, provider = providerOf(spec.provider ?? 'anthropic-oauth')) => ({
  provider,
  model: spec.model ?? MODEL,
  messages: spec.messages ?? [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
  tools: spec.tools ?? [],
  sentAt: spec.sentAt,
  opts: { session: { id: spec.sessionId ?? 's1' }, cacheStrategy: STRATEGY_1H, ...(spec.opts ?? {}) },
});
const ELIGIBILITY = [
  ['an anthropic oauth request', { provider: 'anthropic-oauth' }],
  ['a key request', { provider: 'anthropic' }],
  ['a key-prefix provider', { provider: 'openai' }],
  ['no warm mode', { provider: 'anthropic', noWarm: true }],
  ['no session', { provider: 'anthropic', opts: { session: {} } }],
  ['a thinking budget', { provider: 'anthropic', opts: { thinkingBudgetTokens: 2048 } }],
  ['an effort on a model without effort levels', { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', opts: { effort: 'high' } }],
  ['an effort on a model with levels', { provider: 'anthropic', opts: { effort: 'high' } }],
  ['no expiring tail', { provider: 'anthropic', opts: { cacheStrategy: { messages: 'none' } } }],
  ['no cache strategy', { provider: 'anthropic', opts: { cacheStrategy: null } }],
  ['a five minute tail', { provider: 'anthropic', opts: { cacheStrategy: STRATEGY_5M } }],
].map(([name, spec]) => {
  const request = requestOf(spec, spec.noWarm ? providerOf(spec.provider, { sendCacheWarm: undefined }) : undefined);
  return { name, spec, reason: warm.cacheWarmIneligibility(request) };
});

// ---- the chain ------------------------------------------------------------------------------
function world(scenario) {
  let clock = scenario.now ?? NOW0;
  const timers = [];
  let nextTimer = 1;
  const events = [];
  const dir = mkdtempSync(join(work, 'w-'));
  const touchFile = join(dir, 'touches.json');
  const gapFile = join(dir, 'gaps.json');
  const touches = createPromptCacheTouchStore(touchFile, { log: (line) => events.push({ log: line }) });
  const gaps = createIdleGapStore({
    path: gapFile,
    lookbackMs: warm.IDLE_RETURN_LOOKBACK_MS,
    windowMs: warm.IDLE_RETURN_MEASURED_WINDOW_MS,
    minMs: warm.cacheWarmDelayMs(5 * MINUTE),
    now: () => clock,
    log: (line) => events.push({ log: line }),
  });
  return { clock: () => clock, setClock: (v) => (clock = v), timers, nextTimer: () => nextTimer++, events, touches, gaps, touchFile, gapFile };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function runScenario(scenario) {
  const w = world(scenario);
  if (scenario.gaps) {
    // Preload a session's closed gaps through the store's own API, on the clock the gaps were learned.
    for (const [sessionId, list] of Object.entries(scenario.gaps)) {
      for (const gap of list) {
        w.gaps.open(sessionId, gap.at);
        const close = gap.censored ? gap.at + warm.IDLE_RETURN_MEASURED_WINDOW_MS : gap.at + gap.ms;
        w.gaps.close(sessionId, close);
      }
    }
  }
  for (const [sessionId, touch] of Object.entries(scenario.touches ?? {})) w.touches.record(sessionId, touch);
  let turnInFlight = false;
  let sendIndex = 0;
  const registered = new Map();
  const sendLog = [];
  warm._setCacheWarmDepsForTest({
    now: () => w.clock(),
    timers: {
      setTimeout: (fn, ms) => {
        const id = w.nextTimer();
        w.timers.push({ id, at: w.clock() + Math.max(0, ms), fn, ms });
        w.events.push({ timer: 'set', delayMs: Math.max(0, ms), at: w.clock() + Math.max(0, ms) });
        return { id, unref() {} };
      },
      clearTimeout: (handle) => {
        const i = w.timers.findIndex((t) => t.id === handle?.id);
        if (i >= 0) {
          w.timers.splice(i, 1);
          w.events.push({ timer: 'cleared' });
        }
      },
    },
    enabled: async () => scenario.enabled !== false,
    readConfigEnabled: () => scenario.enabled !== false,
    turnInFlight: () => turnInFlight,
    lastSentRequest: async (sessionId) => {
      w.events.push({ lastSent: sessionId });
      return scenario.lastSent ? requestOf(scenario.lastSent, registered.get(scenario.lastSent.provider ?? 'anthropic-oauth')) : null;
    },
    providersReady: async () => {},
    registeredProvider: async (name) => (scenario.replaced ? providerOf(name, { replaced: true }) : providerOf(name)),
    prices: async () => (scenario.prices === undefined ? PRICES : scenario.prices),
    send: async (request, chain, target, onUsage) => {
      const step = scenario.sends?.[sendIndex] ?? { usage: { cachedTokens: 70000, cacheWriteTokens: 0 } };
      sendIndex += 1;
      sendLog.push({ at: w.clock(), accountId: target.accountId, provider: target.provider.name });
      w.events.push({ send: { at: w.clock(), accountId: target.accountId, provider: target.provider.name, model: request.model } });
      if (step.advance) w.setClock(w.clock() + step.advance);
      if (step.report) onUsage(step.report);
      if (step.advance2) w.setClock(w.clock() + step.advance2);
      if (step.error) throw Object.assign(new Error(step.error), step.usage ? { usage: step.usage } : {});
      return step.usage;
    },
    recordUsage: async (request, usage, startedAt, accountId) => {
      w.events.push({ billed: { model: request.model, provider: request.provider.name, usage, startedAt, accountId } });
    },
    touches: () => w.touches,
    gaps: () => w.gaps,
    log: (line) => w.events.push({ log: line }),
  });
  const turns = new Map();
  const snapshots = [];
  const requests = new Map();
  for (const step of scenario.steps) {
    const mark = w.events.length;
    switch (step.op) {
      case 'arm': {
        const req = requestOf(step.request);
        requests.set(step.name ?? 'last', req);
        warm.armCacheWarm(step.sessionId, req, step.response);
        break;
      }
      case 'advance': {
        for (;;) {
          const due = w.timers.filter((t) => t.at <= step.to).sort((a, b) => a.at - b.at || a.id - b.id)[0];
          if (!due) break;
          w.timers.splice(w.timers.indexOf(due), 1);
          if (due.at > w.clock()) w.setClock(due.at);
          due.fn();
          await settle();
        }
        if (w.clock() < step.to) w.setClock(step.to);
        break;
      }
      case 'clock':
        w.setClock(step.to);
        break;
      case 'turn':
        turns.set(step.name ?? step.sessionId, warm.noteCacheWarmTurn(step.sessionId, step.kind));
        break;
      case 'endTurn':
        warm.endCacheWarmTurn(step.sessionId, turns.get(step.name ?? step.sessionId));
        break;
      case 'activity':
        warm.noteCacheWarmActivity(step.sessionId, step.request ? requestOf(step.request) : null);
        break;
      case 'cancel':
        warm.cancelCacheWarm(step.sessionId);
        break;
      case 'forget':
        warm.forgetCacheWarm(step.sessionId);
        break;
      case 'enable':
        warm.noteCacheWarmingEnabled(step.value);
        break;
      case 'inFlight':
        turnInFlight = step.value;
        break;
      case 'rearm': {
        const armed = await warm.rearmCacheWarmsAfterRestart();
        w.events.push({ rearmed: armed });
        break;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
    await settle();
    const sessions = step.watch ?? [step.sessionId].filter(Boolean);
    snapshots.push({
      step,
      events: w.events.slice(mark),
      state: sessions.map((id) => {
        const chain = warm.cacheWarmChain(id);
        return {
          id,
          chain: chain ? { ttlMs: chain.ttlMs, touchAt: chain.touchAt, promptTokens: chain.promptTokens, accountId: chain.accountId, latencyMs: chain.latencyMs, refreshAt: chain.refreshAt } : null,
          touch: w.touches.get(id),
          warmUse: w.touches.warmUse(id),
          openAt: w.gaps.openAt(id),
          gaps: w.gaps.gaps(id),
          turn: warm.cacheWarmTurn(id) ? { kind: warm.cacheWarmTurn(id).kind, returning: warm.cacheWarmTurn(id).returning } : null,
        };
      }),
    });
  }
  await Promise.allSettled([w.touches.flush(), w.gaps.flush()]);
  const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  const out = { name: scenario.name, scenario, snapshots, files: { touches: read(w.touchFile), gaps: read(w.gapFile) } };
  warm._setCacheWarmDepsForTest();
  return out;
}

const HIT = { usage: { cachedTokens: 69000, cacheWriteTokens: 1000, cacheWrite1hTokens: 1000 }, providerMetadata: { accountRouting: { accountId: ACCOUNT } } };
const REQ = (over = {}) => ({ sentAt: NOW0, ...over });
const HISTORY = { s1: [{ at: NOW0 - 9 * HOUR, ms: 2 * HOUR }, { at: NOW0 - 8 * HOUR, ms: 2 * HOUR }, { at: NOW0 - 7 * HOUR, ms: 2 * HOUR }, { at: NOW0 - 6 * HOUR, ms: 2 * HOUR }] };
const FIRE = NOW0 + 59 * MINUTE;
const SCENARIOS = [
  { name: 'a hit arms the chain, warms at the refresh point and re-arms', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE, sendsSoFar: 1 },
    { op: 'advance', sessionId: 's1', to: FIRE + 59 * MINUTE },
  ] },
  { name: 'no idle history means no warm', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a warm that read nothing stops the chain and drops the touch', gaps: HISTORY, sends: [{ usage: { cachedTokens: 0, cacheWriteTokens: 0 } }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a rewriting warm marks the session missed until its prefix is dropped', gaps: HISTORY, sends: [{ usage: { cachedTokens: 100, cacheWriteTokens: 69000 } }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: FIRE + MINUTE }), response: HIT },
    { op: 'forget', sessionId: 's1' },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: FIRE + 2 * MINUTE }), response: HIT },
  ] },
  { name: 'a failed warm is billed from its partial usage and stops the chain', gaps: HISTORY, sends: [{ error: 'boom', usage: { cachedTokens: 5, cacheWriteTokens: 0, inputTokens: 2, outputTokens: 0 } }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a failed warm with no usage bills nothing', gaps: HISTORY, sends: [{ error: 'refused' }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a turn in flight at the refresh point stops the chain', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'inFlight', value: true },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a turn entering suspends the chain and its end restores it', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 10 * MINUTE },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'endTurn', sessionId: 's1' },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a turn that sends a request replaces the suspended chain', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 10 * MINUTE },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'activity', sessionId: 's1', request: REQ({ sentAt: NOW0 + 10 * MINUTE }) },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: NOW0 + 10 * MINUTE }), response: HIT },
    { op: 'endTurn', sessionId: 's1' },
  ] },
  { name: 'a restoring turn after the lead window does not bring the chain back', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 10 * MINUTE },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'clock', to: NOW0 + 59 * MINUTE + 30_000 },
    { op: 'endTurn', sessionId: 's1' },
  ] },
  { name: 'a returning turn closes the idle gap at its start; later requests are no return', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 90 * MINUTE },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'activity', sessionId: 's1', request: REQ({ sentAt: NOW0 + 90 * MINUTE }) },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: NOW0 + 91 * MINUTE }), response: HIT },
    { op: 'activity', sessionId: 's1', request: REQ({ sentAt: NOW0 + 92 * MINUTE }) },
    { op: 'endTurn', sessionId: 's1' },
  ] },
  { name: 'a system turn, a continued turn and a non-loop request are neither return nor activity', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 90 * MINUTE },
    { op: 'turn', sessionId: 's1', kind: 'system' },
    { op: 'activity', sessionId: 's1', request: REQ() },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: NOW0 + 91 * MINUTE }), response: HIT },
    { op: 'endTurn', sessionId: 's1' },
    { op: 'turn', sessionId: 's1', kind: 'continuation' },
    { op: 'activity', sessionId: 's1', request: REQ() },
    { op: 'endTurn', sessionId: 's1' },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'activity', sessionId: 's1', request: REQ({ opts: { requestKind: 'compaction' } }) },
    { op: 'activity', sessionId: 's1', request: REQ({ opts: { requestKind: 'turn' } }) },
    { op: 'endTurn', sessionId: 's1' },
  ] },
  { name: 'a gap past the window is kept censored, a short one is dropped', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + 13 * HOUR },
    { op: 'turn', sessionId: 's1', kind: 'return' },
    { op: 'activity', sessionId: 's1', request: REQ() },
    { op: 'endTurn', sessionId: 's1' },
    { op: 'arm', sessionId: 's2', request: REQ({ sessionId: 's2', sentAt: NOW0 + 13 * HOUR }), response: HIT },
    { op: 'clock', to: NOW0 + 13 * HOUR + 3 * MINUTE },
    { op: 'turn', sessionId: 's2', kind: 'return' },
    { op: 'activity', sessionId: 's2', request: REQ({ sessionId: 's2' }) },
    { op: 'endTurn', sessionId: 's2' },
  ] },
  { name: 'warming off keeps the idle gap but arms nothing and drops the touch', enabled: false, touches: { s1: { touchAt: NOW0, ttlMs: HOUR, promptTokens: 70000 } }, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
  ] },
  { name: 'turning warming off cancels every chain', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'arm', sessionId: 's2', request: REQ({ sessionId: 's2' }), response: HIT },
    { op: 'enable', value: false, watch: ['s1', 's2'] },
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
  ] },
  { name: 'an ineligible request or an unproven response arms nothing and drops the touch', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'arm', sessionId: 's1', request: REQ({ opts: { thinkingBudgetTokens: 1024 } }), response: HIT },
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'arm', sessionId: 's1', request: REQ(), response: { usage: { cachedTokens: 69000, cacheWriteTokens: 0 } } },
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: 0 }), response: HIT },
    { op: 'arm', sessionId: 's1', request: REQ(), response: { usage: { cachedTokens: 0, cacheWriteTokens: 5, cacheWrite1hTokens: 5 } } },
    { op: 'arm', sessionId: '', request: REQ(), response: HIT },
  ] },
  { name: 'the prompt size is the reported one or the sum of the slots', steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: { usage: { promptTokens: 123, inputTokens: 1, cachedTokens: 2, cacheWriteTokens: 3, cacheWrite1hTokens: 3 }, providerMetadata: { accountRouting: { accountId: ACCOUNT } } } },
    { op: 'arm', sessionId: 's1', request: REQ(), response: { usage: { inputTokens: 10, cachedTokens: 20, cacheWriteTokens: 30, cacheWrite1hTokens: 30 } } },
  ] },
  { name: 'the account of a roster provider is the one that wrote the entry', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: { usage: HIT.usage } },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a provider without a roster warms without an account', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ({ provider: 'anthropic' }), response: { usage: HIT.usage } },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a replaced provider instance stops the chain', gaps: HISTORY, replaced: true, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'unpriced models stop the chain', gaps: HISTORY, prices: { read: null, write: null, output: null }, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'a late timer stops the chain', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'clock', to: NOW0 + HOUR + 5_000 },
    { op: 'advance', sessionId: 's1', to: NOW0 + HOUR + 5_000 },
  ] },
  { name: 'a warm that outlasts the entry measures its latency and keeps the touch at its send', gaps: HISTORY, sends: [{ report: { cachedTokens: 69000, cacheWriteTokens: 0 }, advance: 1500, advance2: 500, usage: { cachedTokens: 69000, cacheWriteTokens: 0 } }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
  ] },
  { name: 'the next refresh waits out the measured latency', gaps: HISTORY, sends: [{ advance: 400, usage: { cachedTokens: 69000, cacheWriteTokens: 0 } }, { usage: { cachedTokens: 69000, cacheWriteTokens: 0 } }], steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
    { op: 'advance', sessionId: 's1', to: FIRE + 59 * MINUTE },
  ] },
  { name: 'a restart re-arms every touched session that still has more than the lead', gaps: HISTORY,
    touches: {
      s1: { touchAt: NOW0 - 30 * MINUTE, ttlMs: HOUR, promptTokens: 70000, accountId: ACCOUNT },
      s2: { touchAt: NOW0 - 59 * MINUTE - 30_000, ttlMs: HOUR, promptTokens: 70000, accountId: ACCOUNT },
      s3: { touchAt: NOW0 - 10 * MINUTE, ttlMs: HOUR, promptTokens: 70000 },
    },
    lastSent: { provider: 'anthropic-oauth', sentAt: NOW0 - 30 * MINUTE, sessionId: 's1' },
    steps: [{ op: 'rearm', watch: ['s1', 's2', 's3'] }, { op: 'advance', to: NOW0 + 30 * MINUTE, watch: ['s1'] }] },
  { name: 'a restart re-arms nothing while warming is off', enabled: false, touches: { s1: { touchAt: NOW0 - 30 * MINUTE, ttlMs: HOUR, promptTokens: 70000 } }, steps: [{ op: 'rearm', watch: ['s1'] }] },
  { name: 'cancel and forget drop the chain, the touch and the warm use', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'cancel', sessionId: 's1' },
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'forget', sessionId: 's1' },
  ] },
  { name: 'a warm use is dropped when a real request settles', gaps: HISTORY, steps: [
    { op: 'arm', sessionId: 's1', request: REQ(), response: HIT },
    { op: 'advance', sessionId: 's1', to: FIRE },
    { op: 'arm', sessionId: 's1', request: REQ({ sentAt: FIRE + 5 * MINUTE }), response: HIT },
  ] },
];
const chain = [];
for (const scenario of SCENARIOS) chain.push(await runScenario(scenario));

// ---- the stream reader ----------------------------------------------------------------------
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const STREAMS = [
  ['usage then the first content block', [sse([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 }, output_tokens: 1 } } }, { type: 'content_block_start', content_block: { type: 'text' } }, { type: 'content_block_delta' }])]],
  ['the message ends without content', [sse([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }, { type: 'message_delta', usage: { output_tokens: 1 } }, { type: 'message_stop' }])]],
  ['a content block before any usage is not the cut', [sse([{ type: 'content_block_start' }, { type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'content_block_start' }])]],
  ['an error frame carries the usage reported before it', [sse([{ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 9 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }])]],
  ['an error frame before usage carries none', [sse([{ type: 'error', error: { type: 'api_error', message: 'x' } }])]],
  ['frames split across chunks', ['event: message_start\ndata: {"type":"message_st', 'art","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":4}}}\n\nevent: content_block_start\nda', 'ta: {"type":"content_block_start"}\n\n']],
  ['junk frames are skipped', ['data: not json\n\ndata:\n\n: comment\n\n' + sse([{ type: 'message_start', message: { usage: { input_tokens: 2 } } }, { type: 'message_stop' }])]],
  ['an explicit zero replaces an earlier report', [sse([{ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 100 } } }, { type: 'message_delta', usage: { cache_read_input_tokens: 0 } }, { type: 'message_stop' }])]],
  ['a stream that just ends', [sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }])]],
  ['a reported cost rides the usage', [sse([{ type: 'message_start', message: { usage: { input_tokens: 1, cost: 0.25 } } }, { type: 'message_stop' }])]],
];
const stream = [];
for (const [name, chunks] of STREAMS) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const reports = [];
  const row = { name, chunks };
  try {
    row.usage = await readCacheWarmStream({ body }, { onUsage: (u) => reports.push(u) });
  } catch (error) {
    row.error = { message: error.message, usage: error.usage ?? null };
  }
  row.reports = reports;
  stream.push(row);
}

writeJson(join(stage, 'golden.json'), { constants: { leadMs: warm.CACHE_WARM_LEAD_MS, windowMs: warm.IDLE_RETURN_MEASURED_WINDOW_MS, lookbackMs: warm.IDLE_RETURN_LOOKBACK_MS, now0: NOW0 }, pure, eligibility: ELIGIBILITY, chain, stream });
writeSetManifest(stage, { set: 'cache-warm', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
