/**
 * Durable per-day usage rollup (provider × model).
 *
 * The gateway usage store keeps one raw event per turn, but it is bounded to a
 * recent window (TTL + row cap) because it exists to answer "what is happening
 * right now". Totals for a month ago cannot be recovered from it once the cap
 * evicts those rows, so every turn is ALSO folded into a per-day bucket here.
 * A bucket is a few numbers, which keeps years of history in one small file.
 *
 * Most turns on this machine are NOT the user typing: background runners
 * (memory cycles, schedules, webhooks) spend tokens on their own and outnumber
 * conversation turns several times over. Every bucket therefore carries a
 * `conversation` sub-total beside the full one, so "what did I spend" can be
 * answered without the background drowning it.
 *
 * Session token totals are kept id-keyed only while a day is recent; older days
 * keep the anonymous per-session totals alone. Only conversation sessions are
 * tracked: a background runner mints a fresh id per cycle, which would turn
 * "how many sessions" into a count of cycles.
 *
 * `firstTs`/`lastTs` bound the turns already folded into a day. A reader that
 * also holds the raw event list adds ONLY the events outside that span, which
 * is what lets both stores be read together without counting a turn twice.
 *
 * Shape:
 *   {
 *     version, updatedAt,
 *     days: {
 *       "2026-08-12": {
 *         turns, input, output, cacheRead, cacheWrite,
 *         costUsd, costBilled, costEstimated, costKnownTurns,
 *         durationMs, durationTurns, firstTs, lastTs,
 *         conversation: { …the same turn totals, user-driven turns only },
 *         conversationPartial,
 *         models: { "<provider>/<model>": {
 *           provider, model, kind, turns, input, output, cacheRead, cacheWrite,
 *           costUsd, conversation: { …route totals }
 *         } },
 *         sessions: { "<sessionId>": <tokens> },
 *         sessionTokens: [<tokens>, …],
 *         sessionsDropped
 *       }
 *     }
 *   }
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { updateJsonAtomicSync } from '../atomic-file.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { billableInputTokensForProvider } from './cost.mjs';

const USAGE_ROLLUP_FILE = 'usage-rollup.local.json';
const USAGE_ROLLUP_VERSION = 2;

// A day costs well under a kilobyte, so a long retention stays cheap while
// making "all time" mean something closer to the install date.
const RETENTION_DAYS = 400;
// Session ids are the only identifying values in the file; drop them once the
// day is old enough that per-session drill-down no longer matters.
const SESSION_DETAIL_DAYS = 45;
const MAX_MODELS_PER_DAY = 80;
const MAX_SESSION_IDS_PER_DAY = 400;
const MAX_SESSION_TOKENS_PER_DAY = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cleanId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !UNSAFE_KEYS.has(text) ? text.slice(0, 200) : '';
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Local calendar day, so "today" in the UI means the user's today. */
export function usageRollupDayKey(ts) {
  const date = new Date(Number.isFinite(Number(ts)) ? Number(ts) : Date.now());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// A turn belongs to the user's conversation unless it came from one of these
// background runners. An unknown source counts as conversation on purpose: a
// new runner showing up in the user's totals is visible and correctable, while
// silently dropping the user's own turns is neither.
const BACKGROUND_SOURCES = new Set(['memory-cycle', 'schedule', 'webhook', 'native-web-search']);

export function isConversationUsageSource(sourceType) {
  const id = typeof sourceType === 'string' ? sourceType.trim().toLowerCase() : '';
  return !BACKGROUND_SOURCES.has(id);
}

function emptyRouteTotals() {
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
  };
}

function emptyTurnTotals() {
  return {
    ...emptyRouteTotals(),
    durationMs: 0,
    durationTurns: 0,
  };
}

function addRouteTotals(target, turn, { priced, billed } = {}) {
  target.turns += turn.turns;
  target.input += turn.input;
  target.output += turn.output;
  target.cacheRead += turn.cacheRead;
  target.cacheWrite += turn.cacheWrite;
  target.costUsd = round6(target.costUsd + turn.costUsd);
  if (priced) {
    target.costKnownTurns += 1;
    if (billed) target.costBilled = round6(target.costBilled + turn.costUsd);
    else target.costEstimated = round6(target.costEstimated + turn.costUsd);
  }
}

