// One durable accounting store. No transcript rescans or diagnostic retention
// dependencies after the one-time import of surviving historical originals.
import { getUsageLedger } from '../runtime/shared/llm/usage-ledger.mjs';
import { importUsageHistory } from '../runtime/shared/llm/usage-ledger-import.mjs';
import { refreshUnpricedUsageAsync } from '../runtime/shared/llm/usage-pricing-refresh.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { sessionUsageSnapshot, usageStatsSnapshot } from './services/usage-stats-model.mjs';
import { resolveUsageStatsPeriod } from './services/usage-stats-period.mjs';
import { isConversationUsageSource, usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';
import { isLeadVisibleRow } from '../runtime/agent/orchestrator/session/store-summary-catalog.mjs';
import { agentIdOfHomeSession } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import {
  ACCOUNT_PROVIDERS,
  accountScopedSessionId,
  readProviderAccountPool,
} from '../runtime/shared/provider-accounts.mjs';

const MAX_MODEL_LIMIT = 50;
const SNAPSHOT_REUSE_MS = 1000;
const SNAPSHOT_CACHE_LIMIT = 8;

const quotaText = (value) => (typeof value === 'string' ? value.slice(0, 200) : '');

// What the ledger cannot know: each subscription account's label and place in
// its provider's account pool, the order the account picker lists them in.
function labelQuotaHistory(history, accountPool, accountEmails) {
  const rosters = new Map();
  const emails = new Map();
  const emailsOf = (provider) => {
    if (!emails.has(provider)) {
      try {
        emails.set(provider, accountEmails(provider) || {});
      } catch {
        emails.set(provider, {});
      }
    }
    return emails.get(provider);
  };
  const rosterOf = (provider) => {
    if (!ACCOUNT_PROVIDERS.includes(provider)) return [];
    if (!rosters.has(provider)) {
      try {
        rosters.set(provider, accountPool(provider).accounts);
      } catch {
        rosters.set(provider, []);
      }
    }
    return rosters.get(provider);
  };
  return {
    ...history,
    subscriptions: (history.subscriptions || []).map((row) => {
      const roster = rosterOf(row.provider);
      const rank = roster.findIndex((entry) => entry.id === row.account);
      const email = rank < 0 ? '' : quotaText(emailsOf(row.provider)[row.account]);
      // History of an account that left the roster stays stored, but the
      // picker must not offer it. The implicit `default` account of a provider
      // with no stored roster is still current.
      const inRoster =
        !ACCOUNT_PROVIDERS.includes(row.provider) || rank >= 0 || (row.account === 'default' && !roster.length);
      return {
        ...row,
        accountLabel: roster[rank]?.label || '',
        accountRank: rank < 0 ? null : rank,
        accountInRoster: inRoster,
        ...(email ? { accountEmail: email } : {}),
      };
    }),
  };
}

// The account each subscription is used through now, as its account pool
// says: the one a question naming no account is about.
function accountsInUse(accountPool) {
  const inUse = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    try {
      const id = quotaText(accountPool(provider).selectedId);
      if (id) inUse[provider] = id;
    } catch {
      /* an unreadable pool leaves the choice to the ledger */
    }
  }
  return inUse;
}

// Each subscription provider's account ids, read once per request.
function accountScopes(accountPool) {
  const scopes = [];
  for (const provider of ACCOUNT_PROVIDERS) {
    try {
      scopes.push([provider, accountPool(provider).accounts.map((account) => account.id)]);
    } catch {
      /* an unreadable pool leaves that provider's older records out */
    }
  }
  return scopes;
}

// Every id a session's spend was recorded under: its own, and the per-account
// provider session each subscription account sent it under before account
// sends recorded the visible session.
function sessionUsageIdsFor(scopes, sessionId) {
  const ids = [sessionId];
  for (const [provider, accounts] of scopes) {
    for (const account of accounts) ids.push(accountScopedSessionId(provider, account, sessionId));
  }
  return ids;
}

