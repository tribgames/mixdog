import './loop/test-isolation.mjs';
// Cache warms (cache-warm.mjs): the warm re-sends the last real request with
// a byte-identical cacheable prefix through the provider's warm mode, never
// touches the transcript or session activity, is billed in the ledger
// whatever happens, and goes out only when the session's own history of idle
// gaps says the expected miss outweighs the warms. The provider's warm mode
// and its account gate are covered in providers/cache-warm-admission.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _buildRequestBodyForCacheSmoke } from '../providers/anthropic-oauth.mjs';
import { _initProvidersCallCountForTest, _withRegisteredProviderForTestAsync } from '../providers/registry.mjs';
import { readCacheWarmStream } from '../providers/anthropic-cache-warm.mjs';
import { onSessionActivityChange, onSessionTurnStart } from '../../../shared/session-activity-signal.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { createTitleCompletion } from '../agent-runtime/title-completion.mjs';
import {
  _groupPendingMessageEntries,
  pendingMessageQueueEntry,
  PROMPT_ORIGIN_AGENT_REPORT,
  PROMPT_ORIGIN_CHANNEL,
} from './manager/pending-message-entry.mjs';
import { makeQueueEntry as buildQueueEntry } from '../../../../tui/session/session-flow/queue/entry-shape.mjs';
import { turnOptionsForBatch } from '../../../../tui/session/session-flow/drain.mjs';
import { attachFailedTurnCompletion } from './manager/ask-turn-settle.mjs';

let queueIds = 0;
const makeQueueEntry = (text, options) =>
  buildQueueEntry(text, options, () => {
    queueIds += 1;
    return `q${queueIds}`;
  });
import { routineTriggerHeader } from '../../../shared/routine-trigger.mjs';
import { idleAutoClearDue, sessionActivityTimestamp } from '../../../shared/idle-auto-clear-gate.mjs';
import {
  _setCacheWarmDepsForTest,
  armCacheWarm,
  CACHE_WARM_EXPIRY_MARGIN_MS,
  cacheWarmChain,
  cacheWarmDelayMs,
  cacheWarmEconomics,
  cacheWarmIneligibility,
  cacheWarmingEnabled,
  cacheWarmSend,
  IDLE_RETURN_LOOKBACK_MS,
  IDLE_RETURN_MEASURED_WINDOW_MS,
  cacheWarmTurnKind,
  endCacheWarmTurn,
  noteCacheWarmActivity,
  noteCacheWarmTurn,
  planCacheWarm,
  rearmCacheWarmsAfterRestart,
  sessionReturnChance,
  wilsonLowerBound,
  writtenCacheTtlMs,
} from './cache-warm.mjs';
import { promptCacheWarmingSetting } from '../config.mjs';
import { createIdleGapStore } from './prompt-cache-idle-gaps.mjs';
import { createPromptCacheTouchStore } from './prompt-cache-touch-store.mjs';
import { captureSideQuestionRequest, forgetSideQuestion, retireCompactionFork } from './side-question-store.mjs';
import { _runSessionPurgeHooks } from './store/session-observers.mjs';
import { withTailReminder } from './tail-reminder-rules.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const I = 59 * MINUTE;
const MODEL = 'claude-opus-4-7';
const ACCOUNT = 'acct-1';
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
const CACHE_STRATEGY = { tools: 'none', system: '1h', tier3: '1h', messages: '1h' };
const HIT = {
  usage: { cachedTokens: 69_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 1_000 },
  providerMetadata: { accountRouting: { provider: 'anthropic-oauth', accountId: ACCOUNT } },
};
const TMP = mkdtempSync(join(tmpdir(), 'cache-warm-test-'));
let stores = 0;
// Every gap store the tests made: their pending writes land before cleanup.
const gapStores = [];
test.after(async () => {
  await Promise.allSettled(gapStores.map((store) => store.flush()));
  rmSync(TMP, { recursive: true, force: true });
});

function homeSession(id = 'sess_home_lead') {
  return {
    id,
    agent: 'lead',
    provider: 'anthropic-oauth',
    model: MODEL,
    lastProviderSendAt: 1_000,
    updatedAt: 1_000,
    lastContextTokens: 70_000,
    messages: [],
  };
}

// A routine thread as production writes it: each fire's prompt opens with
// the routine trigger header (routine-home-turn.mjs).
const fire = (at) =>
  `${routineTriggerHeader({ kind: 'schedule', name: 'monitor', now: new Date(at) })}\n\nCheck the feed.`;
const PREFIX = [
  { role: 'system', content: 'You are the bot.' },
  { role: 'user', content: fire(Date.UTC(2026, 9, 25, 22)) },
  { role: 'assistant', content: 'ROUTINE_QUIET' },
  { role: 'user', content: fire(Date.UTC(2026, 9, 25, 23)) },
];

// A roster provider whose warm mode returns `reply` (or calls it with the
// warm's arguments). `send` is the admission/quota path a warm must never
// use; `forAccount` records the account each warm went to.
function provider(name = 'anthropic-oauth', reply = { cachedTokens: 70_000, cacheWriteTokens: 0 }) {
  const calls = [];
  const accounts = [];
  const prov = {
    name,
    calls,
    accounts,
    sends: 0,
    async send() {
      prov.sends += 1;
      return { usage: {} };
    },
    forAccount(id) {
      accounts.push(id);
      return prov;
    },
    async sendCacheWarm(messages, model, tools, opts, hooks) {
      calls.push({ messages, model, tools, opts, hooks });
      return typeof reply === 'function' ? reply(opts, hooks) : reply;
    },
  };
  return prov;
}

function request({ session = homeSession(), opts = {}, prov = provider() } = {}) {
  return {
    provider: prov,
    model: MODEL,
    messages: [...PREFIX],
    tools: TOOLS,
    opts: { session, cacheStrategy: CACHE_STRATEGY, effort: 'high', ...opts },
    response: null,
    sentAt: 0,
  };
}

const stripMarkers = (value) =>
  JSON.parse(JSON.stringify(value), (key, v) => (key === 'cache_control' ? undefined : v));
const blocks = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

function markedPositions(messages) {
  const marks = [];
  messages.forEach((message, index) => {
    blocks(message.content).forEach((block, blockIndex) => {
      if (block?.cache_control) marks.push([index, blockIndex]);
    });
  });
  return marks;
}

test('the warm body is the real body but for max_tokens 1, and its cached prefix is the next routine turn’s', async () => {
  const req = request();
  const { session } = req.opts;
  const realMessages = withTailReminder(req.messages, { session, provider: req.provider, model: MODEL });
  const real = await _buildRequestBodyForCacheSmoke(realMessages, MODEL, TOOLS, req.opts);

  const send = cacheWarmSend(req);
  const warm = await _buildRequestBodyForCacheSmoke(send.messages, send.model, send.tools, send.opts);
  assert.equal(warm.max_tokens, 1);
  assert.ok(real.max_tokens > 1);
  assert.equal(warm.thinking?.type, 'adaptive', 'thinking stays adaptive: no budget derived from max_tokens');
  assert.deepEqual({ ...warm, max_tokens: 0 }, { ...real, max_tokens: 0 }, 'everything else is byte-identical');

  const nextMessages = withTailReminder(
    [
      ...req.messages,
      { role: 'assistant', content: 'ROUTINE_QUIET' },
      { role: 'user', content: fire(Date.UTC(2026, 9, 26)) },
    ],
    { session, provider: req.provider, model: MODEL }
  );
  const next = await _buildRequestBodyForCacheSmoke(nextMessages, MODEL, TOOLS, req.opts);
  const [markIndex, markBlock] = markedPositions(warm.messages).at(-1);
  assert.deepEqual(next.system, warm.system);
  assert.deepEqual(next.tools, warm.tools);
  assert.deepEqual(next.thinking, warm.thinking);
  assert.deepEqual(next.output_config, warm.output_config);
  assert.deepEqual(stripMarkers(next.messages.slice(0, markIndex)), stripMarkers(warm.messages.slice(0, markIndex)));
  assert.deepEqual(
    stripMarkers(blocks(next.messages[markIndex].content).slice(0, markBlock + 1)),
    stripMarkers(blocks(warm.messages[markIndex].content).slice(0, markBlock + 1))
  );
  assert.ok(
    JSON.stringify(warm.messages[markIndex]).includes('Check the feed.'),
    'the breakpoint closes the last fire'
  );
});

