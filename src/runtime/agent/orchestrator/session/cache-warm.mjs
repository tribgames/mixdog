// cache-warm.mjs — keeps a session's prompt cache readable for its next turn
// — every session, Lead, bot or sub-agent, while warming is on
// (`promptCacheWarming`, default on) — one interval at a time while the
// session idles, as far as the session's own history of returns says it
// pays. A warm re-sends the session's last real request
// (side-question-store.mjs) through the provider's cache-warm mode
// (providers/anthropic-cache-warm.mjs: the provider's own request builder,
// max_tokens 1, one POST with no retry, fallback or account rotation, cut at
// the first content block), so the provider reads and refreshes the cached
// prefix and writes nothing. The warm never reaches the transcript, the UI,
// the admission queue or the session record (lastProviderSendAt included);
// its usage-ledger row carries the `cache-warm` source, written on success,
// failure and cancellation.
//
// Scope: explicit-breakpoint providers (cache-strategy.mjs) with a warm mode —
// a miss costs a write premium there; automatic-caching providers are left
// alone. A request whose thinking budget derives from max_tokens is never
// replayed (a different budget changes the message cache key). A session
// that never idles long enough to return within a refresh interval (a
// sub-agent, closed when its task ends) learns no return and gets no warm.
//
// Rule (planCacheWarm), one for every warm, at each refresh point (one
// interval I = min(0.9·T, T−10s) after the last confirmed cache use; T is
// the tier the provider reported writing), e the session's idle time since
// its last real call: warm iff, for some j ≥ 1
// further warms, P(e, j) · missCost > j · warmCost — missCost a write of the
// prompt at that tier minus the read the turn makes anyway, warmCost a read
// of it plus the one output token, and P(e, j) the lower bound of the 95%
// Wilson interval of this session's own recorded idle gaps (idle-gap store:
// the last 7 days) that ended in a return within (e, e + j·I] among those
// still idle at e. j = 1 is the per-interval break-even; a larger j is the
// same break-even over the warms a return further out needs (a 3-hourly
// routine is idle through two refresh points before it returns). No history
// → no warm → plain auto-clear. Returns count up to the idle window
// (IDLE_RETURN_MEASURED_WINDOW_MS after the last real call). A successful
// warm counts as cache use for the idle auto-clear (sessionActivityTimestamp
// in idle-auto-clear-gate.mjs), so its deadline moves with each one.
// Any fact the rule needs that is not known (written tier, prices, prompt
// size, the account holding the entry) means no warm. The chain stops on a
// miss, a failure, a late timer, a turn in flight, a new real request
// (side-question-store.mjs cancels), a compaction, a clear, a close, or a
// delete; the auto-clear then runs from the last real or successful warm
// use.
//
// Idle gaps, across turn boundaries only and from real activity only: every
// settled main-loop request of a real turn (any provider) moves the session's
// idle anchor to that request's send; a returning turn (the user's, a
// scheduled fire's, a webhook's, a heartbeat's, a sub-agent dispatch) closes
// the gap at its start once its first request goes out (noteCacheWarmTurn,
// noteCacheWarmActivity). Requests inside a running turn and a retried
// (continued) turn are no return. System-caused requests are neither return
// nor activity: turns the runtime starts itself (cacheWarmTurnKind), and
// every call outside the main loop's capture (compaction summaries, titles,
// /btw side questions, memory recap, prewarms, warms). The planner counts
// idle time from the same anchor. Each session learns from its own gaps. A gap still open at the idle window is recorded as
// censored there.
import { ACCOUNT_PROVIDERS } from '../../../shared/provider-accounts.mjs';
import { setCacheWarmUseSource } from '../../../shared/idle-auto-clear-gate.mjs';
import {
  ANTHROPIC_TAIL_LIFETIME_MS,
  cacheCapabilityForProvider,
  providerTailCacheLifetimeMs,
} from '../agent-runtime/cache-strategy.mjs';
import { anthropicEffortLevelsFor } from '../../../shared/llm/anthropic-effort.mjs';
import { isTurnInFlight, runtimeState } from './manager/runtime-state.mjs';
import { withTailReminder } from './tail-reminder-rules.mjs';
import { promptCacheTouchStore } from './prompt-cache-touch-store.mjs';
import { createIdleGapStore } from './prompt-cache-idle-gaps.mjs';
import { registerSessionPurgeHook } from './store/session-observers.mjs';
import { PROMPT_ORIGIN_AGENT_REPORT, PROMPT_ORIGIN_CHANNEL, promptOriginOf } from '../../../shared/prompt-origin.mjs';

