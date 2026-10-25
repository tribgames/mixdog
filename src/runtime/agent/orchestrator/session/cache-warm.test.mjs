// Cache warms (cache-warm.mjs): the warm re-sends the last real request with
// a byte-identical cacheable prefix through the provider's warm mode, never
// touches the transcript or session activity, is billed in the ledger
// whatever happens, and only runs toward a known turn when the expected miss
// outweighs the warms. The provider's warm mode and its account gate are
// covered in providers/cache-warm-admission.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _buildRequestBodyForCacheSmoke } from '../providers/anthropic-oauth.mjs';
import { _initProvidersCallCountForTest, _withRegisteredProviderForTestAsync } from '../providers/registry.mjs';
import { readCacheWarmStream } from '../providers/anthropic-cache-warm.mjs';
import { onSessionActivityChange, onSessionTurnStart } from '../../../shared/session-activity-signal.mjs';
import { routineTriggerHeader } from '../../../shared/routine-trigger.mjs';
import { autoClearGateSettings } from '../runtime-core/config-helpers.mjs';
import {
  _setCacheWarmDepsForTest,
  armCacheWarm,
  CACHE_WARM_EXPIRY_MARGIN_MS,
  cacheWarmChain,
  cacheWarmDelayMs,
  cacheWarmEconomics,
  cacheWarmIneligibility,
  cacheWarmRemainingWarms,
  cacheWarmSend,
  cacheWarmSessionKinds,
  IDLE_RETURN_MEASURED_WINDOW_MS,
  IDLE_RETURN_PROBABILITY,
  idleReturnProbability,
  nextRoutineFireFor,
  planCacheWarm,
  planIdleCacheWarm,
  rearmCacheWarmsAfterRestart,
  resolveCacheWarmTargets,
  revalidateCacheWarms,
  ROUTINE_TURN_HIT_PROBABILITY,
  writtenCacheTtlMs,
} from './cache-warm.mjs';
import { normalizeCacheWarmTargets, parseCacheWarmTargetsEnv } from '../../../shared/cache-warm-targets.mjs';
import { createPromptCacheTouchStore } from './prompt-cache-touch-store.mjs';
import { captureSideQuestionRequest, forgetSideQuestion, retireCompactionFork } from './side-question-store.mjs';
import { withTailReminder } from './tail-reminder-rules.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MODEL = 'claude-opus-4-7';
const ACCOUNT = 'acct-1';
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
const CACHE_STRATEGY = { tools: 'none', system: '1h', tier3: '1h', messages: '1h' };
const HIT = {
  usage: { cachedTokens: 69_000, cacheWriteTokens: 1_000, cacheWrite1hTokens: 1_000 },
  providerMetadata: { accountRouting: { provider: 'anthropic-oauth', accountId: ACCOUNT } },
};

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

const stripMarkers = (value) => JSON.parse(JSON.stringify(value), (key, v) => (key === 'cache_control' ? undefined : v));
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

  // The next production routine turn: the reply, then the next fire's prompt
  // with its own trigger header, after the tail breakpoint.
  const nextMessages = withTailReminder(
    [...req.messages, { role: 'assistant', content: 'ROUTINE_QUIET' }, { role: 'user', content: fire(Date.UTC(2026, 9, 26)) }],
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
  assert.ok(JSON.stringify(warm.messages[markIndex]).includes('Check the feed.'), 'the breakpoint closes the last fire');
});

function sseResponse(frames, { open = false } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
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
  message: { usage: { input_tokens: 3, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 0, output_tokens: 1 } },
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

  // An error type outside the documented set gets no invented status: the
  // providers' shared SSE error contract marks it a wire error.
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
  assert.equal(writtenCacheTtlMs({ cacheWriteTokens: 900, cacheWrite1hTokens: 900 }, tail5m), HOUR, 'one tier: the tail’s');
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
const OPUS_47 = { read: 0.5 / M, write5m: 6.25 / M, write1h: 10 / M, output: 25 / M };
const tier = (model, ttl) => ({
  read: model.read,
  write: ttl === HOUR ? model.write1h : model.write5m,
  output: model.output,
});

// The largest number of remaining warms the rule allows.
function maxWarms(model, ttl, promptTokens = 70_000) {
  const { warmCost, missCost } = cacheWarmEconomics(promptTokens, tier(model, ttl));
  return Math.ceil((ROUTINE_TURN_HIT_PROBABILITY * missCost) / warmCost) - 1;
}

test('economics: a read plus one output token per warm against a tier write minus the read', () => {
  const { warmCost, missCost } = cacheWarmEconomics(70_000, tier(OPUS_55, HOUR));
  assert.ok(Math.abs(warmCost - (0.014 + 20 / M)) < 1e-12);
  assert.ok(Math.abs(missCost - 0.546) < 1e-12);
  assert.equal(cacheWarmEconomics(0, tier(OPUS_55, HOUR)), null, 'unknown prompt size');
  assert.equal(cacheWarmEconomics(70_000, null), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), read: null }), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), write: null }), null);
  assert.equal(cacheWarmEconomics(70_000, { ...tier(OPUS_55, HOUR), output: undefined }), null);
  assert.equal(maxWarms(OPUS_55, HOUR), 21);
  assert.equal(maxWarms(OPUS_55, 5 * MINUTE), 13);
  assert.equal(maxWarms(OPUS_47, HOUR), 10);
  assert.equal(maxWarms(OPUS_47, 5 * MINUTE), 6);
});