function sseResponse(frames, { open = false } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
      if (!open) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200 }), cancelled: () => cancelled };
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    usage: { input_tokens: 3, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 0, output_tokens: 1 },
  },
};

test('warm stream: usage is reported on message_start and the open stream is cancelled at the first content block', async () => {
  const cut = sseResponse(
    [
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'never read' } },
    ],
    { open: true }
  );
  const reported = [];
  const usage = await readCacheWarmStream(cut.response, { onUsage: (u) => reported.push(u) });
  assert.equal(usage.cachedTokens, 70_000);
  assert.equal(usage.cacheWriteTokens, 0);
  assert.equal(reported.length, 1);
  assert.equal(cut.cancelled(), true);
});

test('warm stream: an error frame on a still-open stream cancels it and keeps the usage already reported', async () => {
  const failing = sseResponse(
    [MESSAGE_START, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    { open: true }
  );
  await assert.rejects(
    readCacheWarmStream(failing.response),
    (error) => error.usage?.cachedTokens === 70_000 && error.status === 529
  );
  assert.equal(failing.cancelled(), true, 'the body is not left open');
  const unknown = sseResponse([{ type: 'error', error: { type: 'brand_new_error', message: '?' } }], { open: true });
  await assert.rejects(
    readCacheWarmStream(unknown.response),
    (error) => error.status === undefined && error.providerWireError === true && error.usage === null
  );
  assert.equal(unknown.cancelled(), true);
});

test('eligibility: explicit-breakpoint providers with a warm mode, no budget thinking', () => {
  assert.equal(cacheWarmIneligibility(request()), null);
  assert.equal(cacheWarmIneligibility(request({ prov: provider('anthropic') })), null);
  assert.match(cacheWarmIneligibility(request({ prov: provider('openai') })), /without breakpoints/);
  assert.match(cacheWarmIneligibility(request({ prov: provider('gemini') })), /without breakpoints/);
  const noWarmMode = { name: 'anthropic', send: async () => ({}) };
  assert.match(cacheWarmIneligibility(request({ prov: noWarmMode })), /warm mode/);
  assert.match(cacheWarmIneligibility(request({ opts: { thinkingBudgetTokens: 4096 } })), /budget/);
  assert.match(cacheWarmIneligibility(request({ opts: { cacheStrategy: { messages: 'none' } } })), /message-tail/);
});

test('timing: the warm goes out at max(0.9·T, T−60s), within T−10s', () => {
  assert.equal(cacheWarmDelayMs(HOUR), 59 * MINUTE);
  assert.equal(cacheWarmDelayMs(5 * MINUTE), 270_000);
  assert.equal(CACHE_WARM_EXPIRY_MARGIN_MS, 10_000);
});

test('written tier: only what the usage proves', () => {
  const all1h = CACHE_STRATEGY;
  const tail5m = { ...CACHE_STRATEGY, messages: '5m' };
  assert.equal(
    writtenCacheTtlMs({ cacheWriteTokens: 900, cacheWrite1hTokens: 900 }, tail5m),
    HOUR,
    'one tier: the tail’s'
  );
  assert.equal(writtenCacheTtlMs({ cacheWriteTokens: 900 }, all1h), 5 * MINUTE, 'a requested 1h written as 5m');
  assert.equal(writtenCacheTtlMs({ cachedTokens: 900 }, all1h), 0, 'a read-only response proves no tier');
  assert.equal(writtenCacheTtlMs({}, all1h), 0);
  const mixed = { cacheWriteTokens: 900, cacheWrite1hTokens: 400 };
  assert.equal(writtenCacheTtlMs(mixed, tail5m), 5 * MINUTE, 'the only 5m breakpoint is the tail');
  assert.equal(writtenCacheTtlMs(mixed, all1h), 0, 'mixed writes under an all-1h strategy prove nothing');
});

// Per-token catalog prices (`priceUsage` per 1M tokens): claude-opus-5-5
// ($4 input, $20 output; read 0.05x, 5m write 1.25x, 1h write 2x) and
// claude-opus-4-7 ($5 input, $25 output; read 0.1x, 5m write 1.25x, 1h
// write 2x).
const M = 1_000_000;
const OPUS_55 = { read: 0.2 / M, write5m: 5 / M, write1h: 8 / M, output: 20 / M };
const tier = (model, ttl) => ({
  read: model.read,
  write: ttl === HOUR ? model.write1h : model.write5m,
  output: model.output,
});

test('economics: a read plus one output token per warm against a tier write minus the read', () => {
  const { warmCost, missCost } = cacheWarmEconomics(70_000, tier(OPUS_55, HOUR));
  assert.ok(Math.abs(warmCost - (0.014 + 20 / M)) < 1e-12);
  assert.ok(Math.abs(missCost - 0.546) < 1e-12);
  assert.equal(cacheWarmEconomics(0, tier(OPUS_55, HOUR)), null, 'unknown prompt size');
  assert.equal(cacheWarmEconomics(70_000, null), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), read: null }), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), write: null }), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), output: undefined }), null);
});

test('Wilson lower bound: the standard 95% score interval, 0 without data', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(0, 25), 0);
  // Published 95% Wilson intervals: 5/10 → [0.2366, 0.7634]; 10/10 → [0.7225, 1].
  assert.equal(wilsonLowerBound(5, 10).toFixed(4), '0.2366');
  assert.equal(wilsonLowerBound(10, 10).toFixed(4), '0.7225');
});

// Gaps as the store keeps them.
const gap = (ms) =>
  ms >= IDLE_RETURN_MEASURED_WINDOW_MS ? { ms: IDLE_RETURN_MEASURED_WINDOW_MS, censored: true } : { ms };
const gapsOf = (...minutes) => minutes.map((m) => gap(m * MINUTE));

test('return chance: returns in (e, e + w] among the gaps still idle at e; a censored gap is idle, never a return', () => {
  const gaps = gapsOf(30, 100, 180, 180, 13 * 60);
  assert.deepEqual(sessionReturnChance(gaps, 59 * MINUTE, 59 * MINUTE), {
    idle: 4,
    returns: 1,
    p: wilsonLowerBound(1, 4),
  });
  assert.deepEqual(sessionReturnChance(gaps, 118 * MINUTE, 118 * MINUTE).returns, 2);
  assert.deepEqual(sessionReturnChance(gaps, 11 * HOUR, HOUR), { idle: 1, returns: 0, p: 0 }, 'censored at 12 h');
});

// The plan at refresh point k of a 1h entry (touch = the previous refresh).
const planAt = (k, gaps, prices = tier(OPUS_55, HOUR)) =>
  planCacheWarm({
    now: k * I,
    touchAt: (k - 1) * I,
    ttlMs: HOUR,
    lastCallAt: 1,
    gaps,
    promptTokens: 70_000,
    prices,
  });

test('plan: no history → no warm', () => {
  assert.match(planAt(1, []).stop, /no idle history/);
  assert.match(planAt(1, gapsOf(20, 40)).stop, /no idle history/, 'every gap ended before the refresh point');
});

test('plan: a 3-hourly routine warms from its first recorded gap, through the gap', () => {
  // Opus 5.5 1h, 70k prompt: missCost 0.546, warmCost 0.01402. At the first
  // refresh (e = 59 min) the next return is two intervals off: the
  // per-interval chance is 0, the return within three warms is certain so far.
  const one = gapsOf(179);
  assert.equal(sessionReturnChance(one, I, I).returns, 0, 'no return in the next interval');
  // One gap: P = 1/(1 + z²) = 0.2065 > 3 · 0.01402 / 0.546 = 0.0770.
  assert.deepEqual(planAt(1, one), { warm: true, warms: 3, p: wilsonLowerBound(1, 1) });
  assert.equal(planAt(2, one).warms, 2);
  assert.equal(planAt(3, one).warms, 1);
  assert.match(planAt(4, one).stop, /no idle history/, 'past the rhythm: stop');
});