export const CACHE_WARM_SOURCE = 'cache-warm';

// The refresh keeps at least this much of the entry's lifetime unused, for
// the warm to land before it expires.
export const CACHE_WARM_EXPIRY_MARGIN_MS = 10_000;
// Share of the lifetime after which the refresh goes out at the latest
// unless the lead below allows later.
export const CACHE_WARM_REFRESH_SHARE = 0.9;
// A refresh may wait until this long before expiry: in a 7-day sample of
// hourly routine fires, cache misses inside the 1h lifetime appeared only at
// 3588–3597 s after the previous call, so 60 s ahead stays clear of them.
export const CACHE_WARM_LEAD_MS = 60_000;
// The idle stretch returns are learned over: 12 h after the session's last
// real call — the window the maintainer's 7-day audit of idle returns
// validated. A longer gap is recorded as censored there, and no warm serves
// a return beyond it.
export const IDLE_RETURN_MEASURED_WINDOW_MS = 12 * 60 * 60 * 1000;
// The period a session's idle gaps are kept and learned from: the last 7
// days, the measurement period the maintainer validated.
export const IDLE_RETURN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// z of a two-sided 95% normal interval (the 0.975 standard normal quantile),
// for the Wilson score bound.
export const WILSON_Z_95 = 1.959963984540054;

/** Whether prompt-cache warming is on (config `promptCacheWarming`, default
 *  on; config.mjs migrates the earlier target list). */
export function cacheWarmingEnabled(config) {
  return config?.promptCacheWarming !== false;
}

/** The lower bound of the 95% Wilson score interval of `hits` in `n`
 *  (0 for no trials): small samples get no invented confidence. */
export function wilsonLowerBound(hits, n, z = WILSON_Z_95) {
  // No trials or no hits: the bound is exactly 0 (the formula's float
  // rounding would leave ~1e-17).
  if (!(n > 0) || !(hits > 0)) return 0;
  const p = hits / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
}

/**
 * The chance, learned from a session's own idle `gaps` (`{ ms, censored? }`),
 * that a session idle for `elapsedMs` returns within `withinMs` more: the
 * Wilson lower bound of the gaps that ended in a return in
 * (elapsedMs, elapsedMs + withinMs] among the gaps still idle at elapsedMs
 * (a censored gap is idle up to its cut and never a return).
 * `{ idle, returns, p }`.
 */
export function sessionReturnChance(gaps, elapsedMs, withinMs) {
  let idle = 0;
  let returns = 0;
  for (const gap of gaps || []) {
    if (!(gap.ms > elapsedMs)) continue;
    idle += 1;
    if (!gap.censored && gap.ms <= elapsedMs + withinMs) returns += 1;
  }
  return { idle, returns, p: wilsonLowerBound(returns, idle) };
}

/** When a warm goes out after the last cache use of an entry living `ttlMs`. */
export function cacheWarmDelayMs(ttlMs) {
  const refreshAt = Math.max(ttlMs * CACHE_WARM_REFRESH_SHARE, ttlMs - CACHE_WARM_LEAD_MS);
  return Math.max(1, Math.floor(Math.min(refreshAt, ttlMs - CACHE_WARM_EXPIRY_MARGIN_MS)));
}

const TIERS = Object.freeze(['5m', '1h']);

/**
 * The lifetime of the message-tail entry a response wrote, or 0 when the
 * usage does not prove it. Any write reaches the tail (a prefix write
 * rewrites everything after it), so a single written tier is the tail's.
 * With both tiers written, a tier is the tail's when no other breakpoint of
 * `cacheStrategy` asked for it. A response that wrote nothing proves nothing.
 */
export function writtenCacheTtlMs(usage, cacheStrategy) {
  const written = Number(usage?.cacheWriteTokens) || 0;
  if (!(written > 0)) return 0;
  const written1h = Math.min(Number(usage?.cacheWrite1hTokens) || 0, written);
  const written5m = written - written1h;
  if (written5m <= 0) return ANTHROPIC_TAIL_LIFETIME_MS['1h'];
  if (written1h <= 0) return ANTHROPIC_TAIL_LIFETIME_MS['5m'];
  const tail = cacheStrategy?.messages;
  if (!TIERS.includes(tail)) return 0;
  const others = [cacheStrategy.tools, cacheStrategy.system, cacheStrategy.tier3];
  return others.includes(tail) ? 0 : ANTHROPIC_TAIL_LIFETIME_MS[tail];
}