function addTurnTotals(target, turn, pricing) {
  addRouteTotals(target, turn, pricing);
  const { durationMs } = pricing;
  if (durationMs > 0) {
    target.durationMs += durationMs;
    target.durationTurns += 1;
  }
}

function emptyModel(provider, model) {
  return {
    provider,
    model,
    kind: '',
    ...emptyRouteTotals(),
    conversation: emptyRouteTotals(),
  };
}

function emptyDay() {
  return {
    ...emptyTurnTotals(),
    firstTs: 0,
    lastTs: 0,
    conversation: emptyTurnTotals(),
    conversationPartial: false,
    // Rebuilt from session transcripts rather than recorded turn by turn. The
    // flag travels with the bucket so a surface can keep saying so long after
    // the transcripts it came from are gone.
    restored: false,
    // Set once a day's pre-classification session ids have been cleared, which
    // is what tells a reader the remaining ids can be trusted.
    sessionsPurged: true,
    models: {},
    sessions: {},
    sessionTokens: [],
    sessionsDropped: 0,
  };
}

function readRouteTotals(raw, target) {
  target.turns = num(raw?.turns);
  target.input = num(raw?.input);
  target.output = num(raw?.output);
  target.cacheRead = num(raw?.cacheRead);
  target.cacheWrite = num(raw?.cacheWrite);
  target.costUsd = round6(num(raw?.costUsd));
  target.costBilled = round6(num(raw?.costBilled));
  target.costEstimated = round6(
    raw?.costEstimated == null ? Math.max(0, target.costUsd - target.costBilled) : num(raw.costEstimated)
  );
  if (raw?.costKnownTurns != null) target.costKnownTurns = num(raw.costKnownTurns);
  else target.costKnownTurns = target.costUsd > 0 ? target.turns : 0;
  return target;
}

/** Turns with a known cost: the recorded count, else every turn when the usage carries any cost at all. */
export function knownCostTurns(usage, amount = num) {
  if (usage.costKnownTurns != null) return amount(usage.costKnownTurns);
  return amount(usage.costUsd) > 0 ? amount(usage.turns) : 0;
}

function readTurnTotals(raw, target) {
  readRouteTotals(raw, target);
  target.costBilled = round6(num(raw?.costBilled));
  target.costEstimated = round6(num(raw?.costEstimated));
  target.costKnownTurns = num(raw?.costKnownTurns);
  target.durationMs = num(raw?.durationMs);
  target.durationTurns = num(raw?.durationTurns);
  return target;
}

function normalizeModel(raw, key) {
  const slash = typeof key === 'string' ? key.indexOf('/') : -1;
  const bucket = emptyModel(
    cleanId(raw?.provider) || (slash > 0 ? key.slice(0, slash) : ''),
    cleanId(raw?.model) || (slash > 0 ? key.slice(slash + 1) : '')
  );
  bucket.kind = cleanId(raw?.kind);
  readRouteTotals(raw, bucket);
  // A bucket written before turns carried a source has no split to read.
  // `null` means unknown, which a reader must not quietly treat as zero.
  bucket.conversation =
    raw?.conversation && typeof raw.conversation === 'object'
      ? readRouteTotals(raw.conversation, emptyRouteTotals())
      : null;
  return bucket;
}

function normalizeDay(raw) {
  const day = emptyDay();
  readTurnTotals(raw, day);
  day.firstTs = num(raw?.firstTs);
  day.lastTs = num(raw?.lastTs);
  day.conversation =
    raw?.conversation && typeof raw.conversation === 'object'
      ? readTurnTotals(raw.conversation, emptyTurnTotals())
      : null;
  day.conversationPartial = raw?.conversationPartial === true;
  day.restored = raw?.restored === true;
  // A day that never held unclassified turns needs no purge; one that did is
  // trusted only once it says the old ids were cleared.
  day.sessionsPurged = !day.conversationPartial || raw?.sessionsPurged === true;
  day.sessionsDropped = num(raw?.sessionsDropped);
  const models = raw?.models && typeof raw.models === 'object' ? raw.models : {};
  for (const [key, value] of Object.entries(models)) {
    const id = cleanId(key);
    if (!id) continue;
    day.models[id] = normalizeModel(value, id);
  }
  const sessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [key, value] of Object.entries(sessions)) {
    const id = cleanId(key);
    if (!id) continue;
    day.sessions[id] = num(value);
  }
  if (Array.isArray(raw?.sessionTokens)) {
    day.sessionTokens = raw.sessionTokens.map(num).slice(-MAX_SESSION_TOKENS_PER_DAY);
  }
  return day;
}