test('plan: random long gaps never pay', () => {
  const gaps = gapsOf(13 * 60, 14 * 60, 20 * 60, 30 * 60, 16 * 60, 25 * 60, 18 * 60, 22 * 60, 5 * 60, 9 * 60, 11 * 60);
  for (let k = 1; k <= 11; k += 1) {
    assert.equal(planAt(k, gaps).warm, undefined, `refresh point ${k}`);
  }
});

test('plan: fails closed on an unknown fact, a late timer, or the learned window', () => {
  const gaps = gapsOf(179);
  assert.equal(planAt(1, gaps, null).stop, 'prompt size or cache prices unknown');
  assert.match(
    planCacheWarm({
      now: 59 * MINUTE,
      touchAt: 0,
      ttlMs: HOUR,
      lastCallAt: 0,
      gaps,
      promptTokens: 70_000,
      prices: tier(OPUS_55, HOUR),
    }).stop,
    /last real call unknown/
  );
  const base = { ttlMs: HOUR, lastCallAt: 1, gaps, promptTokens: 70_000, prices: tier(OPUS_55, HOUR) };
  assert.match(planCacheWarm({ ...base, now: HOUR - 5_000, touchAt: 0 }).stop, /late/);
  assert.match(planCacheWarm({ ...base, now: HOUR - 20_000, touchAt: 0, latencyMs: 25_000 }).stop, /late/);
  assert.match(planCacheWarm({ ...base, touchAt: 11 * HOUR + 1, now: 11 * HOUR + 1 + I }).stop, /learned window/);
});

test('the switch: on by default; the earlier target list migrates (non-empty → on, empty or off → off)', () => {
  assert.equal(cacheWarmingEnabled({}), true);
  assert.equal(cacheWarmingEnabled({ promptCacheWarming: false }), false);
  assert.equal(promptCacheWarmingSetting({}), true);
  assert.equal(promptCacheWarmingSetting({ cacheWarming: ['scheduled'] }), true);
  assert.equal(promptCacheWarmingSetting({ cacheWarming: [] }), false);
  assert.equal(promptCacheWarmingSetting({ cacheWarming: 'off' }), false);
  assert.equal(promptCacheWarmingSetting({ cacheWarming: 'routine' }), true);
  assert.equal(promptCacheWarmingSetting({ promptCacheWarming: false, cacheWarming: ['scheduled'] }), false);
});

// An in-memory touch store (prompt-cache-touch-store.mjs shape).
function memoryTouches() {
  const map = new Map();
  const uses = new Map();
  return {
    map,
    get: (id) => (map.has(id) ? { ...map.get(id) } : null),
    record: (id, touch) => map.set(id, { ...touch }),
    forget: (id) => map.delete(id),
    ids: () => [...map.keys()],
    lastWarmUse: (id) => uses.get(id) || 0,
    recordWarmUse: (id, at) => uses.set(id, at),
    forgetWarmUse: (id) => uses.delete(id),
  };
}

// A real idle-gap store on its own file, `gaps` (minutes) recorded for
// `sessionId` before `now`.
function gapStore({ sessionId = 'sess_home_lead', minutes = [], now = () => Date.now(), path } = {}) {
  let storePath = path;
  if (!storePath) {
    stores += 1;
    storePath = join(TMP, `gaps-${stores}.json`);
  }
  const store = createIdleGapStore({
    path: storePath,
    lookbackMs: IDLE_RETURN_LOOKBACK_MS,
    windowMs: IDLE_RETURN_MEASURED_WINDOW_MS,
    minMs: cacheWarmDelayMs(5 * MINUTE),
    now,
  });
  gapStores.push(store);
  let at = now() - IDLE_RETURN_LOOKBACK_MS / 2;
  for (const m of minutes) {
    store.open(sessionId, at);
    store.close(sessionId, at + m * MINUTE);
    at += m * MINUTE + MINUTE;
  }
  return store;
}

const AUTO_CLEAR_1H = { enabled: true, idleMs: HOUR, minContextPercent: 10 };
const contextAt = (pct) => ({ usedTokens: pct * 1_000, compaction: { triggerTokens: 100_000 } });

// A driven clock and timer list for chains; the session has learned
// `minutes` gaps (default: a regular 3-hourly rhythm).
function harness({
  inFlight = false,
  reply,
  prices = tier(OPUS_55, HOUR),
  realRegistry = false,
  enabled = true,
  sessionId = 'sess_home_lead',
  minutes = [179, 179, 179],
  gate = null,
} = {}) {
  const touches = memoryTouches();
  const state = { clock: Date.now(), timers: [], usage: [], logs: [], touches, enabled, inFlight };
  state.gaps = gapStore({ sessionId, minutes, now: () => state.clock });
  _setCacheWarmDepsForTest({
    ...(realRegistry ? {} : { registeredProvider: async () => state.prov }),
    now: () => state.clock,
    timers: {
      setTimeout: (fn, delay) => {
        const timer = { fn, at: state.clock + delay };
        state.timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        state.timers = state.timers.filter((t) => t !== timer);
      },
    },
    enabled: async () => state.enabled,
    turnInFlight: () => state.inFlight,
    // `gate`: a promise the planning price lookup waits on.
    prices: async () => {
      if (gate) await gate;
      return prices;
    },
    recordUsage: async (req, usage, startedAt, accountId) => state.usage.push({ req, usage, startedAt, accountId }),
    touches: () => touches,
    gaps: () => state.gaps,
    log: (line) => state.logs.push(line),
  });
  state.prov = provider('anthropic-oauth', reply);
  state.session = homeSession(sessionId);
  state.session.messages = [...PREFIX];
  state.session.lastUsedAt = 0;
  // A main-loop request; `newTurn`: the first of a new returning turn (the
  // ask notes the turn before it).
  state.capture = (session = state.session, { newTurn = true } = {}) => {
    if (newTurn) noteCacheWarmTurn(session.id, 'return');
    return captureSideQuestionRequest({
      sessionId: session.id,
      sessionRef: session,
      provider: state.prov,
      model: MODEL,
      messages: session.messages,
      tools: TOOLS,
      opts: { session, cacheStrategy: CACHE_STRATEGY, effort: 'high' },
    });
  };
  // A real request settling with `response`.
  state.settle = (response = HIT) => {
    state.capture().settle(response);
    state.sentAt = cacheWarmChain(state.session.id)?.touchAt ?? 0;
  };
  state.fire = async (at) => {
    const timer = state.timers.shift();
    state.clock = at ?? timer.at;
    timer.fn();
    await flush();
  };
  return state;
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test.afterEach(() => {
  for (const id of ['sess_home_lead', 'sess_task', 'sess_sub']) forgetSideQuestion(id);
  _setCacheWarmDepsForTest();
});

async function runChain(h, limit = 100) {
  for (let i = 0; i < limit && h.timers.length; i += 1) await h.fire();
}

// Whether the idle auto-clear compacts the harness thread before a submit at
// `at` (the submit gate's own predicate and activity timestamp).
const autoClearsAt = (h, cfg, at) =>
  idleAutoClearDue({
    cfg,
    activityAt: sessionActivityTimestamp(h.session),
    at,
    runtime: { contextStatus: () => contextAt(70), session: h.session },
  });

test('no history: the chain sends nothing and plain auto-clear runs from the last real use', async () => {
  const h = harness({ minutes: [] });
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  h.session.lastUsedAt = start;
  await h.fire();
  assert.equal(h.prov.calls.length, 0);
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.match(h.logs.at(-1), /no idle history/);
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, start + HOUR), true);
});

test('a 3-hourly routine with a 1h auto-clear is warmed at each refresh and not auto-cleared at its run', async () => {
  const h = harness();
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  h.session.lastUsedAt = start;
  await runChain(h);
  // Refreshes at 59, 118 and 177 min; the run at 179 min reads the cache.
  assert.equal(h.prov.calls.length, 3);
  assert.equal(h.touches.lastWarmUse(h.session.id), start + 177 * MINUTE);
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, start + 179 * MINUTE), false, 'the run is not auto-cleared');
  assert.equal(h.session.lastUsedAt, start, 'warms never move the session’s own timestamps');
  h.touches.forgetWarmUse(h.session.id);
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, start + 179 * MINUTE), true, 'without the warm use it would be');
});

