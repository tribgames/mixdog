/**
 * Long-range usage recovered from the durable session stores.
 *
 * The gateway event list is capped by row count and the daily rollup only
 * carries days recorded after rolling up began, so both stores answer "what
 * happened recently" and neither can answer "what did I ever spend on Grok".
 * The session documents can: every session keeps its own lifetime token
 * counters, its route, and its transcript timestamps, and they outlive both
 * telemetry stores.
 *
 * So this module rebuilds per-day totals from those documents. The rebuild is
 * a derivation, not a second recording: a day that the rollup or the raw
 * events already cover is never taken from here, which is what keeps a turn
 * from being counted twice.
 *
 * Two things are approximations, and both are marked `restored` so a surface
 * can say so:
 *   - a session carries ONE set of token counters, so a session that changed
 *     model mid-way is attributed to the route it ended on;
 *   - those counters are not stamped per turn, so a session that spans days is
 *     split across them by how many messages each day holds.
 */
import { billableInputTokensForProvider, computeCostUsd } from './cost.mjs';
import { cleanId as clean, isConversationUsageSource, num, round6, usageRollupDayKey } from './usage-rollup.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Timestamp a transcript message was written at, when it carries one. */
function messageTimestamp(message) {
  const direct = num(message?.createdAt);
  if (direct > 0) return direct;
  return num(message?.meta?.transcript?.at);
}

/**
 * Spread `total` across `keys` in proportion to `weights`, keeping the sum
 * exact: the rounding remainder lands on the heaviest day rather than
 * disappearing from the totals.
 */
function distribute(total, keys, weights, weightSum) {
  const out = new Map();
  if (!(total > 0) || !keys.length) return out;
  if (keys.length === 1 || !(weightSum > 0)) {
    out.set(keys[0], total);
    return out;
  }
  let assigned = 0;
  let heaviest = keys[0];
  let heaviestWeight = -1;
  for (const key of keys) {
    const weight = weights.get(key) || 0;
    const share = Math.floor((total * weight) / weightSum);
    out.set(key, share);
    assigned += share;
    if (weight > heaviestWeight) {
      heaviest = key;
      heaviestWeight = weight;
    }
  }
  if (assigned < total) out.set(heaviest, (out.get(heaviest) || 0) + (total - assigned));
  return out;
}

/**
 * One session document → the per-day slices it contributes.
 * Returns null for a session that never spent a token, which is most of the
 * short-lived ids a daemon mints.
 */
export function summarizeSessionUsage(doc) {
  const provider = clean(doc?.provider);
  const model = clean(doc?.model);
  if (!provider || !model) return null;

  const cacheRead = num(doc?.totalCachedReadTokens);
  const cacheWrite = num(doc?.totalCacheWriteTokens);
  // `totalUncachedInputTokens` is already the billable part. Where a session
  // predates that counter the raw input is unpacked the same way the rollup
  // does it, so a provider that reports the cache inside `input` is not
  // counted twice.
  const input =
    num(doc?.totalUncachedInputTokens) ||
    billableInputTokensForProvider(provider, num(doc?.totalInputTokens), cacheRead, cacheWrite);
  const output = num(doc?.totalOutputTokens);
  if (input + output + cacheRead + cacheWrite <= 0) return null;

  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  const weights = new Map();
  let weightSum = 0;
  let firstTs = 0;
  let lastTs = 0;
  let userTurns = 0;
  for (const message of messages) {
    if (message?.role === 'user') userTurns += 1;
    const ts = messageTimestamp(message);
    if (ts <= 0) continue;
    const key = usageRollupDayKey(ts);
    weights.set(key, (weights.get(key) || 0) + 1);
    weightSum += 1;
    firstTs = firstTs > 0 ? Math.min(firstTs, ts) : ts;
    lastTs = Math.max(lastTs, ts);
  }
  // A transcript compacted down to nothing still spent what it spent; the day
  // it was last used is the only timestamp left to attribute it to.
  if (!weights.size) {
    const fallback = num(doc?.updatedAt) || num(doc?.lastUsedAt) || num(doc?.createdAt);
    if (!fallback) return null;
    const key = usageRollupDayKey(fallback);
    weights.set(key, 1);
    weightSum = 1;
    firstTs = fallback;
    lastTs = fallback;
  }

  const keys = [...weights.keys()].sort();
  const turns = Math.max(1, userTurns);
  const byInput = distribute(input, keys, weights, weightSum);
  const byOutput = distribute(output, keys, weights, weightSum);
  const byCacheRead = distribute(cacheRead, keys, weights, weightSum);
  const byCacheWrite = distribute(cacheWrite, keys, weights, weightSum);
  const byTurns = distribute(turns, keys, weights, weightSum);

  const days = {};
  for (const key of keys) {
    const slice = {
      turns: byTurns.get(key) || 0,
      input: byInput.get(key) || 0,
      output: byOutput.get(key) || 0,
      cacheRead: byCacheRead.get(key) || 0,
      cacheWrite: byCacheWrite.get(key) || 0,
      costUsd: 0,
    };
    if (slice.turns + slice.input + slice.output + slice.cacheRead + slice.cacheWrite <= 0) continue;
    let costUsd = 0;
    try {
      costUsd = num(
        computeCostUsd({
          provider,
          model,
          uncachedInputTokens: slice.input,
          outputTokens: slice.output,
          cacheReadTokens: slice.cacheRead,
          cacheWriteTokens: slice.cacheWrite,
        })
      );
    } catch {
      // An unpriced model still reports its tokens.
    }
    slice.costUsd = round6(costUsd);
    days[key] = slice;
  }
  if (!Object.keys(days).length) return null;

  return {
    provider,
    model,
    sessionId: clean(doc?.id),
    conversation: isConversationUsageSource(doc?.sourceType),
    firstTs,
    lastTs,
    days,
  };
}