/** Defensive read: a hand-edited or partially written file must not throw. */
export function normalizeUsageRollup(raw) {
  const days = {};
  const source = raw?.days && typeof raw.days === 'object' ? raw.days : {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    days[key] = normalizeDay(value);
  }
  return {
    version: USAGE_ROLLUP_VERSION,
    updatedAt: num(raw?.updatedAt),
    days,
  };
}

/** Retention + identifier aging. Both bounds are evaluated against `now`. */
function pruneUsageRollup(rollup, now = Date.now()) {
  const dropBefore = usageRollupDayKey(now - RETENTION_DAYS * DAY_MS);
  const anonymizeBefore = usageRollupDayKey(now - SESSION_DETAIL_DAYS * DAY_MS);
  for (const [key, day] of Object.entries(rollup.days)) {
    if (key < dropBefore) {
      delete rollup.days[key];
      continue;
    }
    if (key >= anonymizeBefore) continue;
    const ids = Object.keys(day.sessions);
    if (!ids.length) continue;
    const archived = day.sessionTokens.concat(ids.map((id) => day.sessions[id]));
    day.sessionTokens = archived.slice(-MAX_SESSION_TOKENS_PER_DAY);
    day.sessions = {};
  }
  return rollup;
}

/**
 * Fold one gateway usage summary into the rollup. Pure: the caller owns the
 * document, which is what makes this testable without touching disk.
 */
export function foldUsageRollup(current, summary, now = Date.now()) {
  const rollup = normalizeUsageRollup(current);
  const provider = cleanId(summary?.provider);
  const model = cleanId(summary?.model);
  // A turn that cannot be attributed to a route would silently inflate every
  // total it lands in, so it is dropped rather than bucketed as "unknown".
  if (!provider || !model) return pruneUsageRollup(rollup, now);

  const at = Number(summary?.ts ?? summary?.at);
  const ts = Number.isFinite(at) && at > 0 ? at : now;
  const key = usageRollupDayKey(ts);
  const day = rollup.days[key] || emptyDay();

  const cacheRead = num(summary?.cacheReadTokens);
  const cacheWrite = num(summary?.cacheWriteTokens);
  const turn = {
    turns: 1,
    // Providers disagree about what `inputTokens` counts: several report the
    // whole prompt with the cached part inside it. Stripping it where it is
    // already included is what keeps one cache hit from being counted twice.
    input: billableInputTokensForProvider(provider, num(summary?.inputTokens), cacheRead, cacheWrite),
    output: num(summary?.outputTokens),
    cacheRead,
    cacheWrite,
    costUsd: num(summary?.costUsd),
  };
  const tokens = turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
  const costSource = cleanId(summary?.costSource);
  // costSource 'none' means neither the provider nor the catalog priced this
  // turn; counting it keeps the surface honest about partial cost coverage.
  const pricing = {
    priced:
      summary?.costUsd != null &&
      Number.isFinite(Number(summary.costUsd)) &&
      !['', 'none', 'unpriced'].includes(costSource),
    billed: costSource === 'provider',
    durationMs: num(summary?.durationMs),
  };
  const conversation = isConversationUsageSource(summary?.sourceType);

  addTurnTotals(day, turn, pricing);
  day.firstTs = day.firstTs > 0 ? Math.min(day.firstTs, ts) : ts;
  day.lastTs = Math.max(day.lastTs, ts);
  if (conversation) {
    if (!day.conversation) {
      // A day carried over from before turns were classified: what is already
      // in it stays unattributed, and the flag lets a reader say so.
      day.conversation = emptyTurnTotals();
      day.conversationPartial = true;
      // Those ids were collected while background cycles still counted, and
      // most of them are cycles. Keeping them would report cycles as sessions.
      day.sessions = {};
      day.sessionTokens = [];
      day.sessionsPurged = true;
    }
    addTurnTotals(day.conversation, turn, pricing);
  }

  const modelKey = `${provider}/${model}`;
  const known = Object.hasOwn(day.models, modelKey);
  if (known || Object.keys(day.models).length < MAX_MODELS_PER_DAY) {
    const bucket = known ? day.models[modelKey] : emptyModel(provider, model);
    bucket.kind = cleanId(summary?.providerKind) || bucket.kind;
    addRouteTotals(bucket, turn, pricing);
    if (conversation) {
      if (!bucket.conversation) bucket.conversation = emptyRouteTotals();
      addRouteTotals(bucket.conversation, turn, pricing);
    }
    day.models[modelKey] = bucket;
  }

  // Only conversation sessions are kept: a background runner mints a new id per
  // cycle, so counting those would report cycles as sessions.
  const sessionId = conversation ? cleanId(summary?.sessionId) : '';
  if (sessionId) {
    if (Object.hasOwn(day.sessions, sessionId)) {
      day.sessions[sessionId] += tokens;
    } else if (Object.keys(day.sessions).length < MAX_SESSION_IDS_PER_DAY) {
      day.sessions[sessionId] = tokens;
    } else {
      day.sessionsDropped += 1;
    }
  }

  rollup.days[key] = day;
  rollup.updatedAt = now;
  return pruneUsageRollup(rollup, now);
}

