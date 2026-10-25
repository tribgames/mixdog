// cache-warm.mjs — keeps a session's prompt cache readable for its next turn
// in the conversations the user chose (`cacheWarming`,
// shared/cache-warm-targets.mjs): toward a known turn (a scheduled fire) that
// comes after the cached entry's refresh point, and, for the idle targets
// (bot chats, bot rooms, favorites, other conversations), one interval at a
// time while the session idles. A warm re-sends the session's last real request
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
// replayed (a different budget changes the message cache key). Sub-agent
// requests are never captured (side-question-store.mjs) and never classified
// as a target (cacheWarmSessionKinds): over a 7-day ledger sample, warming
// them would have cost $343/week net (and they compact after 5 min idle);
// omp task/executor.ts likewise never schedules warms for subagents.
//
// Rule, at each refresh point (one interval min(0.9·T, T−10s) after the last
// confirmed cache use; T is the tier the provider reported writing): warm
// iff P · missCost > remainingWarms · warmCost, where missCost is a write of
// the prompt at that tier minus the read the turn makes anyway, warmCost a
// read of it plus the one output token, remainingWarms the refreshes still
// needed before the due turn, and P the measured chance the due turn arrives
// and still matches the cached prefix. A turn due before the refresh point
// reads the cache itself; a turn the idle auto-clear will compact gets none.
// Any fact the rule needs that is not known (written tier, prices, prompt
// size, the account holding the entry, the auto-clear state) means no warm.
// The chain stops on a miss, a failure, a late timer, a turn in flight, a new
// real request (side-question-store.mjs cancels), a compaction, a clear, a
// close, or a schedule change that removes the due turn
// (revalidateCacheWarms).
//
// Idle rule (planIdleCacheWarm), at each refresh point of a session whose
// kind the user selected: warm one more interval iff P_kind · missCost >
// warmCost (remainingWarms = 1), P_kind the measured chance the session's
// next call comes before the following refresh point (IDLE_RETURN_PROBABILITY,
// per kind and tier; an unmeasured tier gets none). A warm pays only for a
// return after the entry's current expiry that still precedes the idle
// auto-clear deadline (none when auto-clear is off or never clears the
// context) and lies inside the idle window P was measured over
// (IDLE_RETURN_MEASURED_WINDOW_MS after the last real call), so it needs
// touchAt + T before both.
import { ACCOUNT_PROVIDERS } from '../../../shared/provider-accounts.mjs';
import {
  idleAutoClearDeadline,
  idleAutoClearDue,
  sessionActivityTimestamp,
} from '../../../shared/idle-auto-clear-gate.mjs';
import { CACHE_WARM_IDLE_TARGETS, resolveCacheWarmTargets } from '../../../shared/cache-warm-targets.mjs';
import { readSessionSidebarState } from '../../../shared/session-sidebar-host.mjs';
import {
  ANTHROPIC_TAIL_LIFETIME_MS,
  cacheCapabilityForProvider,
  isLeadCacheClass,
  providerTailCacheLifetimeMs,
} from '../agent-runtime/cache-strategy.mjs';
import { anthropicEffortLevelsFor } from '../../../shared/llm/anthropic-effort.mjs';
import { MIXY_AGENT_ID, agentHomeSessionId, isAgentHomeSessionId } from './agent-home.mjs';
import { roomMemberOfSession } from './agent-room.mjs';
import { isTurnInFlight, runtimeState } from './manager/runtime-state.mjs';
import { withTailReminder } from './tail-reminder-rules.mjs';
import { promptCacheTouchStore } from './prompt-cache-touch-store.mjs';

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
// Chance a scheduled routine turn arrives and still matches the previous
// call's cached prefix: the measured share over a 7-day sample of routine
// fires on bot home threads (Anthropic), 93 of 170 (0.547); the lower bound,
// counting fires whose entry had already expired as misses.
export const ROUTINE_TURN_HIT_PROBABILITY = 0.547;
// Chance an idle session's next call comes before the following refresh
// point, per kind and written tier: the share of idle refresh points
// followed by the session's next call before the next point, over a 7-day
// ledger sample (Anthropic) with the auto-clear window lifted to 12 h — the
// only regime where idle warms can matter. A tier with no measurement is
// absent: no warm.
export const IDLE_RETURN_PROBABILITY = Object.freeze({
  // Bot home threads: 1h 27 of 289 points (0.0934); 5m 11 of 825 (0.0133).
  'bot-chats': Object.freeze({ '1h': 0.0934, '5m': 0.0133 }),
  // Bot room member sessions: 1h 6 of 120 (0.050).
  'bot-rooms': Object.freeze({ '1h': 0.05 }),
  // Favorite or pinned conversations: 1h 16 of 307 (0.0521).
  favorites: Object.freeze({ '1h': 0.0521 }),
  // Other Lead conversations: 1h 15 of 467 (0.0321).
  conversations: Object.freeze({ '1h': 0.0321 }),
});
// The idle stretch IDLE_RETURN_PROBABILITY was measured over: the 7-day
// ledger measurement covered idle returns within 12 h of the session's last
// real call; outside it P is not measured, so no idle warm serves a return
// beyond it.
export const IDLE_RETURN_MEASURED_WINDOW_MS = 12 * 60 * 60 * 1000;