// Other sessions a caller asks about beside its own (the composer island's
// agent sessions): bounded, distinct, never the caller's own id.
const MAX_SESSION_USAGE_IDS = 64;
function otherSessionIds(options, sessionId) {
  const ids = Array.isArray(options?.sessionIds) ? options.sessionIds : [];
  const unique = new Set();
  for (const id of ids) {
    if (typeof id === 'string' && id && id !== sessionId) unique.add(id);
    if (unique.size >= MAX_SESSION_USAGE_IDS) break;
  }
  return [...unique];
}

/** `null` = all time. `0` = today. Anything else is a trailing day count. */
function normalizeDays(value) {
  if (value === null || value === undefined || value === 'all') return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.min(Math.floor(days), 3650);
}

function normalizeModelLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), MAX_MODEL_LIMIT);
}

// Keep the existing days API for non-desktop callers: no view, no period.
function usagePeriodFor(options, now) {
  if (options?.view == null) return null;
  return resolveUsageStatsPeriod({
    view: options.view,
    anchor: options.anchor,
    startDay: options.startDay,
    endDay: options.endDay,
    startTime: options.startTime,
    endTime: options.endTime,
    now,
  });
}

// Rollup window for one period. A range cut below whole days has to be
// rebuilt from retained timestamps; cached day totals would spill past the
// selected clock.
function usageRollupQuery(period) {
  const timed = period?.view === 'hour' || Boolean(period?.startTime || period?.endTime);
  return {
    hourlyDay: period?.view === 'hour' ? period.startDay : null,
    ...(timed ? { fromMs: period.fromMs, toMs: period.toMs } : {}),
    ...(period
      ? {
          fromDay: period.startDay || undefined,
          toDay: usageRollupDayKey(period.toMs),
        }
      : {}),
  };
}

async function readSessionMetadata(sessionId) {
  const { readStoredSessionTranscript } = await import(
    '../runtime/agent/orchestrator/session/store-summary-reader.mjs'
  );
  return readStoredSessionTranscript(sessionId, { metadataOnly: true });
}

/**
 * What the request log names a session by: its title, and for an agent's
 * session the title of the session it ran for with its role (`agent: true`
 * with no role when only the ledger's owner link survives). A background
 * request on such an openable session adds its source type as
 * `backgroundKind`. A request whose own session the user cannot open (an
 * internal dispatch, or a session file that is gone) carries its source type
 * as `internalKind` instead, and no title: the first prompt line of a
 * background run says nothing about it.
 */
async function describeRequestSessions(requests, sessionMetadata) {
  // `exec` is hidden by the catalog but counts as conversation in usage
  // totals; every other hidden source is one the rollup calls background.
  const internalKindOf = (sourceType) => {
    const id = String(sourceType || '')
      .trim()
      .toLowerCase();
    const hidden = id && !isLeadVisibleRow({ sourceType: id, preview: id });
    return hidden && (id === 'exec' || !isConversationUsageSource(id)) ? id : '';
  };
  const metadata = new Map();
  const read = async (id) => {
    if (!id) return null;
    if (!metadata.has(id))
      metadata.set(
        id,
        Promise.resolve(sessionMetadata(id)).catch(() => null)
      );
    return metadata.get(id);
  };
  const labels = new Map();
  for (const request of requests) {
    const key = `${request.sessionId}\u0000${request.ownerSessionId}\u0000${request.sourceType}`;
    if (labels.has(key)) continue;
    const own = await read(request.sessionId);
    const kind = internalKindOf(request.sourceType || own?.sourceType);
    // A session the user can open keeps its label whatever the request's
    // route (a cache warm-up records under the real session id); only the
    // work's kind is added. A session file that is gone cannot be opened.
    const openable =
      Boolean(own) &&
      ((own.agent && (own.ownerSessionId || request.ownerSessionId)) || isLeadVisibleRow({ ...own, preview: 'x' }));
    if (kind && !openable) {
      labels.set(key, { title: '', role: '', agent: false, internalKind: kind });
      continue;
    }
    const ownerId = own?.ownerSessionId || request.ownerSessionId;
    let label = { title: own?.title || agentIdOfHomeSession(request.sessionId) || '', role: '', agent: false };
    if (ownerId && ownerId !== request.sessionId && (own?.agent || !own)) {
      const owner = await read(ownerId);
      label = { title: owner?.title || agentIdOfHomeSession(ownerId) || '', role: own?.agent || '', agent: true };
    }
    labels.set(key, { ...label, backgroundKind: kind });
  }
  return requests.map(({ ownerSessionId, sourceType, ...request }) => {
    const label = labels.get(`${request.sessionId}\u0000${ownerSessionId}\u0000${sourceType}`);
    return {
      ...request,
      sessionTitle: label.title,
      agentRole: label.role,
      agent: label.agent,
      internalKind: label.internalKind || '',
      backgroundKind: label.backgroundKind || '',
    };
  });
}