test('remaining warms: this one plus one per further interval to the due turn', () => {
  const now = 59 * MINUTE;
  assert.equal(cacheWarmRemainingWarms({ now, ttlMs: HOUR, dueAt: now + 59 * MINUTE }), 1);
  assert.equal(cacheWarmRemainingWarms({ now, ttlMs: HOUR, dueAt: now + 59 * MINUTE + 1 }), 2);
  assert.equal(cacheWarmRemainingWarms({ now, ttlMs: HOUR, dueAt: 3 * HOUR }), 3);
});

test('plan: warm iff P · missCost > remainingWarms · warmCost, failing closed on any unknown', () => {
  const base = {
    touchAt: 0,
    ttlMs: HOUR,
    promptTokens: 70_000,
    prices: tier(OPUS_55, HOUR),
    probability: ROUTINE_TURN_HIT_PROBABILITY,
    autoClearAtDue: false,
  };
  const now = 59 * MINUTE;
  const interval = 59 * MINUTE;
  assert.deepEqual(planCacheWarm({ ...base, now, dueAt: 3 * HOUR }), { warm: true, warms: 3 });
  assert.deepEqual(planCacheWarm({ ...base, now, dueAt: 3_590_000 }), { warm: true, warms: 1 }, 'the 1h edge');
  // 21 warms pay, 22 do not (Opus 5.5, 1h).
  assert.equal(planCacheWarm({ ...base, now, dueAt: now + 21 * interval }).warm, true);
  assert.match(planCacheWarm({ ...base, now, dueAt: now + 21 * interval + 1 }).stop, /cost more/);
  // 5m entries: 13 warms of 4.5 min pay for Opus 5.5, 6 for Opus 4.7.
  const five = { ...base, ttlMs: 5 * MINUTE, now: 270_000 };
  assert.equal(planCacheWarm({ ...five, prices: tier(OPUS_55, 5 * MINUTE), dueAt: 270_000 * 14 }).warm, true);
  assert.match(planCacheWarm({ ...five, prices: tier(OPUS_55, 5 * MINUTE), dueAt: 270_000 * 14 + 1 }).stop, /cost more/);
  assert.equal(planCacheWarm({ ...five, prices: tier(OPUS_47, 5 * MINUTE), dueAt: 270_000 * 7 }).warm, true);
  assert.match(planCacheWarm({ ...five, prices: tier(OPUS_47, 5 * MINUTE), dueAt: 270_000 * 7 + 1 }).stop, /cost more/);

  assert.match(planCacheWarm({ ...base, now: 0, dueAt: 50 * MINUTE }).stop, /before the refresh/);
  assert.match(planCacheWarm({ ...base, now, dueAt: null }).stop, /no known turn/);
  assert.match(planCacheWarm({ ...base, now, dueAt: 3 * HOUR, autoClearAtDue: true }).stop, /auto-clear compacts/);
  assert.match(planCacheWarm({ ...base, now, dueAt: 3 * HOUR, autoClearAtDue: null }).stop, /auto-clear state unknown/);
  assert.match(planCacheWarm({ ...base, now, dueAt: 3 * HOUR, probability: undefined }).stop, /probability/);
  assert.match(planCacheWarm({ ...base, now, dueAt: 3 * HOUR, prices: null }).stop, /prices unknown/);
  assert.match(planCacheWarm({ ...base, now, dueAt: 3 * HOUR, promptTokens: 0 }).stop, /prompt size/);
  // Late timer: the entry's remaining life must cover the warm's landing —
  // the expiry margin, or the chain's measured latency when longer.
  assert.match(planCacheWarm({ ...base, now: HOUR - 5_000, dueAt: 3 * HOUR }).stop, /late/);
  assert.equal(planCacheWarm({ ...base, now: HOUR - 20_000, dueAt: 3 * HOUR }).warm, true);
  assert.match(planCacheWarm({ ...base, now: HOUR - 20_000, dueAt: 3 * HOUR, latencyMs: 25_000 }).stop, /late/);
  assert.match(planCacheWarm({ ...five, prices: tier(OPUS_55, 5 * MINUTE), dueAt: HOUR, latencyMs: 31_000 }).stop, /late/);
});