test('a missed warm stops the chain and auto-clear runs from the last successful use', async () => {
  let sent = 0;
  const h = harness({
    reply: () =>
      ++sent === 1 ? { cachedTokens: 70_000, cacheWriteTokens: 0 } : { cachedTokens: 0, cacheWriteTokens: 70_000 },
  });
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  h.session.lastUsedAt = start;
  await runChain(h);
  assert.equal(h.prov.calls.length, 2);
  assert.equal(cacheWarmChain(h.session.id), null, 'the miss stopped the chain');
  const lastUse = start + 59 * MINUTE;
  assert.equal(h.touches.lastWarmUse(h.session.id), lastUse, 'the miss is no use');
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, lastUse + HOUR - 1), false);
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, lastUse + HOUR), true);
  h.settle();
  assert.equal(h.touches.lastWarmUse(h.session.id), 0, 'a settled real request is the latest use');
});

test('warms keep a session uncleared up to the learned window, then auto-clear runs normally', async () => {
  // Returns after ~11 h 40 min: worth warming through (11 warms ≤ 0.154 <
  // P · 0.546 with three such gaps); the window ends the chain.
  const h = harness({ minutes: [700, 700, 700] });
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  h.session.lastUsedAt = start;
  for (let k = 1; k <= 11; k += 1) {
    await h.fire();
    assert.equal(h.prov.calls.length, k);
    assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, h.clock + 59 * MINUTE), false, `kept after warm ${k}`);
  }
  await runChain(h);
  assert.equal(h.prov.calls.length, 11);
  assert.equal(cacheWarmChain(h.session.id), null);
  const lastWarm = start + 11 * I;
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, lastWarm + HOUR - 1), false);
  assert.equal(autoClearsAt(h, AUTO_CLEAR_1H, lastWarm + HOUR), true);
});

test('activity: any real request closes the idle gap (a routine fire’s too); warms record none', async () => {
  const h = harness({ minutes: [] });
  h.settle();
  const start = h.gaps.openAt(h.session.id);
  assert.ok(start > 0, 'a settled request opens the gap');
  // No history: no warm. A warm, when it goes out, records nothing either.
  await h.fire();
  assert.equal(h.gaps.openAt(h.session.id), start);
  // The next fire arrives 3 h later: its prompt is the routine header, and
  // it is a return all the same.
  h.clock = start + 3 * HOUR;
  h.session.messages = [
    ...PREFIX,
    { role: 'assistant', content: 'ROUTINE_QUIET' },
    { role: 'user', content: fire(h.clock) },
  ];
  h.capture();
  assert.deepEqual(h.gaps.gaps(h.session.id), [{ at: start, ms: 3 * HOUR }]);
  assert.equal(h.gaps.openAt(h.session.id), 0);

  const warmed = harness({ minutes: [179, 179] });
  warmed.settle();
  const opened = warmed.gaps.openAt(warmed.session.id);
  await warmed.fire();
  assert.equal(warmed.prov.calls.length, 1, 'a warm went out');
  assert.equal(warmed.gaps.openAt(warmed.session.id), opened, 'and is not activity');
  assert.equal(warmed.gaps.gaps(warmed.session.id).length, 2);
});

// The session's request at the harness clock, as the loop sends it: the
// turn opening (`kind`, when it opens one), the capture, then the settle.
function requestAt(h, { newTurn, kind = newTurn ? 'return' : null, prov = h.prov, opts = {} } = {}) {
  const id = h.session.id;
  if (kind) noteCacheWarmTurn(id, kind);
  const req = { ...request({ session: h.session, prov, opts }), sentAt: h.clock };
  noteCacheWarmActivity(id, req);
  armCacheWarm(id, req, HIT);
}

test('gaps run across turn boundaries only: a 10-minute tool run inside a turn is no gap', () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { newTurn: true });
  // A 10-minute tool run, then the same turn's next model call.
  h.clock = t0 + 10 * MINUTE;
  requestAt(h, { newTurn: false });
  assert.deepEqual(h.gaps.gaps(id), [], 'no gap, no return inside the turn');
  assert.equal(h.gaps.openAt(id), t0 + 10 * MINUTE, 'the anchor moved to the turn’s last request');
  // The next turn, 3 h after that request.
  h.clock = t0 + 10 * MINUTE + 3 * HOUR;
  requestAt(h, { newTurn: true });
  assert.deepEqual(h.gaps.gaps(id), [{ at: t0 + 10 * MINUTE, ms: 3 * HOUR }]);
});

test('history is learned on every provider: Anthropic → OpenAI → Anthropic keeps learning', () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { newTurn: true });
  h.clock = t0 + 3 * HOUR;
  requestAt(h, { newTurn: true, prov: provider('openai') });
  assert.equal(cacheWarmChain(id), null, 'no warm armed on a provider without breakpoints');
  assert.equal(h.gaps.openAt(id), t0 + 3 * HOUR, 'but its request anchors the idle clock');
  h.clock = t0 + 6 * HOUR;
  requestAt(h, { newTurn: true });
  assert.deepEqual(h.gaps.gaps(id), [
    { at: t0, ms: 3 * HOUR },
    { at: t0 + 3 * HOUR, ms: 3 * HOUR },
  ]);
  assert.ok(cacheWarmChain(id), 'back on Anthropic: armed again');
});

test('turn kinds: retries continue their turn; Goal and task-notification turns are the runtime’s', () => {
  assert.equal(cacheWarmTurnKind({ prompt: 'hi', promptSource: null }), 'return', 'the user');
  assert.equal(cacheWarmTurnKind({ prompt: '[Routine trigger] …' }), 'return', 'a schedule, webhook or heartbeat');
  assert.equal(cacheWarmTurnKind({ promptSource: null, pendingEntries: [{}] }), 'return', 'a queued agent send');
  assert.equal(cacheWarmTurnKind({ retryFailedTurn: true }), 'continuation', 'a quota resume or retry');
  assert.equal(cacheWarmTurnKind({ retryTurnId: 'm1' }), 'continuation');
  assert.equal(cacheWarmTurnKind({ promptSource: { source: 'task-notification' } }), 'system');
  assert.equal(cacheWarmTurnKind({ promptSource: { source: 'goal-continuation', synthetic: true } }), 'system');
  assert.equal(cacheWarmTurnKind({ promptSource: { source: 'goal-closeout', synthetic: true } }), 'system');
});

test('a channel inbound message, presented as a task notification, closes the gap', () => {
  // Carried from the router through the queues (drain batch, pending group).
  const batch = [makeQueueEntry('[Discord] hi', { source: 'channel', mode: 'task-notification', origin: 'channel' })];
  const options = turnOptionsForBatch(batch, { commitSteeringQueueEntries() {}, releaseSteeringQueueEntries() {} });
  assert.equal(options.promptSource, 'task-notification', 'presented as a task notification');
  assert.equal(options.promptOrigin, PROMPT_ORIGIN_CHANNEL);
  const [group] = _groupPendingMessageEntries([
    pendingMessageQueueEntry({ content: '[Telegram] hi', mode: 'task-notification', origin: 'channel' }),
  ]);
  assert.equal(group.origin, PROMPT_ORIGIN_CHANNEL, 'the headless fallback keeps it too');
  const kind = cacheWarmTurnKind({ promptSource: { source: 'task-notification' }, promptOrigin: options.promptOrigin });
  assert.equal(kind, 'return');
  assert.equal(cacheWarmTurnKind({ promptSource: { source: 'task-notification' } }), 'system', 'a completion notice');
  const h = harness({ minutes: [] });
  const t0 = h.clock;
  requestAt(h, { kind: 'return' });
  h.clock = t0 + 2 * HOUR;
  requestAt(h, { kind });
  assert.deepEqual(h.gaps.gaps(h.session.id), [{ at: t0, ms: 2 * HOUR }]);
});