/** Why `request` (a side-question-store snapshot) may not be warmed, or null. */
export function cacheWarmIneligibility(request) {
  const name = request?.provider?.name;
  if (cacheCapabilityForProvider(name) !== 'explicit-breakpoint') return 'provider caches without breakpoints';
  if (typeof request.provider.sendCacheWarm !== 'function') return 'provider has no cache-warm mode';
  const opts = request.opts || {};
  if (!opts.session?.id) return 'no session';
  if (Number(opts.thinkingBudgetTokens) > 0) return 'thinking budget derives from max_tokens';
  if (opts.effort && anthropicEffortLevelsFor(request.model).length === 0) {
    return 'thinking budget derives from max_tokens';
  }
  if (!providerTailCacheLifetimeMs(name, opts.cacheStrategy)) return 'no expiring message-tail cache';
  return null;
}

/** The send a warm makes for `request`: the same messages (with the same
 *  ephemeral tail reminder the real send added), model, tools and options,
 *  with max_tokens 1 and the warm's own signal. */
export function cacheWarmSend(request, { signal } = {}) {
  const session = request.opts?.session || null;
  return {
    messages: withTailReminder(request.messages, { session, provider: request.provider, model: request.model }),
    model: request.model,
    tools: request.tools.length ? request.tools : undefined,
    opts: { ...request.opts, maxOutputTokensOverride: 1, signal },
  };
}

/** `{ warmCost, missCost }` in dollars for a prompt of `promptTokens` at
 *  per-token `prices` ({ read, write, output } of the entry's tier), or null
 *  when the prompt size or any price is unknown. */