test('the next routine fire is read from the bot’s schedules, skipping off, done and skipped ones', () => {
  const rows = [
    { name: 'a', ownerAgentId: 'bot-a', nextFireAt: new Date(5 * HOUR) },
    { name: 'b', ownerAgentId: 'bot-a', nextFireAt: new Date(2 * HOUR), enabled: false },
    { name: 'c', ownerAgentId: 'bot-a', nextFireAt: new Date(3 * HOUR), skippedUntil: new Date(4 * HOUR) },
    { name: 'd', ownerAgentId: 'bot-a', nextFireAt: new Date(HOUR), status: 'done' },
    { name: 'e', ownerAgentId: 'bot-b', nextFireAt: new Date(HOUR) },
    { name: 'f', ownerAgentId: '', nextFireAt: new Date(4 * HOUR) },
  ];
  assert.equal(nextRoutineFireFor('sess_home_bot-a', rows, 0), 5 * HOUR);
  assert.equal(nextRoutineFireFor('sess_home_lead', rows, 0), 4 * HOUR, 'an ownerless row is Mixy’s');
  assert.equal(nextRoutineFireFor('sess_home_bot-c', rows, 0), null);
});

test('setting: a target list, old routine/off migrated, the env comma list wins when it parses', () => {
  assert.deepEqual(resolveCacheWarmTargets({}, {}), ['scheduled'], 'default: before scheduled runs only');
  assert.deepEqual(normalizeCacheWarmTargets('routine'), ['scheduled']);
  assert.deepEqual(normalizeCacheWarmTargets('off'), []);
  assert.deepEqual(normalizeCacheWarmTargets([]), [], 'an empty list is off');
  assert.deepEqual(
    normalizeCacheWarmTargets(['favorites', 'bogus', 'scheduled', 'favorites']),
    ['scheduled', 'favorites'],
    'known names once, canonical order'
  );
  assert.deepEqual(normalizeCacheWarmTargets({}), ['scheduled']);
  assert.deepEqual(resolveCacheWarmTargets({ cacheWarming: 'off' }, {}), []);
  assert.deepEqual(resolveCacheWarmTargets({ cacheWarming: [] }, { MIXDOG_CACHE_WARMING: 'routine' }), ['scheduled']);
  assert.deepEqual(resolveCacheWarmTargets({}, { MIXDOG_CACHE_WARMING: 'OFF' }), []);
  assert.deepEqual(
    resolveCacheWarmTargets({}, { MIXDOG_CACHE_WARMING: ' Bot-Chats, conversations ,scheduled' }),
    ['scheduled', 'bot-chats', 'conversations']
  );
  assert.deepEqual(parseCacheWarmTargetsEnv('routine,favorites'), ['scheduled', 'favorites']);
  assert.equal(parseCacheWarmTargetsEnv(''), null);
  assert.equal(parseCacheWarmTargetsEnv('scheduled,nope'), null, 'an unknown word: the env value is ignored');
  assert.deepEqual(resolveCacheWarmTargets({ cacheWarming: ['bot-rooms'] }, { MIXDOG_CACHE_WARMING: 'x' }), [
    'bot-rooms',
  ]);
});

test('idle kinds: bot chats, bot rooms, favorites, other conversations; never sub-agents', () => {
  const lead = (id, extra = {}) => ({ id, agent: 'lead', ...extra });
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_home_lead'), { favorite: false }), ['bot-chats']);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_home_lead'), { favorite: null }), ['bot-chats']);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_home_lead'), { favorite: true }), ['bot-chats', 'favorites']);
  assert.deepEqual(cacheWarmSessionKinds({ id: 'sess_home_bot-a', agent: 'bot-a' }), ['bot-chats']);
  assert.deepEqual(cacheWarmSessionKinds({ id: 'sess_rmem_abc123_bot-a', agent: 'bot-a' }), ['bot-rooms']);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_task'), { favorite: false }), ['conversations']);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_task'), { favorite: true }), ['favorites']);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_task'), { favorite: null }), [], 'favorite state unknown');
  // Sub-agents and agent-only workers are never a target.
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_sub', { owner: 'agent' }), { favorite: true }), []);
  assert.deepEqual(cacheWarmSessionKinds({ id: 'sess_w', agent: 'worker', owner: 'agent' }, { favorite: false }), []);
  assert.deepEqual(cacheWarmSessionKinds(lead('sess_v', { visibility: 'agent-only' }), { favorite: false }), []);
});