test('a bot-home wake and a room relay neither close nor move the gap; a user room message after them does', () => {
  const steering = { commitSteeringQueueEntries() {}, releaseSteeringQueueEntries() {} };
  const origin = (entries) => turnOptionsForBatch(entries, steering).promptOrigin;
  // The wake (daemon.mjs, a kickoff) and the relay (agent-room-turn.ts) as the queue takes them.
  const wake = makeQueueEntry('REPORT: done', { mode: 'prompt', kickoff: true, origin: 'agent-report' });
  const relay = makeQueueEntry('Relay them to the room now', { mode: 'prompt', origin: 'agent-report' });
  const user = makeQueueEntry('how far along?', { mode: 'prompt' });
  assert.equal(origin([wake]), PROMPT_ORIGIN_AGENT_REPORT);
  assert.equal(origin([relay]), PROMPT_ORIGIN_AGENT_REPORT);
  assert.equal(origin([relay, user]), undefined, 'a user prompt merged into it is the user speaking');
  assert.equal(origin([user]), undefined);
  // The core's queued fallback keeps it too (ask-queue: promptOriginOf).
  const kinds = [wake, relay, user].map((entry) =>
    cacheWarmTurnKind({
      promptSource: turnOptionsForBatch([entry], steering).promptSource,
      promptOrigin: origin([entry]),
    })
  );
  assert.deepEqual(kinds, ['system', 'system', 'return']);
  const h = harness({ minutes: [] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { kind: 'return' });
  h.clock = t0 + HOUR;
  requestAt(h, { kind: kinds[0] });
  assert.equal(h.gaps.openAt(id), t0, 'the wake did not move the anchor');
  h.clock = t0 + 2 * HOUR;
  requestAt(h, { kind: kinds[1] });
  assert.equal(h.gaps.openAt(id), t0, 'nor did the relay');
  assert.deepEqual(h.gaps.gaps(id), [], 'neither closed the gap');
  h.clock = t0 + 3 * HOUR;
  requestAt(h, { kind: kinds[2] });
  assert.deepEqual(h.gaps.gaps(id), [{ at: t0, ms: 3 * HOUR }], 'measured from the last real activity');
});

test('a retry keeps the failed turn’s provenance: system stays system, real is a continuation', () => {
  // One turn as the runtime stores it: its prompt (meta.source / origin and
  // the transcript identity of its attempt), optionally partial output, and
  // on failure the settle path's completion on the last message.
  let attempts = 0;
  const turn = (messages, meta, { output = false, fail = true } = {}) => {
    attempts += 1;
    const transcript = { messageId: `m${attempts}`, attemptId: `a${attempts}`, at: attempts * 1000 };
    messages.push({ role: 'user', content: `prompt ${attempts}`, meta: { ...meta, transcript } });
    if (output) {
      messages.push({ role: 'assistant', content: 'half an answer', tool_calls: [{ id: `c${attempts}` }] });
      messages.push({ role: 'tool', tool_call_id: `c${attempts}`, content: 'tool output' });
    }
    if (fail) {
      assert.equal(
        attachFailedTurnCompletion(messages, { status: 'failed', attemptId: transcript.attemptId, at: transcript.at }),
        true
      );
    }
    return transcript;
  };
  const session = () => [{ role: 'system', content: 'You are the Lead.' }];
  const CONTINUE = { retryFailedTurn: true, prompt: 'Continue from where you left off.' };
  for (const source of ['goal-continuation', 'goal-closeout', 'task-notification']) {
    // No output: the failure sits on the prompt (retained retry by id, or the resubmitted prompt).
    const bare = session();
    const { messageId } = turn(bare, { source });
    assert.equal(cacheWarmTurnKind({ retryTurnId: messageId }, bare), 'system', `${source} by id`);
    assert.equal(cacheWarmTurnKind({ retryFailedTurn: true, prompt: 'prompt' }, bare), 'system', `${source} rebuilt`);
    // Partial output: the failure sits on the tool result; the prompt is found by its attempt.
    const sampled = session();
    turn(sampled, { source }, { output: true });
    assert.equal(cacheWarmTurnKind(CONTINUE, sampled), 'system', `${source} with partial output`);
  }
  // A real turn with partial output after an older failed Goal turn.
  const mixed = session();
  turn(mixed, { source: 'goal-continuation' }, { output: true });
  turn(mixed, {}, { output: true });
  assert.equal(cacheWarmTurnKind(CONTINUE, mixed), 'continuation', 'the older Goal failure is not this turn');
  // The turn start identifies the prompt when the attempt carries no id.
  const byStart = session();
  byStart.push({ role: 'user', content: 'goal', meta: { source: 'goal-continuation', transcript: { at: 5 } } });
  byStart.push({ role: 'assistant', content: 'half' });
  attachFailedTurnCompletion(byStart, { status: 'failed', attemptId: 'x', at: 5 });
  assert.equal(cacheWarmTurnKind(CONTINUE, byStart), 'system');
  // A rebuilt retry message records the provenance it continued.
  const rebuilt = session();
  turn(rebuilt, { provenance: { source: 'task-notification' } }, { output: true });
  assert.equal(cacheWarmTurnKind(CONTINUE, rebuilt), 'system');
  const real = session();
  const { messageId } = turn(real, {});
  assert.equal(cacheWarmTurnKind({ retryTurnId: messageId }, real), 'continuation', 'a user turn');
  const channel = session();
  turn(channel, { source: 'task-notification', origin: 'channel' }, { output: true });
  assert.equal(cacheWarmTurnKind(CONTINUE, channel), 'continuation', 'a channel message');
  // An agent report (wake / relay) stays the runtime's through retries.
  const report = session();
  turn(report, { origin: 'agent-report' }, { output: true });
  assert.equal(cacheWarmTurnKind(CONTINUE, report), 'system', 'a failed wake');
  const reportRebuilt = session();
  turn(reportRebuilt, { provenance: { origin: 'agent-report' } });
  assert.equal(cacheWarmTurnKind({ retryFailedTurn: true, prompt: 'x' }, reportRebuilt), 'system', 'retried again');
  const settled = session();
  turn(settled, { source: 'task-notification' }, { fail: false });
  assert.equal(cacheWarmTurnKind(CONTINUE, settled), 'continuation', 'no failed turn to continue');
});

test('a system-caused turn neither closes nor moves the gap; the planner counts from the real anchor', async () => {
  const h = harness({ minutes: [179, 179, 179] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { kind: 'return' });
  for (const source of ['task-notification', 'goal-continuation']) {
    h.clock += 30 * MINUTE;
    requestAt(h, { kind: cacheWarmTurnKind({ promptSource: { source } }) });
    assert.equal(h.gaps.openAt(id), t0, `${source}: the anchor stays at the last real request`);
  }
  assert.equal(h.gaps.gaps(id).length, 3, 'no gap closed');
  // The chain armed from the last (system) request refreshes from its cache
  // use, but its idle time counts from the real anchor: 60 + 59 min at the
  // first refresh, past the 2 h 59 min rhythm's second interval.
  const chain = cacheWarmChain(id);
  assert.equal(chain.touchAt, t0 + HOUR);
  await h.fire();
  assert.equal(h.prov.calls.length, 1, 'the return is still ahead: warm');
  // A real turn closes the gap at its start, measured from the real anchor.
  h.clock = t0 + 3 * HOUR;
  requestAt(h, { kind: 'return' });
  assert.deepEqual(h.gaps.gaps(id).at(-1), { at: t0, ms: 3 * HOUR });
});

// A summary in the compaction format the runner accepts.
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

test('a compaction (summary + resend) between two user turns neither closes nor shortens the gap', async () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  h.session.messages = [
    { role: 'system', content: 'You are the Lead.' },
    ...Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `TURN_${i} `.padEnd(1_600, '.'),
    })),
    { role: 'user', content: 'Refactor the parser.' },
  ];
  let summaries = 0;
  h.prov.send = async () => {
    summaries += 1;
    return { content: SUMMARY, usage: { inputTokens: 900, cachedTokens: 30_000, outputTokens: 400 } };
  };
  h.settle();
  const anchor = h.gaps.openAt(id);
  const compact = () =>
    runFreshContextCompact({
      sessionRef: {
        id,
        provider: h.prov.name,
        model: MODEL,
        contextWindow: 200_000,
        compaction: { conversationThresholdTokens: 1 },
      },
      messages: h.session.messages,
      provider: h.prov,
      model: MODEL,
      compactBudgetTokens: 50_000,
      compactPolicy: { contextWindow: 200_000 },
      config: {},
      initProvidersFn: async () => {},
      getProviderFn: () => h.prov,
      sendOpts: {},
    });
  // An idle compaction an hour in: its summary request is the runtime's.
  h.clock = anchor + HOUR;
  const result = await compact();
  assert.equal(summaries, 1, 'the summary request went out');
  assert.ok(result.messages.some((m) => String(m.content).includes('continue the parser refactor')));
  assert.equal(h.gaps.openAt(id), anchor, 'the summary did not move the anchor');
  assert.deepEqual(h.gaps.gaps(id), [], 'nor close the gap');
  // The next user turn 3 h in compacts before it sends; its resend goes out
  // 2 min later and closes the gap at the turn's start.
  h.clock = anchor + 3 * HOUR;
  noteCacheWarmTurn(id, 'return');
  h.clock += 2 * MINUTE;
  requestAt(h, {});
  assert.deepEqual(h.gaps.gaps(id), [{ at: anchor, ms: 3 * HOUR }]);
});