export function cacheWarmEconomics(promptTokens, prices) {
  const tokens = Number(promptTokens);
  const read = prices?.read;
  const write = prices?.write;
  const output = prices?.output;
  if (!(tokens > 0) || ![read, write, output].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { warmCost: read * tokens + output, missCost: Math.max(0, (write - read) * tokens) };
}

/**
 * Whether a warm sent at `now` pays off for the session: the entry was last
 * used at `touchAt` and lives `ttlMs`; the session's last real call went out
 * at `lastCallAt`; `gaps` are its own recorded idle gaps; `latencyMs` the
 * measured time a warm of this chain took to reach the provider (null: not
 * measured yet). With e = now − lastCallAt and I the refresh interval, warm
 * iff some j ≥ 1 has P(e, j·I) · missCost > j · warmCost (P:
 * sessionReturnChance), returns counted inside the idle window. The idle
 * auto-clear is no bound: a successful warm is cache use, so its deadline
 * moves with each one. `{ warm: true, warms: j, p }` or `{ stop }`.
 */
export function planCacheWarm({ now, touchAt, ttlMs, lastCallAt, gaps, promptTokens, prices, latencyMs = null }) {
  if (!(lastCallAt > 0)) return { stop: 'last real call unknown' };
  // The warm serves only a return after the current entry's expiry, inside
  // the idle window returns are learned over.
  if (!(touchAt + ttlMs < lastCallAt + IDLE_RETURN_MEASURED_WINDOW_MS)) {
    return { stop: 'idle time reaches the learned window' };
  }
  // The warm must reach the provider while the entry still lives.
  const landing = Math.max(CACHE_WARM_EXPIRY_MARGIN_MS, Number(latencyMs) || 0);
  if (touchAt + ttlMs - now <= landing) return { stop: 'late timer' };
  const economics = cacheWarmEconomics(promptTokens, prices);
  if (!economics) return { stop: 'prompt size or cache prices unknown' };
  const interval = cacheWarmDelayMs(ttlMs);
  const elapsed = now - lastCallAt;
  if (!sessionReturnChance(gaps, elapsed, 0).idle) return { stop: 'no idle history this long' };
  for (let j = 1; elapsed + j * interval <= IDLE_RETURN_MEASURED_WINDOW_MS; j += 1) {
    const { p } = sessionReturnChance(gaps, elapsed, j * interval);
    if (p * economics.missCost > j * economics.warmCost) return { warm: true, warms: j, p };
  }
  return { stop: 'warms cost more than the expected miss' };
}

// Defaults of the injectable dependencies.

async function defaultEnabled() {
  const { loadConfig } = await import('../config.mjs');
  return cacheWarmingEnabled(loadConfig({ secrets: false }));
}

// Per-token dollars of a cache read, a cache write of `ttlMs`'s tier and an
// output token for the request's model, from the pricing catalog (null when
// unpriced).
async function defaultPrices(request, ttlMs) {
  const { priceUsage } = await import('../../../shared/llm/cost.mjs');
  const MILLION = 1_000_000;
  const base = { model: request.model, provider: request.provider.name, inputTokensInclusive: false };
  const per = (tokens) => {
    const cost = priceUsage({ ...base, ...tokens }).costUsd;
    return cost === null || cost === undefined ? null : Number(cost) / MILLION;
  };
  const oneHour = ttlMs >= ANTHROPIC_TAIL_LIFETIME_MS['1h'];
  return {
    read: per({ cacheReadTokens: MILLION }),
    write: per({ cacheWriteTokens: MILLION, ...(oneHour ? { cacheWrite1hTokens: MILLION } : {}) }),
    output: per({ outputTokens: MILLION }),
  };
}

// The registered providers a re-armed request needs: waits for the owning
// runtime's own provider initialization; never initializes them itself.
async function defaultProvidersReady() {
  const { providersInitialized } = await import('../providers/registry.mjs');
  await providersInitialized();
}

async function defaultRegisteredProvider(name) {
  const { registeredProvider } = await import('../providers/registry.mjs');
  return registeredProvider(name);
}

async function defaultSend(request, chain, target, onUsage) {
  const controller = new AbortController();
  chain.controller = controller;
  try {
    const send = cacheWarmSend(request, { signal: controller.signal });
    return await target.provider.sendCacheWarm(send.messages, send.model, send.tools, send.opts, {
      onUsage,
      accountId: target.accountId,
    });
  } finally {
    if (chain.controller === controller) chain.controller = null;
  }
}

// The warm's usage-ledger row, in the shape the provider boundary writes
// (usage-accounting.mjs), under the `cache-warm` source; the ledger prices
// every reported token with the catalog.
async function defaultRecordUsage(request, usage, startedAt, accountId) {
  const { getUsageLedger, makeUsageRecord } = await import('../../../shared/llm/usage-ledger.mjs');
  const ledger = getUsageLedger();
  if (!ledger) return;
  const session = request.opts.session;
  await ledger.recordQueued(
    makeUsageRecord({
      ts: Date.now(),
      provider: request.provider.name,
      model: request.model,
      requestedModel: request.model,
      sessionId: session.id,
      ownerSessionId: session.ownerSessionId || session.parentSessionId,
      sourceType: CACHE_WARM_SOURCE,
      inputTokens: usage.inputTokens,
      inputTokensInclusive: false,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      account: accountId || '',
      durationMs: Date.now() - startedAt,
    })
  );
}

async function defaultLastSentRequest(sessionId) {
  const { lastSentMainRequest } = await import('./side-question.mjs');
  return lastSentMainRequest(sessionId);
}

const DEFAULT_DEPS = Object.freeze({
  now: () => Date.now(),
  timers: globalThis,
  enabled: defaultEnabled,
  turnInFlight: (sessionId) => isTurnInFlight(runtimeState.get(sessionId)),
  lastSentRequest: defaultLastSentRequest,
  providersReady: defaultProvidersReady,
  registeredProvider: defaultRegisteredProvider,
  prices: defaultPrices,
  send: defaultSend,
  recordUsage: defaultRecordUsage,
  touches: () => promptCacheTouchStore(),
  gaps: () => promptCacheIdleGapStore(),
  log: (line) => process.stderr.write(`[cache-warm] ${line}\n`),
});
let deps = DEFAULT_DEPS;

// The idle auto-clear measures idleness from the last cache use, a
// successful warm included (durable in the touch store).
setCacheWarmUseSource((sessionId) => (sessionId ? deps.touches().lastWarmUse(sessionId) : 0));

// A session deleted for good drops everything it learned and touched.
registerSessionPurgeHook((sessionId) => {
  cancelCacheWarm(sessionId);
  turns.delete(sessionId);
  deps.touches().forget(sessionId);
  deps.touches().forgetWarmUse(sessionId);
  deps.gaps().forget(sessionId);
});

let defaultGapStore = null;
/** The idle-gap store the warmer learns from (prompt-cache-idle-gaps.mjs). */
export function promptCacheIdleGapStore() {
  defaultGapStore ??= createIdleGapStore({
    lookbackMs: IDLE_RETURN_LOOKBACK_MS,
    windowMs: IDLE_RETURN_MEASURED_WINDOW_MS,
    // No refresh point lies inside a gap shorter than the shortest interval.
    minMs: cacheWarmDelayMs(ANTHROPIC_TAIL_LIFETIME_MS['5m']),
  });
  return defaultGapStore;
}

// The plan of `chain` at its refresh point `at` (planCacheWarm), from the
// session's own idle history. Unknown facts fail closed.
async function planFor(sessionId, chain, at) {
  if (!(await deps.enabled())) return { stop: 'cache warming off' };
  return planCacheWarm({
    now: at,
    touchAt: chain.touchAt,
    ttlMs: chain.ttlMs,
    // Idle time counts from the last real activity (the gap store's anchor),
    // the clock the gaps were learned on; a system-caused request since then
    // refreshed the cache (touchAt) but not the idle clock.
    lastCallAt: deps.gaps().openAt(sessionId),
    gaps: deps.gaps().gaps(sessionId),
    promptTokens: chain.promptTokens,
    prices: await deps.prices(chain.request, chain.ttlMs),
    latencyMs: chain.latencyMs,
  });
}

/** Test seam: replace some dependencies; call with no argument to restore. */
export function _setCacheWarmDepsForTest(overrides = null) {
  for (const sessionId of [...chains.keys()]) cancelCacheWarm(sessionId);
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : DEFAULT_DEPS;
}

// sessionId -> the armed chain: { request, ttlMs, touchAt, promptTokens,
// accountId, latencyMs, refreshAt, timer, controller }.
const chains = new Map();

/** The armed chain of `sessionId` (tests and diagnostics). */
export function cacheWarmChain(sessionId) {
  return chains.get(sessionId) || null;
}

// Turns the runtime starts itself, by their prompt provenance
// (manager/ask-queue.mjs `promptSource`): a Goal's automatic continuation and
// close-out (runtime-synthetic), and a task notification (a finished
// background task or a pending resume reported back). Neither the user nor a
// routine caused them — unless the notification is an inbound channel
// message (`origin` PROMPT_ORIGIN_CHANNEL), which is presented the same way.
// The other way round, a prompt whose origin is PROMPT_ORIGIN_AGENT_REPORT (a
// bot-home wake, a room member's relay) is the runtime's though presented as
// a prompt.
const SYSTEM_TURN_SOURCES = new Set(['goal-continuation', 'goal-closeout', 'task-notification']);

// What a turn of the provenance `source` / `origin` is: 'system' or 'return'.
function provenanceKind(source, origin) {
  if (origin === PROMPT_ORIGIN_CHANNEL) return 'return';
  if (origin === PROMPT_ORIGIN_AGENT_REPORT) return 'system';
  return SYSTEM_TURN_SOURCES.has(source) ? 'system' : 'return';
}

// The input message of the failed turn a retry reruns, by the turn's durable
// identity. The failure's completion sits on the session's last message
// (ask-turn-settle.mjs attachFailedTurnCompletion: the prompt itself, or the
// turn's last reply / tool result); its owner is the user message of the same
// attempt (`attemptId`, else the turn start `at` the settle path matches on),
// searched back to the previous turn's recorded end. A retained retry
// (`retryTurnId`) names the failed prompt itself (retainedFailedTurnInput).
function failedTurnMessage(messages, input) {
  const list = Array.isArray(messages) ? messages : [];
  const endIndex = list.findLastIndex((item) => item?.role !== 'system');
  const end = list[endIndex];
  const completion = end?.meta?.transcript?.completion;
  if (completion?.status !== 'failed') return null;
  if (input.retryTurnId && end.meta.transcript.messageId !== input.retryTurnId) return null;
  if (end.role === 'user') return end;
  const attemptId = typeof completion.attemptId === 'string' ? completion.attemptId : '';
  const at = Number(completion.at) || 0;
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const transcript = list[index]?.meta?.transcript;
    if (transcript?.completion) return null;
    if (list[index].role !== 'user' || !transcript) continue;
    if (transcript.attemptId ? transcript.attemptId === attemptId : at > 0 && Number(transcript.at) === at) {
      return list[index];
    }
  }
  return null;
}