test('idle probability: the measured constant of a selected kind at the written tier, none when unmeasured', () => {
  assert.equal(IDLE_RETURN_PROBABILITY['bot-chats']['1h'], 0.0934);
  assert.equal(idleReturnProbability(['bot-chats'], ['bot-chats'], HOUR), 0.0934);
  assert.equal(idleReturnProbability(['bot-chats'], ['bot-chats'], 5 * MINUTE), 0.0133);
  assert.equal(idleReturnProbability(['bot-chats'], ['scheduled', 'conversations'], HOUR), null, 'kind not selected');
  assert.equal(idleReturnProbability(['bot-rooms'], ['bot-rooms'], 5 * MINUTE), null, 'unmeasured 5m tier');
  assert.equal(idleReturnProbability(['conversations'], ['conversations'], 5 * MINUTE), null);
  assert.equal(
    idleReturnProbability(['bot-chats', 'favorites'], ['bot-chats', 'favorites'], HOUR),
    0.0934,
    'a warm serves every selected kind the session is'
  );
  assert.equal(idleReturnProbability(['bot-chats', 'favorites'], ['favorites'], HOUR), 0.0521);
});

test('idle plan: before the auto-clear deadline, iff P · missCost > warmCost', () => {
  const base = {
    now: 59 * MINUTE,
    touchAt: 0,
    ttlMs: HOUR,
    promptTokens: 70_000,
    prices: tier(OPUS_55, HOUR),
    lastCallAt: 1,
    probability: IDLE_RETURN_PROBABILITY['bot-chats']['1h'],
    autoClearDeadline: null,
  };
  assert.deepEqual(planIdleCacheWarm(base), { warm: true, warms: 1 }, 'auto-clear off: no deadline');
  assert.equal(IDLE_RETURN_MEASURED_WINDOW_MS, 12 * HOUR);
  // Beyond the measured idle window P is unknown: the entry already serves
  // returns up to it.
  assert.match(
    planIdleCacheWarm({ ...base, touchAt: 11 * HOUR + 1, now: 11 * HOUR + 1 + 59 * MINUTE }).stop,
    /measured window/
  );
  assert.equal(planIdleCacheWarm({ ...base, touchAt: 11 * HOUR, now: 11 * HOUR + 59 * MINUTE }).warm, true);
  assert.match(planIdleCacheWarm({ ...base, lastCallAt: 0 }).stop, /last real call unknown/);
  assert.deepEqual(planIdleCacheWarm({ ...base, autoClearDeadline: 12 * HOUR }), { warm: true, warms: 1 });
  // The default 1h auto-clear on a 1h entry: a return after expiry is compacted.
  assert.match(planIdleCacheWarm({ ...base, autoClearDeadline: HOUR }).stop, /auto-clear compacts/);
  assert.match(planIdleCacheWarm({ ...base, autoClearDeadline: undefined }).stop, /auto-clear state unknown/);
  assert.match(planIdleCacheWarm({ ...base, probability: null }).stop, /not measured/);
  // Conversations (0.0321) pay on Opus 5.5 1h (break-even 0.0257) but not on
  // Opus 4.7 1h (break-even 0.0527); bot chats at 5m never pay.
  const conversations = { ...base, probability: IDLE_RETURN_PROBABILITY.conversations['1h'] };
  assert.equal(planIdleCacheWarm(conversations).warm, true);
  assert.match(planIdleCacheWarm({ ...conversations, prices: tier(OPUS_47, HOUR) }).stop, /cost more/);
  assert.match(
    planIdleCacheWarm({
      ...base,
      ttlMs: 5 * MINUTE,
      now: 270_000,
      prices: tier(OPUS_55, 5 * MINUTE),
      probability: IDLE_RETURN_PROBABILITY['bot-chats']['5m'],
    }).stop,
    /cost more/
  );
  assert.match(planIdleCacheWarm({ ...base, now: HOUR - 5_000 }).stop, /late/);
});