test('title generation never reaches the idle learning', async () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  requestAt(h, { kind: 'return' });
  const anchor = h.gaps.openAt(id);
  const titleCalls = [];
  const generate = createTitleCompletion({
    loadConfig: () => ({ providers: {} }),
    resolveMaintenanceRoute: () => ({ provider: 'anthropic-oauth', model: MODEL }),
    initProviders: async () => {},
    getProvider: () => ({
      send: async (...args) => {
        titleCalls.push(args);
        return { content: 'Parser refactor' };
      },
    }),
  });
  h.clock += HOUR;
  assert.equal(await generate('Refactor the parser.'), 'Parser refactor');
  assert.equal(titleCalls.length, 1);
  assert.equal(h.gaps.openAt(id), anchor);
  assert.deepEqual(h.gaps.gaps(id), []);
});

test('a quota resume continues its turn: no new return; the next real turn is measured from it', () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { kind: 'return' });
  // The turn failed on quota; the scheduler resumes it 3 h later.
  h.clock = t0 + 3 * HOUR;
  requestAt(h, { kind: cacheWarmTurnKind({ retryFailedTurn: true, retryTurnId: 'm1' }) });
  assert.deepEqual(h.gaps.gaps(id), [], 'the resume is not a return');
  assert.equal(h.gaps.openAt(id), t0 + 3 * HOUR, 'its requests are the real turn’s');
  h.clock = t0 + 5 * HOUR;
  requestAt(h, { kind: 'return' });
  assert.deepEqual(h.gaps.gaps(id), [{ at: t0 + 3 * HOUR, ms: 2 * HOUR }]);
});

test('a heartbeat or scheduled turn still closes the gap', () => {
  const h = harness({ minutes: [] });
  const id = h.session.id;
  const t0 = h.clock;
  requestAt(h, { kind: 'return' });
  // A heartbeat runs as a routine turn (routine-home-turn.mjs): no promptSource.
  h.clock = t0 + 2 * HOUR;
  requestAt(h, { kind: cacheWarmTurnKind({ prompt: '[Routine trigger] Heartbeat: …', promptSource: null }) });
  h.clock = t0 + 5 * HOUR;
  requestAt(h, { kind: cacheWarmTurnKind({ prompt: '[Routine trigger] Your schedule "monitor" fired.' }) });
  assert.deepEqual(h.gaps.gaps(id), [
    { at: t0, ms: 2 * HOUR },
    { at: t0 + 2 * HOUR, ms: 3 * HOUR },
  ]);
});

test('gap store: censored at the window, short gaps dropped, persisted across a restart, pruned, deleted', async () => {
  const path = join(TMP, 'gap-persist.json');
  let clock = Date.UTC(2026, 9, 20);
  const store = gapStore({ path, now: () => clock });
  store.open('s', clock);
  assert.equal(store.close('s', clock + 13 * HOUR).censored, true, 'a 13 h gap is censored at 12 h');
  store.open('s', clock + 14 * HOUR);
  assert.equal(store.close('s', clock + 14 * HOUR + 60_000), null, 'shorter than any refresh interval');
  store.open('s', clock + 15 * HOUR);
  await store.flush();
  const reloaded = gapStore({ path, now: () => clock });
  assert.deepEqual(reloaded.gaps('s'), [{ at: clock, ms: IDLE_RETURN_MEASURED_WINDOW_MS, censored: true }]);
  assert.equal(reloaded.openAt('s'), clock + 15 * HOUR, 'the open gap survives the restart');
  // Eight days on, the old gap ages out of the lookback.
  clock += 8 * 24 * HOUR;
  assert.deepEqual(reloaded.gaps('s'), []);
  await reloaded.flush();
  assert.deepEqual(gapStore({ path, now: () => clock }).gaps('s'), []);

  // A deleted session drops what it learned (the purge hook).
  const h = harness({ minutes: [179] });
  assert.equal(h.gaps.gaps(h.session.id).length, 1);
  _runSessionPurgeHooks(h.session.id);
  assert.deepEqual(h.gaps.gaps(h.session.id), []);
});

test('the switch off: no warm; sub-agent sessions are captured for the warmer but not for /btw', async () => {
  let h = harness({ enabled: false });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 0);
  assert.match(h.logs.at(-1), /cache warming off/);

  h = harness({ sessionId: 'sess_sub' });
  h.session.owner = 'agent';
  assert.ok(h.capture(), 'a sub-agent request reaches the warmer');
  h.capture().settle(HIT);
  assert.ok(cacheWarmChain('sess_sub'), 'and arms like any session');
});

test('a warm adds nothing to the transcript and is no session activity, and re-arms on a hit', async () => {
  const h = harness();
  const activity = [];
  const offActivity = onSessionActivityChange((id) => activity.push(['activity', id]));
  const offTurn = onSessionTurnStart((id) => activity.push(['turn', id]));
  try {
    const handle = h.capture(h.session, { newTurn: false });
    assert.equal(cacheWarmChain(h.session.id), null, 'nothing is armed while the request is in flight');
    handle.settle(HIT);
    const chain = cacheWarmChain(h.session.id);
    assert.ok(chain, 'armed');
    assert.equal(chain.ttlMs, HOUR);
    assert.equal(chain.accountId, ACCOUNT, 'the account that served the request');
    const firstTouch = chain.touchAt;
    const before = JSON.stringify(h.session);
    await h.fire(firstTouch + 54 * MINUTE);

    assert.equal(h.prov.calls.length, 1);
    assert.equal(h.prov.calls[0].opts.maxOutputTokensOverride, 1);
    assert.equal(h.prov.calls[0].hooks.accountId, ACCOUNT);
    assert.deepEqual(h.prov.accounts, [ACCOUNT], 'sent on the account holding the entry');
    assert.deepEqual(h.prov.calls[0].messages.slice(0, PREFIX.length), PREFIX);
    assert.equal(h.prov.sends, 0, 'never the admission/quota send path');
    assert.equal(JSON.stringify(h.session), before, 'transcript, lastProviderSendAt, lastUsedAt and usage untouched');
    assert.deepEqual(activity, [], 'no activity or turn-start signal (heartbeat idle, autoClear, last-used)');
    assert.equal(h.usage.length, 1, 'its own usage row');
    assert.equal(h.usage[0].accountId, ACCOUNT);
    assert.equal(cacheWarmChain(h.session.id).touchAt, firstTouch + 54 * MINUTE, 'a hit re-arms from the warm');
  } finally {
    offActivity();
    offTurn();
  }
});