/** The provenance `{ source, origin }` of the failed turn a retry input
 *  reruns (failedTurnMessage), or null when it cannot be resolved. A rebuilt
 *  retry message records it (`meta.provenance`, ask-turn-execute.mjs), so a
 *  turn retried again keeps it. */
export function failedTurnProvenance(messages, input) {
  if (input?.retryFailedTurn !== true && !input?.retryTurnId) return null;
  const meta = failedTurnMessage(messages, input)?.meta;
  if (!meta) return null;
  if (meta.provenance && typeof meta.provenance === 'object') return { ...meta.provenance };
  const origin = promptOriginOf(meta.origin);
  return {
    ...(typeof meta.source === 'string' && meta.source ? { source: meta.source } : {}),
    ...(origin ? { origin } : {}),
  };
}

/**
 * What a turn of askSession is for the idle learning, from its input (and,
 * for a retry, the session's `messages` as the turn found them):
 * - a retry of a failed turn (`retryFailedTurn` / `retryTurnId`: the failed
 *   turn's own user message runs again — a quota auto-resume, the Retry
 *   action) continues that turn: 'system' when the failed turn was system-
 *   caused (its stored meta.source / meta.origin / meta.provenance), else
 *   'continuation';
 * - 'system' for a SYSTEM_TURN_SOURCES prompt not from a channel, and for an
 *   agent report (a bot-home wake, a room relay);
 * - 'return' for everything else (the user, a scheduled fire, a webhook, a
 *   heartbeat, a channel message, a sub-agent dispatch).
 */