// An in-memory touch store (prompt-cache-touch-store.mjs shape).
function memoryTouches() {
  const map = new Map();
  return {
    map,
    get: (id) => (map.has(id) ? { ...map.get(id) } : null),
    record: (id, touch) => map.set(id, { ...touch }),
    forget: (id) => map.delete(id),
    ids: () => [...map.keys()],
  };
}

// Auto-clear settings / context of the gate (idle-auto-clear-gate.mjs).
const AUTO_CLEAR_OFF = { enabled: false, idleMs: HOUR, minContextPercent: 10 };
const contextAt = (pct) => ({ usedTokens: pct * 1_000, compaction: { triggerTokens: 100_000 } });

// A driven clock and timer list for chains.
function harness({
  nextFireAt = 3 * HOUR,
  inFlight = false,
  reply,
  autoClear = AUTO_CLEAR_OFF,
  context = contextAt(70),
  prices = tier(OPUS_55, HOUR),
  realRegistry = false,
  targets = ['scheduled'],
  favorite = false,
  sessionId = 'sess_home_lead',
} = {}) {
  const touches = memoryTouches();
  const state = { clock: 0, timers: [], usage: [], logs: [], nextFireAt, touches, targets, favorite };
  _setCacheWarmDepsForTest({
    // The captured instance is the registered one unless a test uses the
    // real registry lookup.
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
    targets: async () => state.targets,
    favoriteState: async () => state.favorite,
    turnInFlight: () => inFlight,
    // Relative to the first real request's send time.
    nextRoutineFire: async () => (state.nextFireAt === null ? null : state.sentAt + state.nextFireAt),
    prices: async () => prices,
    autoClearSettings: async () => autoClear,
    contextStatus: async () => context,
    recordUsage: async (req, usage, startedAt, accountId) => state.usage.push({ req, usage, startedAt, accountId }),
    touches: () => touches,
    log: (line) => state.logs.push(line),
  });
  state.prov = provider('anthropic-oauth', reply);
  state.session = homeSession(sessionId);
  state.session.messages = [...PREFIX];
  state.session.lastUsedAt = 0;
  state.sentAt = 0;
  state.capture = () => {
    const handle = captureSideQuestionRequest({
      sessionId: state.session.id,
      sessionRef: state.session,
      provider: state.prov,
      model: MODEL,
      messages: state.session.messages,
      tools: TOOLS,
      opts: { session: state.session, cacheStrategy: CACHE_STRATEGY, effort: 'high' },
    });
    return handle;
  };
  // A real request settling with `response`; due turns count from its send
  // time (the snapshot's).
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
  for (const id of ['sess_home_lead', 'sess_task', 'sess_rmem_abc123_lead', 'sess_sub']) forgetSideQuestion(id);
  _setCacheWarmDepsForTest();
});

// Drive the chain's timers until it stops (or `limit` refreshes).
async function runChain(h, limit = 100) {
  for (let i = 0; i < limit && h.timers.length; i += 1) await h.fire();
}

test('idle trigger: a selected kind warms per interval until the entry outlives the auto-clear deadline', async () => {
  const autoClear6h = { enabled: true, idleMs: 6 * HOUR, minContextPercent: 10 };
  const h = harness({ targets: ['bot-chats'], nextFireAt: null, autoClear: autoClear6h });
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  h.session.lastUsedAt = start;
  await runChain(h);
  // Refresh k goes out at start + k·59 min while the entry (touch + 60 min)
  // still expires before the 6 h deadline: k = 1…6.
  assert.equal(h.prov.calls.length, 6);
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.match(h.logs.at(-1), /idle: auto-clear compacts the thread before the cache expires/);
});

test('idle trigger: the default 1h auto-clear on a 1h entry never warms; auto-clear off stops at 12 h idle', async () => {
  let h = harness({
    targets: ['bot-chats'],
    nextFireAt: null,
    autoClear: { enabled: true, idleMs: HOUR, minContextPercent: 10 },
  });
  h.settle();
  h.session.lastUsedAt = cacheWarmChain(h.session.id).touchAt;
  await h.fire();
  assert.equal(h.prov.calls.length, 0);
  assert.match(h.logs.at(-1), /auto-clear compacts/);

  // Auto-clear off: no deadline, but P was measured only over 12 h of idle
  // time after the last real call. Refresh k (start + k·59 min) goes out
  // while the entry (touch + 60 min) expires inside it: k = 1…12.
  h = harness({ targets: ['bot-chats'], nextFireAt: null });
  h.settle();
  const start = cacheWarmChain(h.session.id).touchAt;
  await runChain(h);
  assert.equal(h.prov.calls.length, 12);
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.equal(h.clock, start + 13 * 59 * MINUTE, 'stopped at the 13th refresh point');
  assert.match(h.logs.at(-1), /idle: idle time reaches the measured window/);
});

