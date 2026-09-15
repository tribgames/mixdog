/**
 * Token/cost aggregation by provider, with a per-model drill-down.
 *
 * Two stores answer the same question over different horizons: the raw gateway
 * event list is complete but bounded to a recent window, while the daily rollup
 * survives indefinitely. A day that exists in the rollup is owned by the rollup
 * and the events it already contains are skipped by timestamp, so the events on
 * either side of that span still count and no turn counts twice. Days that
 * predate the rollup are recovered from the events alone.
 *
 * Both stores start at the day they were introduced, and the event list is
 * additionally capped by row count, so neither reaches the months already on
 * disk as session transcripts. A third source rebuilds those days from the
 * transcripts; it is consulted only where the other two have nothing, which is
 * what keeps a recovered day from landing on top of a recorded one.
 *
 * By default only the user's own turns are reported. Background runners spend
 * several times more tokens than the conversation does on this machine, so
 * folding them into the same number answers a question nobody asked.
 *
 * Pure module: callers pass both stores in, which keeps the arithmetic testable
 * and keeps disk access at the runtime boundary.
 */
import { billableInputTokensForProvider } from '../runtime/shared/llm/cost.mjs';
import { hourlySeries } from './usage-stats-hours.mjs';
import { isConversationUsageSource, usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * `days === null` is all time, `0` is today, and N is N calendar dates including
 * today. Day buckets cannot truthfully answer partial historical-day windows.
 */
function resolveWindow(days, now) {
  if (days === 0) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return { days: 0, fromMs: midnight.getTime(), toMs: now };
  }
  const span = Number(days);
  if (!Number.isFinite(span) || span <= 0) return { days: null, fromMs: 0, toMs: now };
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - Math.floor(span) + 1);
  return { days: Math.floor(span), fromMs: first.getTime(), toMs: now };
}

/** The same-length window immediately before this one, for a change figure. */
function previousWindow(window) {
  if (window.days === null) return null;
  // No misleading full-yesterday comparison against an unfinished today.
  if (window.days === 0) return null;
  const first = new Date(window.fromMs);
  first.setDate(first.getDate() - window.days);
  return { days: window.days, fromMs: first.getTime(), toMs: window.fromMs - 1 };
}

function createState() {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    costBilled: 0,
    costEstimated: 0,
    costKnownTurns: 0,
    unmeasuredTurns: 0,
    durationMs: 0,
    durationTurns: 0,
    providers: new Map(),
    sessions: new Map(),
    sessionsComplete: true,
    anonymousSessions: [],
    sessionsDropped: 0,
    dayKeys: new Set(),
    daily: new Map(),
    rollupDays: 0,
    eventDays: 0,
    // Days rebuilt from the session transcripts because neither store holds
    // them any more.
    historyDays: 0,
    // Days written before turns carried a source cannot answer "mine only".
    unclassifiedDays: 0,
    unclassifiedTurns: 0,
    partialDays: 0,
  };
}

function providerBucket(state, provider, kind) {
  let bucket = state.providers.get(provider);
  if (!bucket) {
    bucket = {
      provider,
      providerKind: '',
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      models: new Map(),
      sessions: new Set(),
      sessionsComplete: true,
    };
    state.providers.set(provider, bucket);
  }
  if (kind && !bucket.providerKind) bucket.providerKind = kind;
  return bucket;
}

function modelBucket(provider, model) {
  let bucket = provider.models.get(model);
  if (!bucket) {
    bucket = {
      model,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      sessions: new Set(),
      sessionsComplete: true,
    };
    provider.models.set(model, bucket);
  }
  return bucket;
}

function addUsage(target, usage) {
  target.turns += usage.turns;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.costUsd += usage.costUsd;
  target.costKnownTurns = (target.costKnownTurns || 0) + (usage.costKnownTurns || 0);
  target.costBilled = (target.costBilled || 0) + (usage.costBilled || 0);
  target.costEstimated = (target.costEstimated || 0) + (usage.costEstimated || 0);
  target.unmeasuredTurns = (target.unmeasuredTurns || 0) + (usage.unmeasuredTurns || 0);
}