export function cacheWarmTurnKind(input, messages = null) {
  if (input?.retryFailedTurn === true || input?.retryTurnId) {
    const failed = failedTurnProvenance(messages, input);
    return failed && provenanceKind(failed.source, failed.origin) === 'system' ? 'system' : 'continuation';
  }
  const source = typeof input?.promptSource === 'string' ? input.promptSource : input?.promptSource?.source;
  return provenanceKind(source, input?.promptOrigin);
}

// sessionId -> its running turn: { kind, startedAt, returning }.
const turns = new Map();

/** A turn of the session opened (manager/ask-session.mjs), of `kind`
 *  (cacheWarmTurnKind). A 'return' closes the session's idle gap at its
 *  start, once its first request goes out. Returns the turn's entry, which
 *  endCacheWarmTurn takes. */
export function noteCacheWarmTurn(sessionId, kind) {
  if (!sessionId) return null;
  const turn = { kind, startedAt: deps.now(), returning: kind === 'return', suspended: null };
  turns.set(sessionId, turn);
  // A turn entering the session owns its cache from here: a warm pending in
  // its planning lookups or on the wire must not overlap the real request.
  // The chain is stopped (the abort is not a miss) and its captured request
  // and confirmed touch are kept on the turn: the turn's own settled request
  // arms the next chain, and a turn that ends without any request gets this
  // one back (endCacheWarmTurn).
  const chain = chains.get(sessionId);
  if (chain) {
    const { request, ttlMs, touchAt, promptTokens, accountId, latencyMs } = chain;
    turn.suspended = { request, ttlMs, touchAt, promptTokens, accountId, latencyMs };
    stopChain(sessionId, chain, 'turn entered', { quiet: true });
  }
  return turn;
}

/** The turn noteCacheWarmTurn returned ended (completed, failed or
 *  cancelled): its entry goes unless a later turn already replaced it. The
 *  durable idle anchor stays. When the turn sent no request (any request,
 *  invalidation or close dropped `suspended`), no chain replaced the one it
 *  stopped and the cache entry has not expired, that chain comes back with
 *  its original touch and schedule; the touch and idle-gap stores are left
 *  alone. */
export function endCacheWarmTurn(sessionId, turn) {
  if (!turn || turns.get(sessionId) !== turn) return;
  turns.delete(sessionId);
  const chain = turn.suspended;
  turn.suspended = null;
  if (!chain || chains.has(sessionId)) return;
  if (deps.now() < chain.touchAt + chain.ttlMs - CACHE_WARM_EXPIRY_MARGIN_MS) {
    const restored = startChain(sessionId, chain);
    restored.latencyMs = chain.latencyMs;
  }
}

/** The running turn the warmer holds for `sessionId`, or null (tests). */
export function cacheWarmTurn(sessionId) {
  return turns.get(sessionId) || null;
}

// Whether a captured request is the session's real activity: one of a turn
// that is not system-caused, sent by the main loop itself (no `requestKind`,
// or the wire's 'turn'; a compaction summary or a prewarm names its own).
function realActivity(sessionId, request) {
  if (turns.get(sessionId)?.kind === 'system') return false;
  const kind = request?.opts?.requestKind;
  return !kind || kind === 'turn';
}

/** A request of the main loop is going out: the chain stops; when it is the
 *  first request of a returning turn, the open idle gap closes at the turn's
 *  start. Requests inside a running turn, of a continued turn or of a
 *  system-caused turn are no return. Warms never come through here. */