test('idle trigger: ineligible or unselected kinds, unknown favorites and P below the threshold never warm', async () => {
  // A bot chat with only rooms selected; with only scheduled and no fire due.
  for (const targets of [['bot-rooms'], ['scheduled'], ['favorites', 'conversations']]) {
    const h = harness({ targets, nextFireAt: null });
    h.settle();
    await h.fire();
    assert.equal(h.prov.calls.length, 0, `targets ${targets}`);
  }
  // Other conversations: warmed when selected and known not to be a favorite.
  let h = harness({ targets: ['conversations'], nextFireAt: null, sessionId: 'sess_task' });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 1);
  h = harness({ targets: ['conversations'], nextFireAt: null, sessionId: 'sess_task', favorite: true });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 0, 'a favorite is not an "other" conversation');
  h = harness({ targets: ['favorites'], nextFireAt: null, sessionId: 'sess_task', favorite: true });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 1, 'favorites selected');
  h = harness({ targets: ['favorites', 'conversations'], nextFireAt: null, sessionId: 'sess_task', favorite: null });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 0, 'favorite state unknown: no warm');
  // Room members.
  h = harness({ targets: ['bot-rooms'], nextFireAt: null, sessionId: 'sess_rmem_abc123_lead' });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 1);
  // P below the threshold: conversations on Opus 4.7 1h.
  h = harness({ targets: ['conversations'], nextFireAt: null, sessionId: 'sess_task', prices: tier(OPUS_47, HOUR) });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 0);
  assert.match(h.logs.at(-1), /idle: warms cost more than the expected miss/);
});

test('idle trigger: a real send cancels the chain; sub-agents are never armed', async () => {
  let h = harness({ targets: ['bot-chats'], nextFireAt: null });
  h.settle();
  await h.fire();
  assert.equal(h.prov.calls.length, 1);
  h.capture();
  assert.equal(cacheWarmChain(h.session.id), null, 'a real send stops the idle chain');
  assert.equal(h.timers.length, 0);

  h = harness({
    targets: ['scheduled', 'bot-chats', 'bot-rooms', 'favorites', 'conversations'],
    nextFireAt: null,
    sessionId: 'sess_sub',
    favorite: true,
  });
  h.session.owner = 'agent';
  assert.equal(h.capture(), null, 'a sub-agent request is never captured');
  assert.equal(cacheWarmChain('sess_sub'), null);
});

test('a warm adds nothing to the transcript and is no session activity, and re-arms on a hit', async () => {
  const h = harness();
  const activity = [];
  const offActivity = onSessionActivityChange((id) => activity.push(['activity', id]));
  const offTurn = onSessionTurnStart((id) => activity.push(['turn', id]));
  try {
    const handle = h.capture();
    assert.equal(cacheWarmChain(h.session.id), null, 'nothing is armed while the request is in flight');
    handle.settle(HIT);
    const chain = cacheWarmChain(h.session.id);
    assert.ok(chain, 'armed');
    h.sentAt = chain.touchAt;
    assert.equal(chain.ttlMs, HOUR);
    assert.equal(chain.accountId, ACCOUNT, 'the account that served the request');
    const firstTouch = chain.touchAt;
    const before = JSON.stringify(h.session);
    await h.fire(firstTouch + 54 * MINUTE);

    assert.equal(h.prov.calls.length, 1);
    assert.equal(h.prov.calls[0].opts.maxOutputTokensOverride, 1);
    assert.equal(h.prov.calls[0].hooks.accountId, ACCOUNT);    assert.deepEqual(h.prov.accounts, [ACCOUNT], 'sent on the account holding the entry');
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

test('a failed or canceled warm is still billed; a chain stop aborts the warm in flight', async () => {
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
  h.nextFireAt = null;
  await revalidateCacheWarms();
  await flush();
  assert.equal(signal.aborted, true, 'stopping the chain aborts the warm in flight');
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.equal(h.usage.length, 1, 'the aborted warm is billed');
});

test('the chain stops on a miss, a late timer, a turn in flight, a new request, a compaction or no known turn', async () => {
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

  h = harness({ nextFireAt: 50 * MINUTE });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'a turn due before the refresh reads the cache itself');

  h = harness({ nextFireAt: 3_590_000 });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 1, 'a turn due in the last 10% of the lifetime gets one refresh');
  await h.fire();
  assert.equal(h.prov.calls.length, 1, 'only one refresh before that turn');

  h = harness({ nextFireAt: 30 * HOUR });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'a turn too far out: the warms cost more than the expected miss');

  h = harness();
  h.settle();
  h.capture();
  assert.equal(cacheWarmChain(h.session.id), null, 'a new real request cancels the chain');
  assert.equal(h.timers.length, 0);

  h = harness();
  h.settle();
  retireCompactionFork(h.session.id);
  assert.equal(cacheWarmChain(h.session.id), null, 'a compaction cancels the chain');

  h = harness({ nextFireAt: null });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0, 'no known due turn: never a speculative warm');
});