/** The targets the user chose (shared/cache-warm-targets.mjs); the
 *  MIXDOG_CACHE_WARMING env list wins when it parses. */
export { resolveCacheWarmTargets };

/**
 * The idle targets session `session` belongs to: 'bot-chats' (a bot's home
 * thread), 'bot-rooms' (a room member session), 'favorites' (`favorite`
 * true: a favorite or pinned conversation) and 'conversations' (any other
 * Lead conversation, known not to be a favorite). A sub-agent or hidden role
 * belongs to none; a plain conversation whose favorite state is unknown
 * (`favorite` null) to none either.
 */
export function cacheWarmSessionKinds(session, { favorite = null } = {}) {
  if (!session?.id || session.visibility === 'agent-only' || !isLeadCacheClass(session.agent, session)) return [];
  const kinds = [];
  if (isAgentHomeSessionId(session.id)) kinds.push('bot-chats');
  else if (roomMemberOfSession(session.id)) kinds.push('bot-rooms');
  if (favorite === true) kinds.push('favorites');
  else if (favorite === false && !kinds.length) kinds.push('conversations');
  return kinds;
}

/** The measured idle-return probability for a session of `kinds` under the
 *  selected `targets` with an entry living `ttlMs`: the highest among the
 *  selected kinds measured at that tier (a warm serves every kind the session
 *  is), or null when none is. */