test('arming needs a send time, a proven tier, the prompt size and (on a roster) the serving account', async () => {
  let h = harness();
  h.touches.record(h.session.id, { touchAt: 1, ttlMs: HOUR, promptTokens: 5 });
  h.capture().settle({ ...HIT, usage: { cachedTokens: 70_000 } });
  assert.equal(cacheWarmChain(h.session.id), null, 'a read-only response proves no tier');
  assert.equal(h.touches.get(h.session.id), null, 'and the stale touch is dropped');

  h = harness();
  h.touches.record(h.session.id, { touchAt: 1, ttlMs: HOUR, promptTokens: 5 });
  armCacheWarm(h.session.id, { ...request({ session: h.session, prov: h.prov }), sentAt: 0 }, HIT);
  assert.equal(cacheWarmChain(h.session.id), null, 'no send time: no chain, never "now"');
  assert.equal(h.touches.get(h.session.id), null);

  armCacheWarm(h.session.id, { ...request({ session: h.session, prov: h.prov }), sentAt: 5 }, { ...HIT, usage: {} });
  assert.equal(cacheWarmChain(h.session.id), null, 'no usage: no tier and no prompt size');

  h = harness();
  h.settle({ usage: HIT.usage });
  const unrouted = cacheWarmChain(h.session.id);
  await h.fire(unrouted.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'no recorded account: no warm on whatever account is current');
  assert.match(h.logs.at(-1), /account holding the cache unknown/);
});

test('a failed or canceled warm is still billed; a new real request aborts the warm in flight', async () => {
  let h = harness({
    reply: () => {
      throw Object.assign(new Error('stream lost'), { usage: { cachedTokens: 70_000, cacheWriteTokens: 0 } });
    },
  });
  h.settle();
  let chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.usage.length, 1, 'billed on failure');
  assert.equal(h.usage[0].usage.cachedTokens, 70_000);
  assert.equal(cacheWarmChain(h.session.id), null, 'a failure stops the chain');

  let signal;
  h = harness({
    reply: (opts, hooks) =>
      new Promise((_resolve, reject) => {
        signal = opts.signal;
        hooks.onUsage({ cachedTokens: 70_000, cacheWriteTokens: 0 });
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      }),
  });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.ok(signal && !signal.aborted, 'the warm is in flight');
  h.capture();
  await flush();
  assert.equal(signal.aborted, true, 'a real request aborts the warm in flight');
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.equal(h.usage.length, 1, 'the aborted warm is billed');
});

test('a turn starting during the warm’s planning lookups: no warm is sent', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let h = harness({ gate });
  h.settle();
  let chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'still planning');
  noteCacheWarmTurn(h.session.id, 'return');
  release();
  await flush();
  assert.equal(h.prov.calls.length, 0, 'the turn entering cancelled the warm');
  assert.equal(h.usage.length, 0);
  assert.equal(h.touches.lastWarmUse(h.session.id), 0, 'no cache use');

  // A turn the entry hook never saw (activity reported by the runtime only):
  // the check right before dispatch still stops the warm.
  h = harness({ gate: new Promise((resolve) => (release = resolve)) });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  h.inFlight = true;
  release();
  await flush();
  assert.equal(h.prov.calls.length, 0, 'a turn in flight before dispatch sends nothing');
  assert.equal(cacheWarmChain(h.session.id), null);
});

test('a turn starting while a warm is in flight aborts it; the chain re-arms normally after the turn', async () => {
  let signal;
  let hang = true;
  const h = harness({
    reply: (opts, hooks) => {
      if (!hang) return { cachedTokens: 70_000, cacheWriteTokens: 0 };
      return new Promise((_resolve, reject) => {
        signal = opts.signal;
        hooks.onUsage({ cachedTokens: 70_000, cacheWriteTokens: 0 });
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
    },
  });
  h.settle();
  const chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.ok(signal && !signal.aborted, 'the warm is in flight');
  const turn = noteCacheWarmTurn(h.session.id, 'return');
  assert.equal(signal.aborted, true, 'the turn entering aborts the warm on the wire');
  await flush();
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.equal(h.usage.length, 1, 'the aborted warm is billed');
  assert.equal(h.touches.lastWarmUse(h.session.id), 0, 'and is no cache use');
  assert.ok(!h.logs.some((line) => /warm failed|missed the cache/.test(line)), 'the abort is no miss or failure');

  // The turn's own request settles: the chain arms again and warms.
  hang = false;
  h.clock += 5 * MINUTE;
  requestAt(h, {});
  endCacheWarmTurn(h.session.id, turn);
  const rearmed = cacheWarmChain(h.session.id);
  assert.ok(rearmed, 're-armed after the turn');
  await h.fire(rearmed.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 2, 'the next warm goes out');
  assert.ok(h.touches.lastWarmUse(h.session.id) > 0);
  assert.ok(cacheWarmChain(h.session.id), 'and the chain continues');
});

test('a turn that ends without sending restores the chain on its original schedule; a sending turn re-arms from its request', async () => {
  const h = harness();
  const id = h.session.id;
  h.settle();
  const original = cacheWarmChain(id);
  const { request: captured, touchAt, refreshAt } = original;
  const touchSnapshot = JSON.stringify([...h.touches.map]);
  const gapSnapshot = JSON.stringify([h.gaps.openAt(id), h.gaps.gaps(id)]);
  assert.equal(h.timers[0].at, refreshAt);

  // A turn enters and ends (setup failure, quota refusal, a command) with no request.
  h.clock = touchAt + 10 * MINUTE;
  let turn = noteCacheWarmTurn(id, 'return');
  assert.equal(cacheWarmChain(id), null, 'the entering turn stops the chain');
  assert.equal(h.timers.length, 0);
  endCacheWarmTurn(id, turn);
  const restored = cacheWarmChain(id);
  assert.ok(restored && restored !== original, 'a fresh chain is back');
  assert.equal(restored.request, captured);
  assert.equal(restored.touchAt, touchAt, 'the original touch');
  assert.equal(restored.refreshAt, refreshAt, 'the original schedule');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].at, refreshAt);
  assert.equal(JSON.stringify([...h.touches.map]), touchSnapshot, 'the touch store is untouched');
  assert.equal(JSON.stringify([h.gaps.openAt(id), h.gaps.gaps(id)]), gapSnapshot, 'so is the idle-gap store');
  await h.fire();
  assert.equal(h.prov.calls.length, 1, 'the restored chain warms');

  // A turn that sends: the chain re-arms from its request, nothing is restored.
  turn = noteCacheWarmTurn(id, 'return');
  h.clock += 20 * MINUTE;
  requestAt(h, {});
  const sentAt = h.clock;
  endCacheWarmTurn(id, turn);
  assert.equal(cacheWarmChain(id).touchAt, sentAt, 'armed from the turn’s own request');
  assert.equal(h.timers.length, 1);
});

test('a turn ending after an invalidation, a close or the entry’s expiry restores nothing', () => {
  const h = harness();
  const id = h.session.id;
  const ends = (invalidate) => {
    h.settle();
    const { touchAt, ttlMs } = cacheWarmChain(id);
    h.clock = touchAt + 10 * MINUTE;
    const turn = noteCacheWarmTurn(id, 'return');
    invalidate({ touchAt, ttlMs });
    endCacheWarmTurn(id, turn);
    return cacheWarmChain(id);
  };
  assert.equal(
    ends(() => retireCompactionFork(id)),
    null,
    'compaction'
  );
  assert.equal(
    ends(() => forgetSideQuestion(id)),
    null,
    'clear / rewind'
  );
  assert.equal(
    ends(() => forgetSideQuestion(id, { cancel: true })),
    null,
    'close'
  );
  assert.equal(
    ends(({ touchAt, ttlMs }) => {
      h.clock = touchAt + ttlMs - CACHE_WARM_EXPIRY_MARGIN_MS;
    }),
    null,
    'expired'
  );
  assert.equal(h.timers.length, 0);
});

test('the chain stops on a miss, a late timer, a turn in flight, a new request or a compaction', async () => {
  let h = harness({ reply: { cachedTokens: 0, cacheWriteTokens: 70_000 } });
  h.settle();
  let chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(cacheWarmChain(h.session.id), null, 'one miss stops');
  assert.equal(h.usage.length, 1, 'the missed warm is billed');

  h = harness();
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + HOUR - 5_000);
  assert.equal(h.prov.calls.length, 0, 'a timer firing inside the expiry margin sends nothing');
  assert.equal(cacheWarmChain(h.session.id), null);

  h = harness({ inFlight: true });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'a turn in flight sends nothing');

  h = harness({ prices: tier(OPUS_55, HOUR), minutes: [13 * 60, 14 * 60, 9 * 60] });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'returns too rare: the warms cost more than the expected miss');

  h = harness();
  h.settle();
  h.capture();
  assert.equal(cacheWarmChain(h.session.id), null, 'a new real request cancels the chain');
  assert.equal(h.timers.length, 0);

  h = harness();
  h.settle();
  retireCompactionFork(h.session.id);
  assert.equal(cacheWarmChain(h.session.id), null, 'a compaction cancels the chain');
});