test('a provider instance replaced in the registry stops the chain instead of replaying on the old one', async () => {
  // Still the registered instance: the warm goes out.
  let h = harness({ realRegistry: true });
  h.settle();
  let chain = cacheWarmChain(h.session.id);
  await _withRegisteredProviderForTestAsync('anthropic-oauth', h.prov, () => h.fire(chain.touchAt + 54 * MINUTE));
  assert.equal(h.prov.calls.length, 1);

  // A re-initialization registered a new instance under the same name.
  h = harness({ realRegistry: true });
  h.settle();
  chain = cacheWarmChain(h.session.id);
  const replacement = provider('anthropic-oauth');
  await _withRegisteredProviderForTestAsync('anthropic-oauth', replacement, () =>
    h.fire(chain.touchAt + 54 * MINUTE)
  );
  assert.equal(h.prov.calls.length, 0, 'the old instance is not used');
  assert.equal(replacement.calls.length, 0, 'the old request is not substituted onto the new one');
  assert.equal(cacheWarmChain(h.session.id), null);
  assert.match(h.logs.at(-1), /provider instance replaced/);
});

test('a 3-hourly routine whose thread the idle auto-clear will compact gets no warms', async () => {
  const autoClear1h = { enabled: true, idleMs: HOUR, minContextPercent: 10 };
  // Above the context threshold with a 1h auto-clear: the due turn compacts.
  let h = harness({ nextFireAt: 3 * HOUR, autoClear: autoClear1h, context: contextAt(70) });
  h.session.lastUsedAt = 1;
  h.settle(HIT, 1);
  let chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 0);
  assert.match(h.logs.at(-1), /auto-clear compacts/);

  // Auto-clear off: warms.
  h = harness({ nextFireAt: 3 * HOUR, autoClear: { ...autoClear1h, enabled: false } });
  h.session.lastUsedAt = 1;
  h.settle(HIT, 1);
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 1);

  // Context below the threshold: the gate leaves the thread alone, warms.
  h = harness({ nextFireAt: 3 * HOUR, autoClear: autoClear1h, context: contextAt(5) });
  h.session.lastUsedAt = 1;
  h.settle(HIT, 1);
  chain = cacheWarmChain(h.session.id);
  await h.fire(chain.touchAt + 54 * MINUTE);
  assert.equal(h.prov.calls.length, 1);

  // Warms are not activity: the next warm sees the same idle time.
  assert.equal(h.session.lastUsedAt, 1);
});

test('the gate settings come from the same auto-clear config the submit gate reads', () => {
  assert.deepEqual(autoClearGateSettings({ autoClear: { enabled: false } }, 'anthropic-oauth').enabled, false);
  const custom = autoClearGateSettings({ autoClear: { idleMs: 2 * HOUR, minContextPercent: 25 } }, 'anthropic-oauth');
  assert.equal(custom.idleMs, 2 * HOUR);
  assert.equal(custom.minContextPercent, 25);
});