function emptyRouteTotals() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function emptyTurnTotals() {
  return {
    ...emptyRouteTotals(),
    costBilled: 0,
    // Nothing here was priced by a provider invoice: the catalog priced it.
    costEstimated: 0,
    costKnownTurns: 0,
    durationMs: 0,
    durationTurns: 0,
  };
}

/** Rollup-shaped so the stats model folds a restored day with the same code. */
function emptyHistoryDay() {
  return {
    ...emptyTurnTotals(),
    firstTs: 0,
    lastTs: 0,
    conversation: emptyTurnTotals(),
    conversationPartial: false,
    sessionsPurged: true,
    // Tells a reader these numbers were derived from transcripts rather than
    // recorded turn by turn.
    restored: true,
    models: {},
    sessions: {},
    sessionTokens: [],
    sessionsDropped: 0,
  };
}

function addRouteTotals(target, slice) {
  target.turns += slice.turns;
  target.input += slice.input;
  target.output += slice.output;
  target.cacheRead += slice.cacheRead;
  target.cacheWrite += slice.cacheWrite;
  target.costUsd = round6(target.costUsd + slice.costUsd);
}

function addTurnTotals(target, slice) {
  addRouteTotals(target, slice);
  if (slice.costUsd > 0) {
    target.costEstimated = round6(target.costEstimated + slice.costUsd);
    target.costKnownTurns += slice.turns;
  }
}

/** Fold every cached session summary into one day-keyed document. */
export function buildUsageHistoryDays(entries) {
  const days = {};
  for (const entry of entries) {
    if (!entry?.provider || !entry?.model || !entry?.days) continue;
    const routeKey = `${entry.provider}/${entry.model}`;
    for (const [key, slice] of Object.entries(entry.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const day = days[key] || emptyHistoryDay();
      const normalized = {
        turns: num(slice?.turns),
        input: num(slice?.input),
        output: num(slice?.output),
        cacheRead: num(slice?.cacheRead),
        cacheWrite: num(slice?.cacheWrite),
        costUsd: num(slice?.costUsd),
      };
      addTurnTotals(day, normalized);
      if (entry.conversation) addTurnTotals(day.conversation, normalized);

      const bucket = day.models[routeKey] || {
        provider: entry.provider,
        model: entry.model,
        kind: '',
        ...emptyRouteTotals(),
        conversation: emptyRouteTotals(),
      };
      addRouteTotals(bucket, normalized);
      if (entry.conversation) addRouteTotals(bucket.conversation, normalized);
      day.models[routeKey] = bucket;

      // Only conversation ids count as sessions, matching the rollup: a
      // background runner mints a fresh id per cycle.
      if (entry.conversation && entry.sessionId) {
        const tokens = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite;
        day.sessions[entry.sessionId] = (day.sessions[entry.sessionId] || 0) + tokens;
      }
      const dayStart = Date.parse(`${key}T00:00:00`);
      if (Number.isFinite(dayStart)) {
        const first = num(entry.firstTs);
        const last = num(entry.lastTs);
        const from = first > dayStart && first < dayStart + DAY_MS ? first : dayStart;
        const to = last > dayStart && last < dayStart + DAY_MS ? last : dayStart + DAY_MS - 1;
        day.firstTs = day.firstTs > 0 ? Math.min(day.firstTs, from) : from;
        day.lastTs = Math.max(day.lastTs, to);
      }
      days[key] = day;
    }
  }
  return days;
}