export function noteCacheWarmActivity(sessionId, request = null) {
  if (!sessionId) return;
  const turn = turns.get(sessionId);
  if (turn?.returning && realActivity(sessionId, request)) {
    turn.returning = false;
    deps.gaps().close(sessionId, turn.startedAt);
  }
  cancelCacheWarm(sessionId);
}

/** Drop the session's chain: clear its timer and abort a warm in flight
 *  (its usage is still accounted). */
export function cancelCacheWarm(sessionId) {
  // Whatever cancels (a request, an invalidation, a close) also voids the
  // chain the running turn would restore.
  const turn = sessionId ? turns.get(sessionId) : null;
  if (turn) turn.suspended = null;
  const chain = sessionId ? chains.get(sessionId) : null;
  if (chain) stopChain(sessionId, chain, 'canceled', { quiet: true });
}

/** The session's cached prefix is gone (compaction, clear, rewind): drop
 *  the chain, its durable touch and its warm use. */
export function forgetCacheWarm(sessionId) {
  cancelCacheWarm(sessionId);
  if (!sessionId) return;
  deps.touches().forget(sessionId);
  deps.touches().forgetWarmUse(sessionId);
}

function recordTouch(sessionId, chain) {
  deps.touches().record(sessionId, {
    touchAt: chain.touchAt,
    ttlMs: chain.ttlMs,
    promptTokens: chain.promptTokens,
    accountId: chain.accountId,
  });
}

function stopChain(sessionId, chain, reason, { quiet = false } = {}) {
  if (chains.get(sessionId) !== chain) return;
  chains.delete(sessionId);
  if (chain.timer) deps.timers.clearTimeout(chain.timer);
  chain.timer = null;
  chain.controller?.abort(new Error(`cache warm stopped: ${reason}`));
  if (!quiet) deps.log(`${sessionId}: stopped (${reason})`);
}

function startChain(sessionId, { request, ttlMs, touchAt, promptTokens, accountId }) {
  const chain = {
    request,
    ttlMs,
    touchAt,
    promptTokens,
    accountId: accountId || '',
    latencyMs: null,
    refreshAt: 0,
    timer: null,
    controller: null,
  };
  chains.set(sessionId, chain);
  scheduleWarm(sessionId, chain);
  return chain;
}

// The provider and account a warm of `chain` goes to: the roster account
// that holds the entry, or the provider itself when it has no roster. null
// when that account is not known.
function warmTarget(chain) {
  const provider = chain.request.provider;
  if (!ACCOUNT_PROVIDERS.includes(provider.name)) return { provider, accountId: '' };
  if (!chain.accountId || typeof provider.forAccount !== 'function') return null;
  return { provider: provider.forAccount(chain.accountId), accountId: chain.accountId };
}

/**
 * Arm the session's warm chain from a real request that settled with
 * `response`, and record the confirmed touch durably; replaces any chain.
 * Nothing is armed — and the durable touch is dropped — for an ineligible
 * request, one without a send time, or a response that does not prove the
 * tier it wrote or the prompt size.
 */