export function idleReturnProbability(kinds, targets, ttlMs) {
  const tier = TIERS.find((name) => ANTHROPIC_TAIL_LIFETIME_MS[name] === ttlMs);
  let best = null;
  for (const kind of kinds) {
    if (!targets.includes(kind)) continue;
    const p = tier ? IDLE_RETURN_PROBABILITY[kind]?.[tier] : undefined;
    if (p > 0 && (best === null || p > best)) best = p;
  }
  return best;
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

/** The next fire (epoch ms) of a routine that runs in home thread `sessionId`,
 *  from schedule rows (schedules-db.mjs); null when none is known. A fire
 *  the row's defer/skip would skip counts as unknown. */
export function nextRoutineFireFor(sessionId, schedules, now = Date.now()) {
  let next = null;
  for (const schedule of schedules || []) {
    if (!schedule || schedule.enabled === false || schedule.status === 'done') continue;
    if (routineHomeSessionId(schedule) !== sessionId) continue;
    const at = schedule.nextFireAt ? new Date(schedule.nextFireAt).getTime() : NaN;
    if (!(at > now)) continue;
    const skipUntil = Math.max(
      schedule.deferredUntil ? new Date(schedule.deferredUntil).getTime() || 0 : 0,
      schedule.skippedUntil ? new Date(schedule.skippedUntil).getTime() || 0 : 0
    );
    if (skipUntil >= at) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

// The home thread a schedule's turns run in; ownerless rows belong to Mixy.
function routineHomeSessionId(schedule) {
  const owner = typeof schedule?.ownerAgentId === 'string' ? schedule.ownerAgentId.trim() : '';
  return agentHomeSessionId(owner) || agentHomeSessionId(MIXY_AGENT_ID);
}

/** Refreshes still needed when one goes out at `now` for a turn due at
 *  `dueAt`, the entry living `ttlMs`: this one, and one more for every
 *  further interval the turn lies beyond the next refresh point. */
export function cacheWarmRemainingWarms({ now, ttlMs, dueAt }) {
  const interval = cacheWarmDelayMs(ttlMs);
  return 1 + Math.max(0, Math.ceil((dueAt - now - interval) / interval));
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
 * Whether a warm sent at `now` pays off. The entry was last used at `touchAt`
 * and lives `ttlMs`; the known turn is due at `dueAt` with hit probability
 * `probability`; `autoClearAtDue` is whether the idle auto-clear compacts the
 * thread before that turn (null: unknown); `latencyMs` the measured time a
 * warm of this chain took to reach the provider (null: not measured yet).
 * `{ warm: true, warms }` or `{ stop }`.
 */
export function planCacheWarm({
  now,
  touchAt,
  ttlMs,
  dueAt,
  probability,
  promptTokens,
  prices,
  autoClearAtDue,
  latencyMs = null,
}) {
  if (!(dueAt > now)) return { stop: 'no known turn due' };
  if (dueAt <= touchAt + cacheWarmDelayMs(ttlMs)) return { stop: 'turn due before the refresh' };
  if (autoClearAtDue !== false) {
    return { stop: autoClearAtDue ? 'auto-clear compacts the thread before the due turn' : 'auto-clear state unknown' };
  }
  return warmPays({ now, touchAt, ttlMs, probability, promptTokens, prices, latencyMs, warms: () =>
    cacheWarmRemainingWarms({ now, ttlMs, dueAt }) });
}

// The checks both rules share: the warm lands while the entry lives, P is
// known, and P · missCost > warms · warmCost.
function warmPays({ now, touchAt, ttlMs, probability, promptTokens, prices, latencyMs, warms: remaining }) {
  // The warm must reach the provider while the entry still lives.
  const landing = Math.max(CACHE_WARM_EXPIRY_MARGIN_MS, Number(latencyMs) || 0);
  if (touchAt + ttlMs - now <= landing) return { stop: 'late timer' };
  if (!(probability > 0 && probability <= 1)) return { stop: 'hit probability unknown' };
  const economics = cacheWarmEconomics(promptTokens, prices);
  if (!economics) return { stop: 'prompt size or cache prices unknown' };
  const warms = remaining();
  if (!(probability * economics.missCost > warms * economics.warmCost)) {
    return { stop: 'warms cost more than the expected miss' };
  }
  return { warm: true, warms };
}

/**
 * Whether one idle warm sent at `now` pays off: the entry was last used at
 * `touchAt` and lives `ttlMs`; the session's last real call went out at
 * `lastCallAt`; `probability` is the measured idle-return chance (null: not
 * measured for this kind and tier); `autoClearDeadline` when the idle
 * auto-clear starts compacting the thread (null: never; undefined: unknown).
 * `{ warm: true, warms: 1 }` or `{ stop }`.
 */
export function planIdleCacheWarm({
  now,
  touchAt,
  ttlMs,
  lastCallAt,
  probability,
  promptTokens,
  prices,
  autoClearDeadline,
  latencyMs = null,
}) {
  if (autoClearDeadline === undefined) return { stop: 'auto-clear state unknown' };
  if (!(lastCallAt > 0)) return { stop: 'last real call unknown' };
  // The warm serves only a return after the current entry's expiry; that
  // return must still precede the auto-clear deadline (after it the thread
  // is compacted and the cache is moot) and lie inside the idle window P was
  // measured over (beyond it P is unknown).
  if (autoClearDeadline !== null && !(touchAt + ttlMs < autoClearDeadline)) {
    return { stop: 'auto-clear compacts the thread before the cache expires' };
  }
  if (!(touchAt + ttlMs < lastCallAt + IDLE_RETURN_MEASURED_WINDOW_MS)) {
    return { stop: 'idle time reaches the measured window' };
  }
  if (probability === null) return { stop: 'idle return probability not measured for this tier' };
  return warmPays({ now, touchAt, ttlMs, probability, promptTokens, prices, latencyMs, warms: () => 1 });
}

// Defaults of the injectable dependencies.

async function defaultTargets() {
  const { loadConfig } = await import('../config.mjs');
  return resolveCacheWarmTargets(loadConfig({ secrets: false }));
}

const PIN_PREFIX = 'pin:';

// Whether the session is a favorite: pinned on the Bots page (the host-stored
// bot order's `pin:<sessionId>` entries, config `botOrder`) or marked a
// favorite in the desktop's session metadata (read through the
// session-sidebar host). null when no pin says so and no desktop reports its
// favorites.
async function defaultFavoriteState(sessionId) {
  const { loadConfig } = await import('../config.mjs');
  const order = loadConfig({ secrets: false })?.botOrder;
  if (Array.isArray(order) && order.includes(`${PIN_PREFIX}${sessionId}`)) return true;
  const state = await readSessionSidebarState();
  return state?.favorites ? Object.hasOwn(state.favorites, sessionId) : null;
}

async function routineSchedules() {
  const [{ pgClusterExists }, { resolvePluginData }] = await Promise.all([
    import('../../../memory/lib/pg/adapter.mjs'),
    import('../../../shared/plugin-paths.mjs'),
  ]);
  if (!pgClusterExists(resolvePluginData())) return [];
  const { listSchedules } = await import('../../../channels/lib/schedules-db.mjs');
  return listSchedules();
}

async function defaultNextRoutineFire(sessionId, now) {
  return nextRoutineFireFor(sessionId, await routineSchedules(), now);
}

// Home threads an enabled routine runs in (the restart re-arm's candidates).
async function defaultRoutineSessions() {
  const ids = new Set();
  for (const schedule of await routineSchedules()) {
    if (schedule && schedule.enabled !== false && schedule.status !== 'done') ids.add(routineHomeSessionId(schedule));
  }
  return [...ids];
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

// The idle auto-clear settings of a thread on `provider`.
async function defaultAutoClearSettings(provider) {
  const [{ loadConfig }, { autoClearGateSettings }] = await Promise.all([
    import('../config.mjs'),
    import('../runtime-core/config-helpers.mjs'),
  ]);
  return autoClearGateSettings(loadConfig({ secrets: false }), provider);
}

// The thread's context gauge, computed as /context does for a listed session.
async function defaultContextStatus(session) {
  const { contextStatusForSession } = await import('../runtime-core/context-status.mjs');
  return contextStatusForSession(session, { getMode: () => 'full' });
}

/** Whether the idle auto-clear (idle-auto-clear-gate.mjs) compacts the
 *  thread of `request` before a submit at `at`, from the same settings,
 *  activity timestamp and context threshold the submit gate reads. Warms
 *  never move the activity timestamp. */
export async function cacheWarmAutoClearsAt(request, at) {
  const session = request.opts.session;
  const cfg = await deps.autoClearSettings(session.provider || request.provider.name);
  const status = await deps.contextStatus(session);
  return idleAutoClearDue({
    cfg,
    activityAt: sessionActivityTimestamp(session),
    at,
    runtime: { contextStatus: () => status, session },
  });
}

/** From when the idle auto-clear compacts the thread of `request` before a
 *  submit (idleAutoClearDeadline), null when it never does while idle. */
export async function cacheWarmAutoClearDeadline(request) {
  const session = request.opts.session;
  const cfg = await deps.autoClearSettings(session.provider || request.provider.name);
  const status = await deps.contextStatus(session);
  return idleAutoClearDeadline({
    cfg,
    activityAt: sessionActivityTimestamp(session),
    runtime: { contextStatus: () => status, session },
  });
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
  targets: defaultTargets,
  favoriteState: defaultFavoriteState,
  turnInFlight: (sessionId) => isTurnInFlight(runtimeState.get(sessionId)),
  nextRoutineFire: defaultNextRoutineFire,
  routineSessions: defaultRoutineSessions,
  lastSentRequest: defaultLastSentRequest,
  providersReady: defaultProvidersReady,
  registeredProvider: defaultRegisteredProvider,
  prices: defaultPrices,
  autoClearSettings: defaultAutoClearSettings,
  contextStatus: defaultContextStatus,
  send: defaultSend,
  recordUsage: defaultRecordUsage,
  touches: () => promptCacheTouchStore(),
  log: (line) => process.stderr.write(`[cache-warm] ${line}\n`),
});
let deps = DEFAULT_DEPS;

// A routine fire due in the session's home thread (planCacheWarm).
async function planRoutineWarm(sessionId, chain, at) {
  const fireAt = await deps.nextRoutineFire(sessionId, at);
  const dueAt = fireAt > at ? fireAt : null;
  const prices = await deps.prices(chain.request, chain.ttlMs);
  let autoClearAtDue = null;
  if (dueAt) {
    try {
      autoClearAtDue = Boolean(await cacheWarmAutoClearsAt(chain.request, dueAt));
    } catch {
      autoClearAtDue = null;
    }
  }
  return planCacheWarm({
    now: at,
    touchAt: chain.touchAt,
    ttlMs: chain.ttlMs,
    dueAt,
    probability: ROUTINE_TURN_HIT_PROBABILITY,
    promptTokens: chain.promptTokens,
    prices,
    autoClearAtDue,
    latencyMs: chain.latencyMs,
  });
}

// The idle session's own return (planIdleCacheWarm), for the selected kinds
// it belongs to.
async function planIdleWarm(sessionId, chain, at, targets) {
  let favorite = null;
  try {
    favorite = await deps.favoriteState(sessionId);
  } catch {
    favorite = null;
  }
  const kinds = cacheWarmSessionKinds(chain.request.opts.session, { favorite });
  if (!kinds.some((kind) => targets.includes(kind))) return { stop: 'not a selected idle target' };
  let autoClearDeadline;
  try {
    autoClearDeadline = await cacheWarmAutoClearDeadline(chain.request);
  } catch {
    autoClearDeadline = undefined;
  }
  return planIdleCacheWarm({
    now: at,
    touchAt: chain.touchAt,
    ttlMs: chain.ttlMs,
    lastCallAt: Number(chain.request.sentAt),
    probability: idleReturnProbability(kinds, targets, chain.ttlMs),
    promptTokens: chain.promptTokens,
    prices: await deps.prices(chain.request, chain.ttlMs),
    autoClearDeadline,
    latencyMs: chain.latencyMs,
  });
}

/**
 * What tells a session's next turn, each serving some of the targets:
 * `plan(sessionId, chain, at, targets)` answers `{ warm, warms }` or
 * `{ stop }`. The routine trigger knows a due fire; the idle trigger bets on
 * the session's own return one interval at a time.
 */
export const CACHE_WARM_TRIGGERS = Object.freeze([
  Object.freeze({ name: 'routine', targets: Object.freeze(['scheduled']), plan: planRoutineWarm }),
  Object.freeze({ name: 'idle', targets: CACHE_WARM_IDLE_TARGETS, plan: planIdleWarm }),
]);

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

/** Drop the session's chain: clear its timer and abort a warm in flight
 *  (its usage is still accounted). A new real request does this. */
export function cancelCacheWarm(sessionId) {
  const chain = sessionId ? chains.get(sessionId) : null;
  if (chain) stopChain(sessionId, chain, 'canceled', { quiet: true });
}

/** The session's cached prefix is gone or unproven (compaction, clear,
 *  rewind, miss): drop the chain and its durable touch. */
export function forgetCacheWarm(sessionId) {
  cancelCacheWarm(sessionId);
  if (sessionId) deps.touches().forget(sessionId);
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
 * every candidate session — one an enabled routine runs in (`scheduled`
 * selected), and any touched session when an idle target is selected — from
 * its durable touch (prompt-cache-touch-store.mjs: the last confirmed cache
 * use, the tier the provider wrote, the account and prompt size) while the
 * entry still has more than the expiry margin left, replaying the request its
 * next turn rebuilds without the last reply. A candidate's expired touch is
 * dropped; each chain's first refresh point applies its rule. Resolves how
 * many chains were armed.
 */
export async function rearmCacheWarmsAfterRestart() {
  const targets = await deps.targets();
  const ids = new Set();
  if (targets.includes('scheduled')) for (const id of await deps.routineSessions()) ids.add(id);
  if (CACHE_WARM_IDLE_TARGETS.some((target) => targets.includes(target))) {
    for (const id of deps.touches().ids()) ids.add(id);
  }
  const candidates = [];
  for (const sessionId of ids) {
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

// The plan of `chain` at its refresh point `at`: the first selected trigger
// whose rule warms, else every trigger's stop. Unknown facts fail closed.
async function planFor(sessionId, chain, at) {
  const targets = await deps.targets();
  const stops = [];
  for (const trigger of CACHE_WARM_TRIGGERS) {
    if (!trigger.targets.some((target) => targets.includes(target))) continue;
    const plan = await trigger.plan(sessionId, chain, at, targets);
    if (plan.warm) return plan;
    stops.push(`${trigger.name}: ${plan.stop}`);
  }
  return { stop: stops.join('; ') || 'cache warming off' };
}

/**
 * Re-check every armed chain at its pending refresh point now (a routine was
 * paused, deleted or rescheduled): a chain whose plan no longer warms stops
 * at once, aborting a warm in flight.
 */
export async function revalidateCacheWarms() {
  for (const [sessionId, chain] of [...chains]) {
    let plan;
    try {
      plan = await planFor(sessionId, chain, Math.max(deps.now(), chain.refreshAt));
    } catch (error) {
      plan = { stop: `schedule check failed: ${error?.message || error}` };
    }
    if (plan.stop) stopChain(sessionId, chain, plan.stop);
  }
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
  scheduleWarm(sessionId, chain);
}