export function createUsageStatsApi({
  ledger = getUsageLedger,
  importHistory = importUsageHistory,
  accountPool = readProviderAccountPool,
  // provider -> { [accountId]: email } for the picker's secondary text.
  accountEmails = () => ({}),
  getSessionId = () => null,
  // sessionId -> stored metadata ({ title, agent, ownerSessionId }) or null.
  sessionMetadata = readSessionMetadata,
} = {}) {
  let importing = null;
  let imported = false;
  const snapshots = new Map();
  // Until the first instrumented send establishes the cutover, the legacy
  // writer may still be active. A previous import is not a live subscription.
  async function ensureHistoryImported(store, liveSince) {
    if (!liveSince || !imported || Number(store.get('importedThrough')) < liveSince) {
      importing ||= importHistory(store, resolvePluginData())
        .then(() => {
          imported = true;
        })
        .finally(() => {
          importing = null;
        });
      await importing;
    }
  }
  return {
    async getUsageStats(options = {}) {
      const store = ledger();
      if (!store) throw new Error('Usage ledger is unavailable');
      // Live sends commit through the ledger worker; statistics requested
      // after a send must include it.
      await store.settleWrites();
      const liveSince = Number(store.get('liveSince'));
      await ensureHistoryImported(store, liveSince);
      await refreshUnpricedUsageAsync(store);
      // Imports may take time: their newly retained timestamps must not fall
      // beyond a clock captured before the import started.
      const now = Date.now();
      const period = usagePeriodFor(options, now);
      // The rollup query runs off the event loop (usage-ledger-worker.mjs).
      const rollup = await store.rollupAsync(usageRollupQuery(period));
      // The ledger returns the same rollup object while nothing was committed
      // (and while a rolling window lost no record), so identical back-to-back
      // requests over it are one answer; the clock bound keeps the snapshot's
      // time-relative fields from ageing.
      const cacheKey = JSON.stringify([options, liveSince]);
      const held = snapshots.get(cacheKey);
      if (held && held.rollup === rollup && now - held.now >= 0 && now - held.now < SNAPSHOT_REUSE_MS) {
        return held.snapshot;
      }
      const snapshot = usageStatsSnapshot({
        rollup,
        days: normalizeDays(options?.days),
        period,
        modelLimit: normalizeModelLimit(options?.modelLimit),
        // Every turn counts. Splitting the conversation out from the background
        // runners answered "what did I personally type", but the question this
        // surface is actually asked is what the machine spent, and a caller
        // that wants only its own turns can still ask for that split.
        source: options?.source === 'conversation' ? 'conversation' : 'all',
        now,
      });
      snapshot.coverage.ledger = true;
      snapshot.coverage.liveSince = liveSince || null;
      snapshots.delete(cacheKey);
      snapshots.set(cacheKey, { rollup, now, snapshot });
      if (snapshots.size > SNAPSHOT_CACHE_LIMIT) snapshots.delete(snapshots.keys().next().value);
      return snapshot;
    },

    /**
     * The request log: one page of requests in a statistics period (`view`,
     * `anchor`, custom dates; the 24-hour view by default), newest first,
     * optionally of one `status` and one answering `model`. `cursor` is an
     * earlier page's `nextCursor`. `models` lists the models that answered in
     * the period.
     */
    async getUsageRequests(options = {}) {
      const store = ledger();
      if (!store) throw new Error('Usage ledger is unavailable');
      await store.settleWrites();
      // `asOf` is the first page's `generatedAt`: later pages resolve the same
      // period bounds, so a rolling window does not slide while it is browsed.
      const asOf = Number(options?.asOf);
      const real = Date.now();
      if (options?.asOf != null && !(asOf > 0 && asOf <= real)) throw new RangeError('asOf must be a past timestamp');
      const now = asOf > 0 ? asOf : real;
      const period = usagePeriodFor({ ...options, view: options?.view ?? 'hour' }, now);
      const page = await store.requestsAsync({
        fromMs: period.fromMs,
        toMs: period.toMs,
        status: quotaText(options?.status),
        model: quotaText(options?.model),
        cursor: quotaText(options?.cursor) || null,
        limit: options?.limit,
      });
      return {
        generatedAt: now,
        period,
        requests: await describeRequestSessions(page.requests, sessionMetadata),
        nextCursor: page.nextCursor,
        models: page.models,
      };
    },

    /**
     * This runtime's session from its first request, compactions included; null before it has one.
     * `sessionIds` adds the same totals for each named session (the agents it spawned) under
     * `sessions`, each read by its own id only. `agents: true` adds `agents`: one total of every
     * session ever run for this one (closed and replaced agents included) and the named sessions.
     */
    async getSessionUsage(options = {}) {
      const sessionId = getSessionId();
      if (!sessionId) return null;
      const store = ledger();
      if (!store) throw new Error('Usage ledger is unavailable');
      await store.settleWrites();
      const scopes = accountScopes(accountPool);
      const usage = await store.sessionUsageAsync(sessionUsageIdsFor(scopes, sessionId));
      const result = { sessionId, ...sessionUsageSnapshot(usage) };
      const others = otherSessionIds(options, sessionId);
      if (options?.agents === true) {
        const named = others.flatMap((id) => sessionUsageIdsFor(scopes, id));
        result.agents = sessionUsageSnapshot(await store.sessionUsageAsync(named, [sessionId]));
      }
      if (!others.length) return result;
      const totals = await Promise.all(
        others.map(async (id) => [
          id,
          sessionUsageSnapshot(await store.sessionUsageAsync(sessionUsageIdsFor(scopes, id))),
        ])
      );
      return { ...result, sessions: Object.fromEntries(totals) };
    },

    /**
     * How a subscription's own quota meter moved: one limit window since its
     * last reset (`view: 'window'`, the default, paged by `anchor`), or any
     * statistics period. `page` asks for the window history instead: one
     * page of every window that opened, newest first. Readings are recorded
     * whenever provider usage is measured, so history starts when recording
     * did.
     */
    async getQuotaHistory(options = {}) {
      const store = ledger();
      if (!store) throw new Error('Usage ledger is unavailable');
      // Prices of unpriced records are refreshed by the statistics read the
      // same dialog makes; repeating it here only queues behind it.
      await store.settleWrites();
      const now = Date.now();
      const selection = {
        provider: quotaText(options?.provider),
        account: quotaText(options?.account),
        inUse: accountsInUse(accountPool),
        label: quotaText(options?.window),
      };
      if (options?.page != null) return store.quotaWindowsAsync({ ...selection, page: Number(options.page), now });
      const view = options?.view == null || options.view === 'window' ? 'window' : options.view;
      const period = view === 'window' ? null : usagePeriodFor({ ...options, view }, now);
      const history = await store.quotaHistoryAsync({
        ...selection,
        view,
        anchor: view === 'window' ? quotaText(options?.anchor) || null : null,
        fromMs: period?.fromMs ?? null,
        toMs: period?.toMs ?? null,
        now,
      });
      return labelQuotaHistory(period ? { ...history, period } : history, accountPool, accountEmails);
    },
  };
}