function foldRoute(state, providerId, modelId, kind, usage) {
  const provider = providerBucket(state, providerId, kind);
  const model = modelBucket(provider, modelId);
  for (const bucket of [provider, model]) {
    addUsage(bucket, usage);
    if (usage.turns > 0 && (!usage.sessions || usage.sessionsComplete === false)) {
      bucket.sessionsComplete = false;
    }
    for (const id of Object.keys(usage.sessions || {})) bucket.sessions.add(id);
  }
  state.turns += usage.turns;
  state.input += usage.input;
  state.output += usage.output;
  state.cacheRead += usage.cacheRead;
  state.cacheWrite += usage.cacheWrite;
  state.costUsd += usage.costUsd;
  state.costKnownTurns += usage.costKnownTurns || 0;
  state.costBilled += usage.costBilled || 0;
  state.costEstimated += usage.costEstimated || 0;
  state.unmeasuredTurns += usage.unmeasuredTurns || 0;
}

function addDaily(state, key, usage, providerId) {
  let bucket = state.daily.get(key);
  if (!bucket) {
    bucket = {
      day: key,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      // Per-provider split of this day, so a chart can show WHICH provider a
      // day's spend went to instead of one anonymous total.
      providers: new Map(),
    };
    state.daily.set(key, bucket);
  }
  addUsage(bucket, usage);
  const id = text(providerId);
  if (!id) return;
  let slice = bucket.providers.get(id);
  if (!slice) {
    slice = { provider: id, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    bucket.providers.set(id, slice);
  }
  addUsage(slice, usage);
}

function foldRollupDay(state, key, day, conversationOnly) {
  const totals = conversationOnly ? day?.conversation : day;
  if (!totals) {
    // The whole day predates source attribution. Leaving it out is the only
    // honest answer for a conversation-only view; the count reports the gap.
    state.unclassifiedDays += 1;
    state.unclassifiedTurns += num(day?.turns);
    return;
  }
  state.dayKeys.add(key);
  // A rebuilt day keeps saying so after it is frozen into the rollup, which is
  // the only thing left distinguishing it from a recorded one.
  if (day?.restored === true) state.historyDays += 1;
  if (day?.importedPartial === true) state.partialDays += 1;
  if (conversationOnly && day?.conversationPartial === true) state.partialDays += 1;
  state.durationMs += num(totals.durationMs);
  state.durationTurns += num(totals.durationTurns);
  state.sessionsDropped += num(day?.sessionsDropped);
  if (totals.sessionsComplete === false || num(day?.sessionsDropped) > 0) state.sessionsComplete = false;

  const models = day?.models && typeof day.models === 'object' ? day.models : {};
  for (const [routeKey, raw] of Object.entries(models)) {
    const route = conversationOnly ? raw?.conversation : raw;
    if (!route) continue;
    const slash = routeKey.indexOf('/');
    const providerId = text(raw?.provider) || (slash > 0 ? routeKey.slice(0, slash) : '');
    const modelId = text(raw?.model) || (slash > 0 ? routeKey.slice(slash + 1) : '');
    if (!providerId || !modelId) continue;
    const usage = {
      turns: num(route.turns),
      input: num(route.input),
      output: num(route.output),
      cacheRead: num(route.cacheRead),
      cacheWrite: num(route.cacheWrite),
      costUsd: num(route.costUsd),
      costKnownTurns: route.costKnownTurns == null
        ? (num(route.costUsd) > 0 ? num(route.turns) : 0) : num(route.costKnownTurns),
      costBilled: num(route.costBilled),
      costEstimated: route.costEstimated == null
        ? Math.max(0, num(route.costUsd) - num(route.costBilled)) : num(route.costEstimated),
      sessions: route.sessions,
      sessionsComplete: route.sessionsComplete,
      unmeasuredTurns: num(route.unmeasuredTurns),
    };
    foldRoute(state, providerId, modelId, text(raw?.kind), usage);
    addDaily(state, key, usage, providerId);
  }

  // Session ids are recorded for conversation turns only, so both views read
  // the same map: a background cycle has no session worth counting. The one
  // exception is a day whose ids were collected while cycles still counted and
  // never cleared — keeping those would inflate the count by an order of
  // magnitude. The raw events still cover such a recent day.
  const partial = conversationOnly && day?.conversationPartial === true && day?.sessionsPurged !== true;
  const sessions = !partial && day?.sessions && typeof day.sessions === 'object' ? day.sessions : {};
  for (const [id, tokens] of Object.entries(sessions)) {
    // One session can span midnight; its totals are summed across days.
    state.sessions.set(id, (state.sessions.get(id) || 0) + num(tokens));
  }
  if (!partial && Array.isArray(day?.sessionTokens)) {
    for (const tokens of day.sessionTokens) state.anonymousSessions.push(num(tokens));
    if (day.sessionTokens.length) state.sessionsComplete = false;
  }
}

function foldEvent(state, key, event, conversationOnly) {
  const conversation = isConversationUsageSource(event?.sourceType);
  if (conversationOnly && !conversation) return;
  const providerId = text(event?.provider);
  const modelId = text(event?.model);
  if (!providerId || !modelId) return;
  state.dayKeys.add(key);

  const cacheRead = num(event?.cacheReadTokens);
  const cacheWrite = num(event?.cacheWriteTokens);
  const sessionId = conversation ? text(event?.sessionId) : '';
  const costSource = text(event?.costSource);
  const priced = event?.costUsd != null && Number.isFinite(Number(event.costUsd))
    && !['', 'none', 'unpriced'].includes(costSource);
  const usage = {
    turns: 1,
    // Same normalization the rollup applies: a provider that reports the whole
    // prompt as input would otherwise have its cache counted twice.
    input: billableInputTokensForProvider(providerId, num(event?.inputTokens), cacheRead, cacheWrite),
    output: num(event?.outputTokens),
    cacheRead,
    cacheWrite,
    costUsd: num(event?.costUsd),
    costKnownTurns: priced ? 1 : 0,
    costBilled: priced && costSource === 'provider' ? num(event.costUsd) : 0,
    costEstimated: priced && costSource !== 'provider' ? num(event.costUsd) : 0,
    sessions: sessionId ? { [sessionId]: 1 } : {},
    sessionsComplete: !conversation || Boolean(sessionId),
  };
  foldRoute(state, providerId, modelId, text(event?.providerKind), usage);
  addDaily(state, key, usage, providerId);

  const durationMs = num(event?.durationMs);
  if (durationMs > 0) {
    state.durationMs += durationMs;
    state.durationTurns += 1;
  }
  if (sessionId) {
    const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    state.sessions.set(sessionId, (state.sessions.get(sessionId) || 0) + tokens);
  } else if (conversation) state.sessionsComplete = false;
}

function collect({ events, rollupDays, historyDays, window, conversationOnly }) {
  const fromKey = window.fromMs > 0 ? usageRollupDayKey(window.fromMs) : '';
  const toKey = usageRollupDayKey(window.toMs);
  const state = createState();

  const eventsByDay = new Map();
  for (const event of events) {
    const ts = Number(event?.ts);
    if (!Number.isFinite(ts) || ts < window.fromMs || ts > window.toMs) continue;
    const key = usageRollupDayKey(ts);
    const group = eventsByDay.get(key);
    if (group) group.push(event);
    else eventsByDay.set(key, [event]);
  }
  // The event list is bounded by row count, and the cap evicts the oldest rows
  // first, so its earliest day is the one arriving half-eaten. Every later day
  // is whole. Naming it here lets the rebuild step below take that one day back
  // without second-guessing the days the store really does cover.
  const truncatedEventDay = eventsByDay.size
    ? [...eventsByDay.keys()].sort()[0]
    : '';

  // The rollup owns every day it holds, because it outlives the event cap.
  // firstTs/lastTs say which turns it already contains, so only the events
  // outside that span are added on top — the turns of the day before rolling
  // up began, and anything written after the last fold. A bucket from before
  // those bounds existed carries no span: there the fuller store is taken
  // whole, since nothing distinguishes an overlapping turn from a new one.
  for (const [key, day] of Object.entries(rollupDays)) {
    if (key < fromKey || key > toKey) continue;
    const group = eventsByDay.get(key);
    // A bucket written before turns carried a source cannot answer "mine
    // only". Where the raw events still cover that day they can, so they are
    // used instead of dropping the day entirely.
    if (conversationOnly && !day?.conversation && group && group.length) continue;
    const firstTs = num(day?.firstTs);
    const lastTs = num(day?.lastTs);
    if (firstTs > 0 && lastTs > 0) {
      const extra = group
        ? group.filter((event) => {
          const ts = Number(event?.ts);
          return Number.isFinite(ts) && (ts < firstTs || ts > lastTs);
        })
        : [];
      if (extra.length) eventsByDay.set(key, extra);
      else eventsByDay.delete(key);
    } else {
      if (group && group.length > num(day?.turns)) continue;
      eventsByDay.delete(key);
    }
    state.rollupDays += 1;
    foldRollupDay(state, key, day, conversationOnly);
  }

  // Transcript-derived days are the last resort: a recorded day always wins,
  // whether it came from the rollup or from the events still on disk. Only the
  // days neither store reaches — everything before recording began, and
  // everything the event cap evicted — are taken from here.
  for (const [key, day] of Object.entries(historyDays || {})) {
    if (key < fromKey || key > toKey) continue;
    if (rollupDays[key]) continue;
    const group = eventsByDay.get(key);
    if (group && group.length) {
      // A whole day of events outranks a rebuild of it.
      if (key !== truncatedEventDay) continue;
      // On the truncated day the two sources are compared as wholes and the
      // fuller one takes the day: the surviving rows would otherwise report a
      // full day of work as the handful of turns the cap happened to spare.
      if (num(day?.turns) <= group.length) continue;
      eventsByDay.delete(key);
    }
    foldRollupDay(state, key, day, conversationOnly);
  }

  state.eventDays = eventsByDay.size;
  for (const [key, group] of eventsByDay) {
    for (const event of group) foldEvent(state, key, event, conversationOnly);
  }
  return state;
}

/** Every calendar day from `first` to `last`, inclusive. */
function calendarDays(first, last) {
  if (!first || !last) return [];
  const out = [];
  const cursor = new Date(`${first}T00:00:00`);
  const end = Date.parse(`${last}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end)) return [];
  // Walking the Date itself (rather than adding 24h) keeps a daylight-saving
  // boundary from shifting the key by a day.
  while (cursor.getTime() <= end) {
    out.push(usageRollupDayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
    if (out.length > 4000) break;
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// "tokens" is everything a turn moved: fresh input, output, and the cached
// prompt it read or wrote. Cached providers re-read the whole context every
// turn, so counting only the fresh part made a cached route look idle beside
// an uncached one doing the same work. The split stays in input/output/cache.
function tokensOf(bucket) {
  return bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
}

function exportRoute(bucket, totalTokens) {
  const tokens = tokensOf(bucket);
  const fresh = bucket.input + bucket.output;
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite;
  const unmeasuredTurns = num(bucket.unmeasuredTurns);
  const unknown = unmeasuredTurns > 0 && unmeasuredTurns === bucket.turns;
  return {
    turns: bucket.turns,
    // Ids that were seen are counted even when some turns carried none: the
    // figure is then a floor, and the flag says so, rather than an unknown.
    sessions: bucket.sessions.size,
    sessionsComplete: bucket.sessionsComplete,
    input: unknown ? null : bucket.input,
    output: bucket.output,
    cacheRead: unknown ? null : bucket.cacheRead,
    cacheWrite: unknown ? null : bucket.cacheWrite,
    cacheTokens: bucket.cacheRead + bucket.cacheWrite,
    tokens,
    unmeasuredTurns,
    costUsd: round(bucket.costUsd, 6),
    costBilled: round(num(bucket.costBilled), 6),
    costEstimated: round(num(bucket.costEstimated), 6),
    costKnownTurns: num(bucket.costKnownTurns),
    costUnpricedTurns: Math.max(0, bucket.turns - num(bucket.costKnownTurns)),
    costCoverage: bucket.turns > 0 ? num(bucket.costKnownTurns) / bucket.turns : 0,
    share: unmeasuredTurns > 0 ? null : totalTokens > 0 ? round(tokens / totalTokens, 6) : 0,
    // How much of this route's prompt arrived from cache instead of being read
    // again. Cache writes are misses, so belong in the denominator, not the
    // numerator.
    cacheHitRate: unmeasuredTurns > 0 ? null : prompt > 0 ? round(bucket.cacheRead / prompt, 4) : 0,
    // What a million fresh tokens actually cost on this route. Cache is excluded
    // from the divisor: including it would divide real spend by a number two
    // orders of magnitude larger and rank every route as free.
    costPerMTokens: fresh > 0 ? round(bucket.costUsd / (fresh / 1_000_000), 4) : 0,
    // Answer length, which is what separates a terse route from a verbose one
    // at the same price.
    outputPerTurn: bucket.turns > 0 ? Math.round(bucket.output / bucket.turns) : 0,
  };
}

/**
 * @param {object} options
 * @param {Array}  [options.events] raw gateway usage events
 * @param {object} [options.rollup] normalized daily rollup document
 * @param {number} [options.now]
 * @param {number|null} [options.days] null = all time, 0 = today, N = last N days
 * @param {number} [options.modelLimit] 0 = every model
 * @param {'conversation'|'all'} [options.source] default: the user's own turns
 * @param {object|null} [options.period] calendar selection from resolveUsageStatsPeriod
 */
export function usageStatsSnapshot({
  events = [],
  rollup = null,
  history = null,
  historyPending = false,
  now = Date.now(),
  days = null,
  period = null,
  modelLimit = 0,
  source = 'conversation',
} = {}) {
  const conversationOnly = source !== 'all';
  const window = period
    ? { days: period.days, fromMs: period.fromMs, toMs: period.toMs }
    : resolveWindow(days, now);
  const rollupDays = rollup?.days && typeof rollup.days === 'object' ? rollup.days : {};
  const historyDays = history?.days && typeof history.days === 'object'
    ? history.days
    : history && typeof history === 'object' ? history : {};
  const eventList = Array.isArray(events) ? events : [];
  const state = collect({ events: eventList, rollupDays, historyDays, window, conversationOnly });

  const cacheTokens = state.cacheRead + state.cacheWrite;
  const totalTokens = state.input + state.output + cacheTokens;
  const sessionTotals = [...state.sessions.values(), ...state.anonymousSessions];
  const dayKeys = [...state.dayKeys].sort();
  const firstDay = dayKeys[0] || '';
  const lastDay = dayKeys[dayKeys.length - 1] || '';
  // Cost per day is read against the calendar span, not the days that happened
  // to have traffic — an idle day still spends nothing and must dilute it.
  const endDay = usageRollupDayKey(window.toMs);
  const spanDays = firstDay
    ? calendarDays(firstDay, endDay).length
    : 0;
  const effectiveDays = window.days === null
    ? spanDays
    : Math.max(1, window.days || 1);

  const providers = [...state.providers.values()]
    .map((bucket) => {
      const models = [...bucket.models.values()]
        .map((model) => ({ model: model.model, ...exportRoute(model, totalTokens) }))
        .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd);
      return {
        provider: bucket.provider,
        providerKind: bucket.providerKind,
        ...exportRoute(bucket, totalTokens),
        modelCount: models.length,
        models: modelLimit > 0 ? models.slice(0, modelLimit) : models,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd);

  // A day with no traffic is still a day. Only the days that HAD usage are
  // collected above, so an idle stretch would otherwise vanish and pull the
  // surrounding days together — a fortnight off would read as continuous work.
  // Filling the calendar keeps a quiet day visible as a quiet day.
  const daily = calendarDays(window.days === null ? firstDay : usageRollupDayKey(window.fromMs), period?.endDay || endDay).map((day) => {
    const bucket = state.daily.get(day);
    const future = period ? { future: day > endDay } : {};
    if (!bucket) {
      return { day, turns: 0, tokens: 0, cacheTokens: 0, costUsd: 0, costKnownTurns: 0, providers: [], ...future };
    }
    return {
      day: bucket.day,
      turns: bucket.turns,
      tokens: tokensOf(bucket),
      cacheTokens: bucket.cacheRead + bucket.cacheWrite,
      costUsd: round(bucket.costUsd, 6),
      costKnownTurns: num(bucket.costKnownTurns),
      unmeasuredTurns: num(bucket.unmeasuredTurns),
      ...future,
      providers: [...bucket.providers.values()]
        .map((slice) => ({
          provider: slice.provider,
          turns: slice.turns,
          tokens: tokensOf(slice),
          costUsd: round(slice.costUsd, 6),
          costKnownTurns: num(slice.costKnownTurns),
          unmeasuredTurns: num(slice.unmeasuredTurns),
        }))
        .sort((a, b) => b.tokens - a.tokens),
    };
  });

  // "All time" has nothing before it to compare against.
  const earlier = period ? null : previousWindow(window);
  const prior = earlier
    ? collect({ events: eventList, rollupDays, historyDays, window: earlier, conversationOnly })
    : null;

  return {
    generatedAt: now,
    ...(period ? { period } : {}),
    ...(period?.view === 'hour' ? { hourly: hourlySeries(rollup?.hourly, period, conversationOnly) } : {}),
    source: conversationOnly ? 'conversation' : 'all',
    range: {
      days: window.days,
      fromMs: window.fromMs,
      toMs: window.toMs,
      firstDay,
      lastDay,
      activeDays: dayKeys.length,
    },
    totals: {
      sessions: sessionTotals.length,
      sessionsComplete: state.sessionsComplete,
      turns: state.turns,
      days: effectiveDays,
      input: state.input,
      output: state.output,
      tokens: totalTokens,
      unmeasuredTurns: state.unmeasuredTurns,
      cacheRead: state.cacheRead,
      cacheWrite: state.cacheWrite,
      cacheTokens,
      totalTokens,
      // How much of the prompt arrived from cache instead of being read again.
      cacheHitRate: state.unmeasuredTurns > 0 ? null : state.input + state.cacheRead + state.cacheWrite > 0
        ? round(state.cacheRead / (state.input + state.cacheRead + state.cacheWrite), 4)
        : 0,
      costUsd: round(state.costUsd, 6),
      costKnownTurns: state.costKnownTurns,
      costUnpricedTurns: Math.max(0, state.turns - state.costKnownTurns),
      // Priced by the provider vs derived from the catalog. A subscription turn
      // lands in the second: real spend, but never an invoice line.
      costBilled: round(state.costBilled, 6),
      costEstimated: round(state.costEstimated, 6),
      costPerDay: effectiveDays > 0 ? round(state.costUsd / effectiveDays, 6) : 0,
      tokensPerSession: sessionTotals.length
        ? Math.round(totalTokens / sessionTotals.length)
        : 0,
      medianTokensPerSession: Math.round(median(sessionTotals)),
      avgDurationMs: state.durationTurns > 0
        ? Math.round(state.durationMs / state.durationTurns)
        : 0,
      // 1 = every turn carries a real price; below that some rows are unpriced.
      costCoverage: state.turns > 0 ? round(state.costKnownTurns / state.turns, 4) : 0,
    },
    previous: prior
      ? {
        turns: prior.turns,
        tokens: tokensOf(prior),
        costUsd: round(prior.costUsd, 6),
      }
      : null,
    daily,
    providers,
    coverage: {
      rollupDays: state.rollupDays,
      eventDays: state.eventDays,
      // Days rebuilt from transcripts, and whether that rebuild is still
      // running — a surface can then say the older figures may still grow.
      historyDays: state.historyDays,
      historyPending: historyPending === true,
      sessionsDropped: state.sessionsDropped,
      // Days the rollup holds without a source split; excluded from a
      // conversation-only view rather than guessed at.
      unclassifiedDays: state.unclassifiedDays,
      unclassifiedTurns: state.unclassifiedTurns,
      partialDays: state.partialDays,
    },
  };
}