/**
 * Write transcript-rebuilt days into the rollup, so they outlive the sessions
 * they were derived from.
 *
 * The session store prunes: ephemeral sessions past 14 days or beyond the
 * newest 300 are deleted, which silently takes their tokens out of any figure
 * derived from them. The rollup is a few numbers per day kept for 400 days, so
 * once a rebuilt day lands here it stops depending on the transcripts at all.
 *
 * Recording always wins. A day the rollup already holds is left exactly as it
 * is — including a day already frozen this way, because re-deriving it from a
 * half-pruned store would quietly shrink it.
 *
 * Pure: the caller owns the document.
 */
export function freezeRestoredDays(current, historyDays, now = Date.now()) {
  const rollup = normalizeUsageRollup(current);
  const source = historyDays && typeof historyDays === 'object' ? historyDays : {};
  const dropBefore = usageRollupDayKey(now - RETENTION_DAYS * DAY_MS);
  const today = usageRollupDayKey(now);
  let frozen = 0;
  for (const [key, day] of Object.entries(source)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (Object.hasOwn(rollup.days, key)) continue;
    if (key < dropBefore) continue;
    // Today is still being recorded turn by turn; freezing it now would pin a
    // partial rebuild and lock out the rest of the day's real events.
    if (key >= today) continue;
    const bucket = normalizeDay(day);
    if (bucket.turns <= 0) continue;
    bucket.restored = true;
    rollup.days[key] = bucket;
    frozen += 1;
  }
  if (frozen > 0) rollup.updatedAt = now;
  return { rollup, frozen };
}

function resolveRollupPath() {
  const explicit = process.env.MIXDOG_USAGE_ROLLUP_PATH;
  if (explicit) return explicit;
  // Repo test workers drive synthetic turns; those must never land in the
  // user's real rollup. An explicit path above still works inside tests.
  if (process.env.NODE_TEST_CONTEXT) return null;
  try {
    return join(resolvePluginData(), USAGE_ROLLUP_FILE);
  } catch {
    return null;
  }
}

export function usageRollupPath() {
  return resolveRollupPath();
}

/** Fire-and-forget: usage accounting must never affect the model turn. */
export function recordUsageRollup(summary) {
  const path = resolveRollupPath();
  if (!path) return;
  try {
    updateJsonAtomicSync(path, (current) => foldUsageRollup(current, summary), {
      compact: true,
      fsync: false,
      fsyncDir: false,
    });
  } catch {
    // Local telemetry only.
  }
}

/**
 * Persist the rebuilt days. Returns how many were newly frozen, so a caller
 * can tell "nothing left to do" from "the store could not be written".
 */
export function persistRestoredDays(historyDays, now = Date.now()) {
  const path = resolveRollupPath();
  if (!path) return 0;
  let frozen = 0;
  try {
    updateJsonAtomicSync(
      path,
      (current) => {
        const result = freezeRestoredDays(current, historyDays, now);
        frozen = result.frozen;
        // An unchanged document is not rewritten: the mutator returning
        // undefined leaves the file untouched.
        return frozen > 0 ? result.rollup : undefined;
      },
      { compact: true, fsync: false, fsyncDir: false }
    );
  } catch {
    return 0;
  }
  return frozen;
}

export function loadUsageRollup() {
  const path = resolveRollupPath();
  if (!path) return normalizeUsageRollup(null);
  try {
    return normalizeUsageRollup(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return normalizeUsageRollup(null);
  }
}