test('a paused, deleted or rescheduled routine stops the pending warm at once', async () => {
  const h = harness();
  h.settle();
  await revalidateCacheWarms();
  assert.ok(cacheWarmChain(h.session.id), 'an unchanged routine keeps the chain');
  h.nextFireAt = 50 * MINUTE;
  await revalidateCacheWarms();
  assert.equal(cacheWarmChain(h.session.id), null, 'rescheduled before the refresh is due');
  assert.equal(h.timers.length, 0);

  h.settle();
  h.nextFireAt = null;
  await revalidateCacheWarms();
  assert.equal(cacheWarmChain(h.session.id), null, 'paused or deleted');

  h.settle();
  h.nextFireAt = 30 * HOUR;
  await revalidateCacheWarms();
  assert.equal(cacheWarmChain(h.session.id), null, 'rescheduled beyond what the warms are worth');
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
    'sess_home_bot-c': rebuilt(homeSession('sess_home_bot-c')),
    'sess_home_bot-d': rebuilt(homeSession('sess_home_bot-d')),
  };
  const touches = memoryTouches();
  touches.record('sess_home_lead', { touchAt: now - 20 * MINUTE, ttlMs: HOUR, promptTokens: 71_000, accountId: 'acct-2' });
  // bot-a: a 5m entry written 20 min ago: expired.
  touches.record('sess_home_bot-a', { touchAt: now - 20 * MINUTE, ttlMs: 5 * MINUTE, promptTokens: 70_000 });
  touches.record('sess_home_bot-b', { touchAt: now - 5 * MINUTE, ttlMs: HOUR, promptTokens: 70_000 });
  // bot-d: inside the last 10 s of its lifetime.
  touches.record('sess_home_bot-d', { touchAt: now - HOUR + 5_000, ttlMs: HOUR, promptTokens: 70_000 });
  let providersReady = 0;
  _setCacheWarmDepsForTest({
    now: () => h.clock,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    targets: async () => ['scheduled'],
    routineSessions: async () => Object.keys(records),
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
  assert.equal(cacheWarmChain('sess_home_bot-a'), null);
  assert.equal(touches.get('sess_home_bot-a'), null, 'an expired touch is dropped');
  assert.equal(cacheWarmChain('sess_home_bot-b'), null, 'an ineligible provider is not re-armed');
  assert.equal(cacheWarmChain('sess_home_bot-c'), null, 'no recorded touch: skipped');
  assert.equal(touches.get('sess_home_bot-d'), null, 'a touch inside the expiry margin is dropped');
});

test('after a restart, idle targets re-arm every touched session; scheduled alone only routine threads', async () => {
  const now = Date.UTC(2026, 9, 26, 0, 30);
  const touches = memoryTouches();
  touches.record('sess_task', { touchAt: now - 20 * MINUTE, ttlMs: HOUR, promptTokens: 70_000, accountId: ACCOUNT });
  let targets = ['scheduled'];
  _setCacheWarmDepsForTest({
    now: () => now,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    targets: async () => targets,
    routineSessions: async () => [],
    lastSentRequest: async () => ({ ...request({ session: homeSession('sess_task') }), sentAt: now - 50 * MINUTE }),
    providersReady: async () => {},
    touches: () => touches,
    log() {},
  });
  assert.equal(await rearmCacheWarmsAfterRestart(), 0);
  targets = [];
  assert.equal(await rearmCacheWarmsAfterRestart(), 0, 'off');
  targets = ['conversations'];
  assert.equal(await rearmCacheWarmsAfterRestart(), 1);
  assert.equal(cacheWarmChain('sess_task').touchAt, now - 20 * MINUTE);
});

test('restart re-arm waits for the owning runtime’s provider init and never initializes providers', async () => {
  const now = Date.UTC(2026, 9, 26, 0, 30);
  const touches = memoryTouches();
  touches.record('sess_home_lead', { touchAt: now - 20 * MINUTE, ttlMs: HOUR, promptTokens: 70_000, accountId: ACCOUNT });
  let rebuilt = 0;
  // The default readiness dependency (registry.providersInitialized).
  _setCacheWarmDepsForTest({
    now: () => now,
    timers: { setTimeout: () => ({}), clearTimeout() {} },
    targets: async () => ['scheduled'],
    routineSessions: async () => ['sess_home_lead'],
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

test('the touch store survives a reload and drops expired entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-touch-'));
  try {
    const path = join(dir, 'touches.json');
    const store = createPromptCacheTouchStore(path);
    store.record('alive', { touchAt: Date.now(), ttlMs: HOUR, promptTokens: 5, accountId: 'a' });
    store.record('expired', { touchAt: Date.now() - 2 * HOUR, ttlMs: HOUR, promptTokens: 5 });
    store.record('invalid', { touchAt: Date.now(), ttlMs: 0, promptTokens: 5 });
    await store.flush();
    const reloaded = createPromptCacheTouchStore(path);
    assert.equal(reloaded.get('alive').accountId, 'a');
    assert.equal(reloaded.get('expired'), null);
    assert.equal(reloaded.get('invalid'), null);
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