export function armCacheWarm(sessionId, request, response) {
  cancelCacheWarm(sessionId);
  // A real request settled: the session's own activity is the latest use.
  if (sessionId) deps.touches().forgetWarmUse(sessionId);
  // Whatever its provider: after real activity the session's idle clock runs
  // from this request's send (the clock the planner reads). A later request
  // of the same turn only moves it; the next returning turn closes it. A
  // system-caused request leaves it alone.
  if (sessionId && request && realActivity(sessionId, request)) {
    deps.gaps().open(sessionId, Number(request.sentAt));
  }
  if (!sessionId || !request || cacheWarmIneligibility(request)) return;
  const usage = response?.usage || {};
  const touchAt = Number(request.sentAt);
  const ttlMs = writtenCacheTtlMs(usage, request.opts.cacheStrategy);
  const promptTokens =
    typeof usage.promptTokens === 'number'
      ? usage.promptTokens
      : (Number(usage.inputTokens) || 0) + (Number(usage.cachedTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
  if (!(touchAt > 0) || !ttlMs || !(promptTokens > 0)) {
    deps.touches().forget(sessionId);
    return;
  }
  const chain = startChain(sessionId, {
    request,
    ttlMs,
    touchAt,
    promptTokens,
    accountId: response?.providerMetadata?.accountRouting?.accountId,
  });
  recordTouch(sessionId, chain);
}

/**
 * Daemon start: the in-memory chains died with the previous process. Re-arm
 * every touched session while warming is on from its durable touch (prompt-cache-touch-store.mjs: the last confirmed cache
 * use, the tier the provider wrote, the account and prompt size) while the
 * entry still has more than the expiry margin left, replaying the request its
 * next turn rebuilds without the last reply. A candidate's expired touch is
 * dropped; each chain's first refresh point applies its rule. Resolves how
 * many chains were armed.
 */
export async function rearmCacheWarmsAfterRestart() {
  if (!(await deps.enabled())) return 0;
  const candidates = [];
  for (const sessionId of deps.touches().ids()) {
    if (chains.has(sessionId)) continue;
    const touch = deps.touches().get(sessionId);
    if (!touch) continue;
    if (!(deps.now() < touch.touchAt + touch.ttlMs - CACHE_WARM_EXPIRY_MARGIN_MS)) {
      deps.touches().forget(sessionId);
      continue;
    }
    candidates.push([sessionId, touch]);
  }
  if (!candidates.length) return 0;
  await deps.providersReady();
  let armed = 0;
  for (const [sessionId, touch] of candidates) {
    let request = null;
    try {
      request = await deps.lastSentRequest(sessionId);
    } catch (error) {
      deps.log(`${sessionId}: restart re-arm skipped (${error?.message || error})`);
    }
    if (!request || cacheWarmIneligibility(request) || chains.has(sessionId)) continue;
    startChain(sessionId, {
      request,
      ttlMs: touch.ttlMs,
      touchAt: touch.touchAt,
      promptTokens: touch.promptTokens,
      accountId: touch.accountId,
    });
    armed += 1;
  }
  return armed;
}

function scheduleWarm(sessionId, chain) {
  chain.refreshAt = chain.touchAt + cacheWarmDelayMs(chain.ttlMs);
  chain.timer = deps.timers.setTimeout(
    () => void fireWarm(sessionId, chain).catch((error) => stopChain(sessionId, chain, error?.message || error)),
    Math.max(0, chain.refreshAt - deps.now())
  );
  chain.timer?.unref?.();
}

async function fireWarm(sessionId, chain) {
  if (chains.get(sessionId) !== chain) return;
  chain.timer = null;
  if (deps.turnInFlight(sessionId)) return stopChain(sessionId, chain, 'turn in flight');
  const plan = await planFor(sessionId, chain, deps.now());
  if (chains.get(sessionId) !== chain) return;
  if (plan.stop) return stopChain(sessionId, chain, plan.stop);
  // A registry re-initialization replaced the instance the request was
  // captured on: its replay would run on a retired instance, and the request
  // is not rebuilt onto the new one.
  if ((await deps.registeredProvider(chain.request.provider.name)) !== chain.request.provider) {
    return stopChain(sessionId, chain, 'provider instance replaced');
  }
  if (chains.get(sessionId) !== chain) return;
  const target = warmTarget(chain);
  if (!target) return stopChain(sessionId, chain, 'account holding the cache unknown');
  // Last check before dispatch, after the final await: a turn that began
  // during the lookups has the cache to itself.
  if (deps.turnInFlight(sessionId)) return stopChain(sessionId, chain, 'turn in flight');
  const sentAt = deps.now();
  let usage = null;
  let reportedAt = null;
  let failure = null;
  try {
    usage = await deps.send(chain.request, chain, target, (reported) => {
      usage = reported;
      reportedAt ??= deps.now();
    });
  } catch (error) {
    failure = error;
    usage = error?.usage || usage;
  }
  // Billed whatever happened next: success, failure or cancellation.
  if (usage) {
    void Promise.resolve()
      .then(() => deps.recordUsage(chain.request, usage, sentAt, target.accountId))
      .catch((error) => deps.log(`${sessionId}: warm usage not recorded (${error?.message || error})`));
  }
  if (chains.get(sessionId) !== chain) return;
  if (failure) return stopChain(sessionId, chain, `warm failed: ${failure?.message || failure}`);
  if (!(Number(usage?.cachedTokens) > 0) || Number(usage?.cacheWriteTokens) > 0) {
    deps.touches().forget(sessionId);
    return stopChain(sessionId, chain, 'warm missed the cache');
  }
  chain.touchAt = sentAt;
  chain.latencyMs = (reportedAt ?? deps.now()) - sentAt;
  recordTouch(sessionId, chain);
  // A read without a write is cache use: the idle auto-clear counts from it.
  deps.touches().recordWarmUse(sessionId, sentAt);
  scheduleWarm(sessionId, chain);
}