test('a provider instance replaced in the registry stops the chain instead of replaying on the old one', async () => {
  let h = harness({ realRegistry: true });
  h.settle();
  let chain = cacheWarmChain(h.session.id);
  await _withRegisteredProviderForTestAsync('anthropic-oauth', h.prov, () => h.fire(chain.touchAt + 54 * MINUTE));
  assert.equal(h.prov.calls.length, 1);

  h = harness({ realRegistry: true });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  const replacement = provider('anthropic-oauth');
  await _withRegisteredProviderForTestAsync('anthropic-oauth', replacement, () => h.fire(chain.touchAt + 54 * MINUTE));
  assert.equal(h.prov.calls.length, 0, 'the old instance is not used');
  assert.equal(replacement.calls.length, 0, 'the old request is not substituted onto the new one');
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.match(h.logs.at(-1), /provider instance replaced/);
});

test('after a restart, re-arm uses the durable touch and drops one inside the expiry margin', async () => {
  const h = harness();
  const now = Date.UTC(2026, 9, 26, 0, 30);
  h.clock = now;
  const rebuilt = (session = homeSession()) => ({ ...request({ session, prov: h.prov }), sentAt: now - 50 * MINUTE });
  const records = {
    sess_home_lead: rebuilt(),
    'sess_home_bot-a': rebuilt(homeSession('sess_home_bot-a')),
    'sess_home_bot-b': { ...rebuilt(homeSession('sess_home_bot-b')), provider: provider('openai') },
    'sess_home_bot-d': rebuilt(homeSession('sess_home_bot-d')),
  };
  const touches = memoryTouches();
  touches.record('sess_home_lead', {
    touchAt: now - 20 * MINUTE,
    ttlMs: HOUR,
    promptTokens: 71_000,
    accountId: 'acct-2',
  });
  touches.record('sess_home_bot-a', { touchAt: now - 20 * MINUTE, ttlMs: 5 * MINUTE, promptTokens: 70_000 });
  touches.record('sess_home_bot-b', { touchAt: now - 5 * MINUTE, ttlMs: HOUR, promptTokens: 70_000 });
  touches.record('sess_home_bot-d', { touchAt: now - HOUR + 5_000, ttlMs: HOUR, promptTokens: 70_000 });
  let providersReady = 0;
  _setCacheWarmDepsForTest({
    now: () => h.clock,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    enabled: async () => true,
    lastSentRequest: async (id) => records[id] || null,
    providersReady: async () => {
      providersReady += 1;
    },
    touches: () => touches,
    log() {},
  });
  assert.equal(await rearmCacheWarmsAfterRestart(), 1);
  assert.equal(providersReady, 1, 'the providers are registered before any request is rebuilt');
  const chain = cacheWarmChain('sess_home_lead');
  assert.equal(chain.touchAt, now - 20 * MINUTE, 'from the last confirmed cache use, not the send');
  assert.equal(chain.ttlMs, HOUR, 'the tier the provider wrote');
  assert.equal(chain.promptTokens, 71_000);
  assert.equal(chain.accountId, 'acct-2', 'on the account holding the entry');
  assert.equal(touches.get('sess_home_bot-a'), null, 'an expired touch is dropped');
  assert.equal(cacheWarmChain('sess_home_bot-b'), null, 'an ineligible provider is not re-armed');
  assert.equal(touches.get('sess_home_bot-d'), null, 'a touch inside the expiry margin is dropped');
});

test('after a restart, nothing is re-armed while warming is off', async () => {
  const now = Date.UTC(2026, 9, 26, 0, 30);
  const touches = memoryTouches();
  touches.record('sess_task', { touchAt: now - 20 * MINUTE, ttlMs: HOUR, promptTokens: 70_000, accountId: ACCOUNT });
  let enabled = false;
  _setCacheWarmDepsForTest({
    now: () => now,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    enabled: async () => enabled,
    lastSentRequest: async () => ({ ...request({ session: homeSession('sess_task') }), sentAt: now - 50 * MINUTE }),
    providersReady: async () => {},
    touches: () => touches,
    log() {},
  });
  assert.equal(await rearmCacheWarmsAfterRestart(), 0);
  enabled = true;
  assert.equal(await rearmCacheWarmsAfterRestart(), 1);
  assert.equal(cacheWarmChain('sess_task').touchAt, now - 20 * MINUTE);
});

test('restart re-arm waits for the owning runtime’s provider init and never initializes providers', async () => {
  const now = Date.UTC(2026, 9, 26, 0, 30);
  const touches = memoryTouches();
  touches.record('sess_home_lead', {
    touchAt: now - 20 * MINUTE,
    ttlMs: HOUR,
    promptTokens: 70_000,
    accountId: ACCOUNT,
  });
  let rebuilt = 0;
  _setCacheWarmDepsForTest({
    now: () => now,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    enabled: async () => true,
    lastSentRequest: async () => {
      rebuilt += 1;
      return { ...request(), sentAt: now - 50 * MINUTE };
    },
    touches: () => touches,
    log() {},
  });
  const before = _initProvidersCallCountForTest();
  let settled = false;
  void rearmCacheWarmsAfterRestart().then(() => {
    settled = true;
  });
  await flush();
  assert.equal(_initProvidersCallCountForTest(), before, 'the warmer never calls initProviders');
  assert.equal(settled, false, 'it waits for the runtime’s own initialization');
  assert.equal(rebuilt, 0, 'no request is rebuilt before the providers are registered');
  assert.equal(cacheWarmChain('sess_home_lead'), null);
});

test('the touch store survives a reload, drops expired entries and keeps a warm use beyond its touch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-touch-'));
  try {
    const path = join(dir, 'touches.json');
    const store = createPromptCacheTouchStore(path);
    store.record('alive', { touchAt: Date.now(), ttlMs: HOUR, promptTokens: 5, accountId: 'a' });
    store.record('expired', { touchAt: Date.now() - 2 * HOUR, ttlMs: HOUR, promptTokens: 5 });
    store.record('invalid', { touchAt: Date.now(), ttlMs: 0, promptTokens: 5 });
    store.recordWarmUse('expired', Date.now() - 2 * HOUR);
    await store.flush();
    const reloaded = createPromptCacheTouchStore(path);
    assert.equal(reloaded.get('alive').accountId, 'a');
    assert.equal(reloaded.get('expired'), null);
    assert.equal(reloaded.get('invalid'), null);
    assert.ok(reloaded.lastWarmUse('expired') > 0, 'the warm use outlives its touch');
    reloaded.forgetWarmUse('expired');
    await reloaded.flush();
    assert.equal(createPromptCacheTouchStore(path).lastWarmUse('expired'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real request, a hit and a miss keep the durable touch current; compaction drops it', async () => {
  let h = harness();
  h.settle();
  const touch = h.touches.get(h.session.id);
  assert.equal(touch.ttlMs, HOUR, 'the written 1h tier');
  assert.equal(touch.promptTokens, 70_000);
  assert.equal(touch.accountId, ACCOUNT);
  await h.fire(touch.touchAt + 54 * MINUTE);
  assert.equal(h.touches.get(h.session.id).touchAt, touch.touchAt + 54 * MINUTE, 'a hit moves the touch');
  retireCompactionFork(h.session.id);
  assert.equal(h.touches.get(h.session.id), null, 'compaction drops it');

  h = harness({ reply: { cachedTokens: 0, cacheWriteTokens: 70_000 } });
  h.settle();
  await h.fire(h.touches.get(h.session.id).touchAt + 54 * MINUTE);
  assert.equal(h.touches.get(h.session.id), null, 'a miss drops it');
});
