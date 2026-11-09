/*
 * components/status-line/footer-render.mjs — the footer text of the async render (L1 + L2), as a pure function
 * of the session state and the data files the core keeps.
 *
 * Node's `src/ui/statusline.mjs` `renderStatusline` produced this line from the same inputs, read from the
 * Node core's modules; here they arrive as plain data (see footer-inputs.mjs for where each comes from):
 *   quota windows .... `gateway-oauth-usage-cache.json` (`usageCache`), keyed by provider, model and the
 *                      selected account of `provider-accounts.json` (`accountId`)
 *   balance .......... the cache entry's `balance`, else the config's `gateway`/provider `balance`
 *   SESS spend ....... usage events of the route since this footer first showed it (`usageEvents`)
 *   configured windows the config's `gateway`/provider `quotaWindows`, spent by `usageEvents`
 *   Memory ........... `memory-cycle-state.json` (`memoryCycle`)
 * The colours are the canonical footer palette; the TUI re-tones them (statusline-ansi-bridge).
 */
import { rgb, rgbSgr } from '../../lib/ansi.mjs';
import { measuredContextUsage, contextMeasurementLabel } from '../../../../packages/protocol-client/src/rows/context-measurement.mjs';
import { displayModelName, effortDisplayLabel, shortenModelName } from '../../../../packages/protocol-client/src/rows/model-display.mjs';
import { formatElapsed, num, timeMs } from '../../lib/statusline-format.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const STALE_CACHE_TTL_MS = 7 * DAY_MS;
const MAX_USAGE_EVENTS = 5000;
const USAGE_EVENT_TTL_MS = 35 * DAY_MS;
const MEMORY_CYCLE_FRESH_MS = 10 * 60_000;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_MS = 120;
const MAINTENANCE_AGENT_LABELS = new Map([['cycle1-agent', 'cycle1']]);
const LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX = 8;

function palette() {
  return {
    R: '\x1b[0m',
    B: '\x1b[1m',
    D: rgbSgr(136, 136, 136),
    GRN: rgbSgr(0, 170, 75),
    YLW: rgbSgr(255, 193, 7),
    RED: rgbSgr(220, 70, 88),
  };
}

const cleanString = (value) => (typeof value === 'string' ? value.trim() : '');
const nullableNum = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const round = (value, digits = 6) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '$0';
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  if (Math.abs(n) >= 10) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

const providerKind = (provider) => {
  const p = String(provider || '').toLowerCase();
  if (!p) return 'unknown';
  if (p.includes('oauth')) return 'oauth';
  if (p === 'mixdog-local') return 'local';
  return 'api';
};

/* ── L1: model and context segments ─────────────────────────────────────────────────────────────────── */

function formatModelSegment({ provider, model, effort, fast, ultra, cols }, { B, R, D }) {
  const modelName = shortenModelName(displayModelName(String(model || '').trim(), provider, ''), cols);
  const bits = [`${B}${modelName}${R}`];
  if (effort) bits.push(`${B}${effortDisplayLabel(effort)}${R}`);
  if (fast === true) bits.push(`${B}${ultra === true ? 'Ultrafast' : 'Fast'}${R}`);
  return bits.join(` ${D}·${R} `);
}

function contextPctDisplayLabel(ctxPct) {
  if (ctxPct == null) return '—';
  const pct = Number(ctxPct);
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  return String(Math.round(Math.min(100, pct) * 10) / 10);
}

function formatContextSegment(ctxPct, cols, source, { R, D, GRN, YLW, RED }) {
  if (ctxPct == null) return rgb(136, 136, 136)(contextMeasurementLabel(source));
  const raw = Number(ctxPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const barPct = Math.max(0, Math.min(100, pct));
  let fill = GRN;
  if (pct >= 90) fill = RED;
  else if (pct >= 70) fill = YLW;
  const label = contextPctDisplayLabel(pct);
  const cells = cols >= 80 ? 14 : 0;
  if (!cells) return `${fill}${label}%${R}`;
  let filled = Math.floor((barPct * cells) / 100);
  if (filled < 0) filled = 0;
  if (filled > cells) filled = cells;
  if (barPct >= 1 && filled === 0) filled = 1;
  return `${fill}${'▓'.repeat(filled)}${R}${D}${'░'.repeat(cells - filled)}${R} ${label}%`;
}

/* ── quota data: the usage cache, the config, the usage events ──────────────────────────────────────── */

function freshSnapshot(snapshot, ttlMs, now) {
  const contentful =
    isRecord(snapshot) &&
    ((Array.isArray(snapshot.quotaWindows) && snapshot.quotaWindows.length > 0) || isRecord(snapshot.balance));
  if (!contentful) return null;
  const at = num(snapshot.cachedAt);
  if (!at || now - at > ttlMs) return null;
  const windows = Array.isArray(snapshot.quotaWindows) ? snapshot.quotaWindows : [];
  if (windows.length && !windows.some((w) => !w?.resetAt || num(w.resetAt) > now)) return null;
  return snapshot;
}

function newestProviderSnapshot(routes, providerOnly, ttlMs, now) {
  if (!providerOnly) return null;
  const prefix = `${providerOnly}\u0001`;
  let best = null;
  let bestAt = 0;
  for (const [key, snapshot] of Object.entries(routes)) {
    if (key !== providerOnly && !key.startsWith(prefix)) continue;
    const fresh = freshSnapshot(snapshot, ttlMs, now);
    const at = num(fresh?.cachedAt);
    if (fresh && at >= bestAt) {
      best = fresh;
      bestAt = at;
    }
  }
  return best;
}

/** `readCachedOAuthUsageSnapshot(route, { allowStale: true })` over the cache file's routes. */
function readCachedUsageSnapshot({ provider, model, accountId }, usageCache, now) {
  const routes = isRecord(usageCache?.routes) ? usageCache.routes : {};
  const providerLower = String(provider || '').toLowerCase();
  const providerOnlyKey = !accountId || accountId === 'default' ? providerLower : `${providerLower}\u0002${accountId}`;
  const key = `${providerOnlyKey}\u0001${String(model || '')}`;
  return (
    freshSnapshot(routes[key], STALE_CACHE_TTL_MS, now) ||
    freshSnapshot(routes[providerOnlyKey], STALE_CACHE_TTL_MS, now) ||
    newestProviderSnapshot(routes, providerOnlyKey, STALE_CACHE_TTL_MS, now) ||
    null
  );
}

/** The quota windows the status of the gateway read from the cache, with the snapshot's age. */
function cachedQuotaWindowsFallback(provider, model, usageCache, processStartedAt) {
  const none = { quotaWindows: [], cachedAt: 0 };
  if (!provider || !model) return none;
  const routes = isRecord(usageCache?.routes) ? usageCache.routes : null;
  if (!routes) return none;
  const providerOnlyKey = String(provider).toLowerCase();
  const entry =
    routes[`${providerOnlyKey}${String(model)}`] ||
    routes[providerOnlyKey] ||
    Object.entries(routes)
      .filter(([key, value]) => key.startsWith(providerOnlyKey) && Array.isArray(value?.quotaWindows))
      .sort((a, b) => (Number(b[1]?.cachedAt) || 0) - (Number(a[1]?.cachedAt) || 0))[0]?.[1];
  if (!Array.isArray(entry?.quotaWindows)) return none;
  const cachedAt = Number(entry.cachedAt);
  if (!Number.isFinite(cachedAt) || cachedAt < processStartedAt) return none;
  return { quotaWindows: entry.quotaWindows, cachedAt };
}

function labelForWindow(key, entry = {}) {
  const explicit = cleanString(entry.label);
  if (explicit) return explicit.toUpperCase();
  const s = String(key || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (['five_hour', 'five_hours', '5h', '5_hour'].includes(s)) return '5H';
  if (['seven_day', 'seven_days', 'weekly', 'week', '7d', '7_day'].includes(s)) return '7D';
  if (['monthly', 'month', '30d', '30_day'].includes(s)) return 'M';
  if (['daily', 'day', '24h', '24_hour'].includes(s)) return '24H';
  return String(key || 'USE').toUpperCase();
}

function durationMsForWindow(key, entry = {}) {
  const direct = num(entry.durationMs ?? entry.windowMs);
  if (direct > 0) return direct;
  const hours = num(entry.hours ?? entry.durationHours ?? entry.windowHours);
  if (hours > 0) return hours * HOUR_MS;
  const days = num(entry.days ?? entry.durationDays ?? entry.windowDays);
  if (days > 0) return days * DAY_MS;
  const label = labelForWindow(key, entry);
  if (label === '5H') return 5 * HOUR_MS;
  if (label === '7D') return 7 * DAY_MS;
  if (label === '24H') return DAY_MS;
  if (label === 'M') return 30 * DAY_MS;
  return 0;
}

function resetAtForWindow(key, entry, now) {
  const n = num(entry.resetAt ?? entry.resetsAt ?? entry.reset_at ?? entry.resets_at);
  if (n > 0) return n < 10_000_000_000 ? n * 1000 : n;
  const duration = durationMsForWindow(key, entry);
  if (!(duration > 0)) return null;
  return Math.floor(now / duration) * duration + duration;
}

function windowFromRaw(key, value, now) {
  const entry = isRecord(value) ? value : { used_percentage: value };
  const pick = (...values) => {
    for (const v of values) {
      if (v === null || v === undefined || v === '') continue;
      const n = Number(v);
      return n;
    }
    return NaN;
  };
  const usedPct = pick(entry.usedPct, entry.used_percentage, entry.percent, entry.used_percent, entry.percentage);
  const limitUsd = pick(entry.limitUsd, entry.limit_usd, entry.budgetUsd, entry.budget_usd, entry.limit_usd_cents / 100);
  const usedUsd = pick(
    entry.usedUsd, entry.used_usd, entry.spendUsd, entry.spend_usd, entry.costUsd, entry.cost_usd, entry.used_usd_cents / 100
  );
  const remainingUsd = pick(
    entry.remainingUsd, entry.remaining_usd, entry.leftUsd, entry.left_usd, entry.balanceUsd, entry.balance_usd,
    entry.remaining_usd_cents / 100
  );
  const out = { label: labelForWindow(key, entry), source: cleanString(entry.source) || 'provider' };
  if (Number.isFinite(usedPct)) out.usedPct = round(usedPct, 2);
  if (Number.isFinite(limitUsd)) out.limitUsd = round(limitUsd, 4);
  if (Number.isFinite(usedUsd)) out.usedUsd = round(usedUsd, 4);
  if (Number.isFinite(remainingUsd)) out.remainingUsd = round(remainingUsd, 4);
  const resetAt = resetAtForWindow(key, entry, now);
  if (resetAt) out.resetAt = resetAt;
  return Object.keys(out).length > 2 ? out : null;
}

function windowsFromObject(obj, now) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    return obj.map((entry, idx) => windowFromRaw(entry?.id || entry?.name || entry?.label || idx, entry, now)).filter(Boolean);
  }
  return Object.entries(obj).map(([key, value]) => windowFromRaw(key, value, now)).filter(Boolean);
}

function usageEventsOf(data, now) {
  const rows = Array.isArray(data.usageEvents) ? data.usageEvents.slice(-MAX_USAGE_EVENTS) : [];
  const cutoff = now - USAGE_EVENT_TTL_MS;
  return rows.filter((e) => num(e?.ts) >= cutoff);
}

/** `buildGatewayLimits(route, null, snapshot)`: the windows, the balance and the session spend of a route. */
function buildGatewayLimits(route, snapshot, data, env, state) {
  const gateway = isRecord(data.config?.gateway) ? data.config.gateway : {};
  const agent = isRecord(data.config?.agent) ? data.config.agent : {};
  const agentSection = agent.agent?.providers ? agent.agent : agent;
  const providerCfg = route.provider && isRecord(agentSection.providers?.[route.provider]) ? agentSection.providers[route.provider] : {};
  const events = usageEventsOf(data, env.now);
  const forRoute = events.filter(
    (e) => (!route.provider || e.provider === route.provider) && (!route.model || e.model === route.model)
  );

  const snapshotWindows = Array.isArray(snapshot?.quotaWindows) ? snapshot.quotaWindows : [];
  const configured = [
    ...windowsFromObject(gateway.quotaWindows || gateway.usageWindows, env.now),
    ...windowsFromObject(providerCfg.quotaWindows || providerCfg.usageWindows, env.now),
  ];
  const localWindows = configured.length
    ? configured.map((w) => {
        const duration = durationMsForWindow(w.label, w);
        const since = duration > 0 ? env.now - duration : 0;
        const usedUsd = forRoute.filter((e) => num(e.ts) >= since).reduce((sum, e) => sum + num(e.costUsd), 0);
        const next = { ...w };
        if (num(w.limitUsd) > 0) {
          next.usedUsd = round(usedUsd, 4);
          next.remainingUsd = round(Math.max(0, num(w.limitUsd) - usedUsd), 4);
          next.usedPct = round(Math.min(100, (usedUsd * 100) / num(w.limitUsd, 1)), 2);
          next.source = w.source || 'local-budget';
          if (!next.resetAt) next.resetAt = resetAtForWindow(w.label, w, env.now);
        }
        return next;
      })
    : [];

  let balance = snapshot?.balance || null;
  if (!balance) {
    const raw = gateway.balance || gateway.budget || providerCfg.balance || providerCfg.budget || null;
    const budgetUsd = isRecord(raw) ? num(raw.budgetUsd ?? raw.limitUsd ?? raw.monthlyUsd ?? raw.amountUsd, NaN) : NaN;
    if (Number.isFinite(budgetUsd)) {
      const period = cleanString(raw.period) || '30d';
      const duration = durationMsForWindow(period, raw) || 30 * DAY_MS;
      const since = env.now - duration;
      const spentUsd = events
        .filter((e) => !route.provider || e.provider === route.provider)
        .filter((e) => num(e.ts) >= since)
        .reduce((sum, e) => sum + num(e.costUsd), 0);
      balance = {
        source: 'local-budget',
        period,
        budgetUsd: round(budgetUsd, 4),
        spentUsd: round(spentUsd, 4),
        remainingUsd: round(Math.max(0, budgetUsd - spentUsd), 4),
      };
    }
  }

  let routeSpend = null;
  const trackSpend = (route.providerKind || providerKind(route.provider)) === 'api';
  if (trackSpend) {
    const identity = [route.provider || '', route.model || '', route.effort || '', route.fast === true ? 'fast' : ''].join('\u0001');
    if (identity.trim()) {
      if (state.routeSectionKey !== identity) {
        state.routeSectionKey = identity;
        state.routeSectionStartedAt = env.now;
      }
      const startedAt = state.routeSectionStartedAt;
      const costUsd = forRoute
        .filter((e) => (e.routeKey ? e.routeKey === identity : true) && num(e.ts) >= startedAt)
        .reduce((sum, e) => sum + num(e.costUsd), 0);
      if (costUsd > 0) routeSpend = { label: 'SESS', source: 'local-route', period: 'session', startedAt, costUsd: round(costUsd, 6) };
    }
  }
  return { quotaWindows: snapshotWindows.length ? snapshotWindows : localWindows, balance, routeSpend };
}

/* ── the quota segments of L1 ───────────────────────────────────────────────────────────────────────── */

function isLocalEstimateWindow(window) {
  const source = cleanString(window?.source || '').toLowerCase();
  return !source || source.includes('local') || source.includes('config');
}

function formatGatewayLimitSegments(status, { COLS, D, R, GRN, YLW, RED, colourPct, epochMsToHHMM, now }) {
  const segments = [];
  const kind = cleanString(status.providerKind || '').toLowerCase();
  const providerId = cleanString(status.provider || '').toLowerCase();
  const statusSource = cleanString(status.source || '').toLowerCase();
  const balanceSource = cleanString(status.balance?.source || '').toLowerCase();
  const isOpenAiOAuth =
    (kind === 'oauth' || providerId.includes('oauth')) &&
    (providerId === 'openai-oauth' ||
      statusSource.includes('openai') ||
      statusSource.includes('codex') ||
      balanceSource.includes('openai') ||
      balanceSource.includes('codex'));
  const isPlainApi = kind === 'api';
  const windows = !isPlainApi && Array.isArray(status.quotaWindows) ? status.quotaWindows : [];
  const maxWindows = COLS >= 120 ? 3 : COLS >= 80 ? 2 : 1;
  const routeSpend = nullableNum(status.routeSpend?.costUsd);
  const routeSpendLabel = cleanString(status.routeSpend?.label) || (COLS >= 120 ? 'SESS' : 'S');
  const alignColumns = COLS >= 80;
  const PCT_COLUMN_WIDTH = 4;
  const RESET_COLUMN_WIDTH = 5;
  const visibleLength = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').length;
  const padLeftVisible = (text, width) => {
    const value = String(text ?? '');
    const pad = Math.max(0, Number(width) - visibleLength(value));
    return pad > 0 ? `${' '.repeat(pad)}${value}` : value;
  };
  const windowResetText = (window) => {
    if (isLocalEstimateWindow(window)) return '';
    const at = nullableNum(window?.resetAt);
    if (!at || at <= now) return '';
    if (at - now < DAY_MS) return epochMsToHHMM(at);
    const d = new Date(at);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const shownWindows = windows.slice(0, maxWindows);
  const resetColumnWidth = alignColumns ? RESET_COLUMN_WIDTH : 0;
  const withReset = (segment, window) => {
    const reset = windowResetText(window);
    return reset ? `${segment} ${D}↻ ${padLeftVisible(reset, resetColumnWidth)}${R}` : segment;
  };
  const addRouteSpend = () => {
    if (routeSpend !== null && routeSpend > 0) {
      segments.push(`${D}${routeSpendLabel.toUpperCase()}${R} ${money(routeSpend)}`);
      return true;
    }
    return false;
  };
  const addApiBalance = () => {
    if (isOpenAiOAuth) return false;
    const remaining = nullableNum(status.balance?.remainingUsd);
    if (remaining !== null) segments.push(`${D}Credit${R} ${money(remaining)}`);
    return remaining !== null;
  };
  if (isPlainApi) {
    addRouteSpend();
    if (addApiBalance()) return segments;
    if (segments.length) return segments;
  }
  for (const w of shownWindows) {
    const label = String(w?.label || 'USE').toUpperCase();
    const pct = nullableNum(w?.usedPct);
    const remaining = isOpenAiOAuth ? null : nullableNum(w?.remainingUsd);
    const limit = isOpenAiOAuth ? null : nullableNum(w?.limitUsd);
    const used = isOpenAiOAuth ? null : nullableNum(w?.usedUsd);
    const remainingCredits = isOpenAiOAuth ? null : nullableNum(w?.remainingCredits);
    const limitCredits = isOpenAiOAuth ? null : nullableNum(w?.limitCredits);
    const usedCredits = isOpenAiOAuth ? null : nullableNum(w?.usedCredits);
    const estimated = isLocalEstimateWindow(w);
    if (remaining !== null) {
      const color = estimated ? YLW : remaining <= 1 ? RED : remaining <= 5 ? YLW : GRN;
      segments.push(withReset(`${D}${label}${R} ${color}${estimated ? 'est ' : ''}${money(remaining)}${R}`, w));
    } else if (used !== null && limit !== null) {
      segments.push(withReset(`${D}${label}${R} ${estimated ? 'est ' : ''}${money(used)}/${money(limit)}`, w));
    } else if (remainingCredits !== null && limitCredits !== null) {
      const color = estimated ? YLW : pct !== null && pct >= 95 ? RED : pct !== null && pct >= 80 ? YLW : GRN;
      segments.push(
        withReset(
          `${D}${label}${R} ${color}${estimated ? 'est ' : ''}${compactNumber(remainingCredits)}/${compactNumber(limitCredits)}${R}`,
          w
        )
      );
    } else if (remainingCredits !== null) {
      const color = estimated ? YLW : pct !== null && pct >= 95 ? RED : pct !== null && pct >= 80 ? YLW : GRN;
      segments.push(withReset(`${D}${label}${R} ${color}${estimated ? 'est ' : ''}${compactNumber(remainingCredits)}${R}`, w));
    } else if (usedCredits !== null && limitCredits !== null) {
      segments.push(
        withReset(`${D}${label}${R} ${estimated ? 'est ' : ''}${compactNumber(usedCredits)}/${compactNumber(limitCredits)}`, w)
      );
    } else if (pct !== null) {
      const pctText = colourPct(Math.round(pct));
      segments.push(
        withReset(
          `${D}${label}${R} ${estimated ? 'est ' : ''}${alignColumns ? padLeftVisible(pctText, PCT_COLUMN_WIDTH) : pctText}`,
          w
        )
      );
    }
  }
  addRouteSpend();
  if (!isPlainApi && COLS >= 80) addApiBalance();
  if (segments.length) return segments;

  const remaining = isOpenAiOAuth ? null : nullableNum(status.balance?.remainingUsd);
  if (remaining !== null) {
    segments.push(`${D}Credit${R} ${money(remaining)}`);
    addRouteSpend();
    return segments;
  }
  if (addRouteSpend()) return segments;
  const lastCost = nullableNum(status.lastUsage?.costUsd);
  if (lastCost && lastCost > 0 && !String(status.provider || '').includes('oauth')) {
    segments.push(`${D}$${R} ${money(lastCost)}`);
  }
  return segments;
}

/** Keeps a displayed quota reading unless a newer or own one replaces it. */
function acceptQuotaSnapshot(held, incoming) {
  if (!held) return true;
  if (incoming?.owned) return true;
  const incomingAsOf = num(incoming?.asOf);
  const heldAsOf = num(held.asOf);
  if (!incomingAsOf || !heldAsOf) return true;
  if (held.owned) return incomingAsOf > heldAsOf;
  return incomingAsOf >= heldAsOf;
}

function quotaSegmentsFor(args, data, env, state, colors) {
  const { provider, model, effort, fast, sessionId, clientHostPid } = args;
  const providerLower = String(provider || '').trim().toLowerCase();
  const accountId = data.accountId || 'default';
  const route = { provider: providerLower, model: String(model || '').trim(), accountId, providerKind: providerKind(providerLower) };

  // The status the gateway reports for this route: its windows are the cache entry the process has seen refreshed.
  const gatewayEnabled = data.config?.modules?.gateway?.enabled !== false;
  const fallbackWindows = cachedQuotaWindowsFallback(providerLower, route.model, data.usageCache, env.processStartedAt);
  const primary =
    gatewayEnabled && providerLower && route.model
      ? {
          provider: providerLower,
          model: route.model,
          providerKind: providerKind(providerLower),
          quotaWindows: fallbackWindows.quotaWindows,
          quotaWindowsAsOf: num(fallbackWindows.cachedAt),
          quotaWindowsOwned: false,
          balance: null,
          routeSpend: null,
        }
      : null;

  // An OAuth route shows nothing until this process has seen its first confirmed reading, then stays armed.
  let usageReady = true;
  if (providerLower.includes('oauth')) {
    if (!state.armedProviders.has(providerLower)) {
      const seen = readCachedUsageSnapshot(route, data.usageCache, env.now);
      const cachedAt = num(seen?.cachedAt);
      if (cachedAt > 0 && cachedAt >= env.processStartedAt) state.armedProviders.add(providerLower);
    }
    usageReady = state.armedProviders.has(providerLower);
  }

  let fallback = null;
  if (usageReady && providerLower) {
    let snapshot = providerLower.includes('oauth') ? readCachedUsageSnapshot(route, data.usageCache, env.now) : null;
    if (snapshot) {
      const cachedAt = num(snapshot.cachedAt);
      if (!cachedAt || cachedAt < env.processStartedAt) snapshot = { ...snapshot, quotaWindows: [] };
    }
    const limits = buildGatewayLimits(route, snapshot, data, env, state);
    if (limits.quotaWindows.length || limits.balance || limits.routeSpend) {
      fallback = {
        provider: providerLower,
        model: route.model,
        providerKind: route.providerKind,
        quotaWindows: limits.quotaWindows,
        quotaWindowsAsOf: num(snapshot?.cachedAt),
        quotaWindowsOwned: false,
        balance: limits.balance || null,
        routeSpend: limits.routeSpend || null,
      };
    }
  }
  const matches = primary && (!providerLower || primary.provider === providerLower) ? primary : null;

  let quotaStatus = null;
  if (usageReady) {
    if (!matches) quotaStatus = fallback;
    else if (!fallback) quotaStatus = matches;
    else {
      const usePrimaryWindows = matches.quotaWindows.length > 0;
      quotaStatus = {
        ...fallback,
        ...matches,
        quotaWindows: usePrimaryWindows ? matches.quotaWindows : fallback.quotaWindows || [],
        quotaWindowsAsOf: usePrimaryWindows ? num(matches.quotaWindowsAsOf) : num(fallback.quotaWindowsAsOf),
        quotaWindowsOwned: usePrimaryWindows ? matches.quotaWindowsOwned === true : fallback.quotaWindowsOwned === true,
        balance: matches.balance || fallback.balance || null,
        routeSpend: matches.routeSpend || fallback.routeSpend || null,
        providerKind: matches.providerKind || fallback.providerKind,
      };
    }
  }
  const segments = quotaStatus
    ? formatGatewayLimitSegments(quotaStatus, {
        COLS: env.cols,
        ...colors,
        colourPct: (p) => {
          if (p >= 90) return `${colors.RED}${p}%${colors.R}`;
          if (p >= 70) return `${colors.YLW}${p}%${colors.R}`;
          return `${colors.GRN}${p}%${colors.R}`;
        },
        epochMsToHHMM: (ms) => {
          const d = new Date(Number(ms));
          return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        },
        now: env.now,
      })
    : [];

  if (!usageReady || !state.armedProviders.has(providerLower)) return segments;
  const holdKey = [providerLower, route.model, String(effort || '').trim(), fast === true ? 'fast' : '', String(sessionId || ''), String(clientHostPid || '')].join('\0');
  const held = state.held.get(holdKey);
  if (!segments.length) return held?.segments?.length ? held.segments : segments;
  const incoming = { asOf: num(quotaStatus?.quotaWindowsAsOf), owned: quotaStatus?.quotaWindowsOwned === true };
  if (acceptQuotaSnapshot(held, incoming)) {
    state.held.delete(holdKey);
    state.held.set(holdKey, { segments, asOf: incoming.asOf, owned: incoming.owned });
    if (state.held.size > LAST_NON_EMPTY_QUOTA_SEGMENTS_CACHE_MAX) state.held.delete(state.held.keys().next().value);
    return segments;
  }
  return held?.segments?.length ? held.segments : segments;
}

/* ── L2: agents, shells, web search, memory ─────────────────────────────────────────────────────────── */

const TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;
const ACTIVE_AGENT_STATUS = /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting)$/i;
const QUEUED_AGENT_STATUS = /^(?:queued|pending|starting)$/i;

const agentStatusValues = (value = {}) =>
  [value.stage, value.status]
    .map((status) => String(status || '').trim())
    .filter((status, index, values) => Boolean(status) && values.indexOf(status) === index);

function lifecycleStatuses(value = {}) {
  const statuses = agentStatusValues(value);
  if (statuses.some((status) => /cancel|killed/i.test(status))) return statuses;
  const status = String(value.status || '').trim();
  return status ? [status] : statuses;
}

const isTerminalAgentEntry = (statuses) => statuses.some((status) => TERMINAL_AGENT_STATUS.test(String(status || '')));
const isActiveAgentEntry = (statuses) =>
  statuses.length > 0 && !isTerminalAgentEntry(statuses) && statuses.some((status) => ACTIVE_AGENT_STATUS.test(status));
const isQueuedAgentEntry = (statuses) => isActiveAgentEntry(statuses) && statuses.every((status) => QUEUED_AGENT_STATUS.test(status));

function normalizeAgentWorker(worker = {}) {
  const tag = String(worker.tag || worker.agent || worker.name || '').trim();
  if (!tag) return null;
  return {
    tag,
    status: isActiveAgentEntry(lifecycleStatuses(worker)) ? 'running' : 'idle',
    startedAtMs: timeMs(worker.startedAt || worker.startTime || worker.createdAt),
    agent: worker.agent || null,
  };
}

function normalizeAgentJob(job = {}) {
  const statuses = agentStatusValues(job);
  if (!statuses.length) return null;
  const taskId = String(job.task_id || job.taskId || '').trim();
  const tag = String(job.tag || job.agent || job.type || taskId || '').trim();
  if (!tag && !taskId) return null;
  const startedAtMs = timeMs(job.startedAt);
  if (isTerminalAgentEntry(statuses) && timeMs(job.finishedAt) > 0) return { tag, status: 'finished' };
  const lifecycle = lifecycleStatuses(job);
  if (!isActiveAgentEntry(lifecycle)) return null;
  return { tag, status: isQueuedAgentEntry(lifecycle) ? 'queued' : 'running', startedAtMs, agent: job.agent || null };
}

function runningAgentWorkers(agentWorkers, agentJobs) {
  const byTag = new Map();
  const workerByTag = new Map();
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const row = normalizeAgentWorker(worker);
    if (!row) continue;
    workerByTag.set(row.tag, row);
    byTag.set(row.tag, row);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    const row = normalizeAgentJob(job);
    if (!row || row.status === 'finished') continue;
    const worker = workerByTag.get(row.tag);
    if (worker && (worker.status === 'running' || row.status !== 'queued')) continue;
    byTag.set(row.tag, row);
  }
  const running = [];
  const seen = new Set();
  for (const w of byTag.values()) {
    const tag = String(w?.tag || '').trim();
    if (!tag) continue;
    const agent = String(w?.agent || '').trim();
    const maintenance = MAINTENANCE_AGENT_LABELS.get(agent) || (!agent ? MAINTENANCE_AGENT_LABELS.get(tag) : '');
    if (maintenance) continue;
    if (w.status !== 'idle' && !seen.has(tag)) {
      seen.add(tag);
      running.push(w);
    }
  }
  return running;
}

function activitySegments(args, data, env, colors, shellStatus) {
  const { R, B, D, GRN, YLW } = colors;
  const parts = [];
  const spin = `${GRN}${SPINNER_FRAMES[Math.floor(env.now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]}${R}`;
  const elapsedSuffix = (label) => (label ? ` ${D}·${R} ${label}` : '');
  const segment = (label, elapsed) => parts.push(`${spin} ${B}${label}${R}${elapsedSuffix(elapsed)}`);
  const running = runningAgentWorkers(args.agentWorkers, args.agentJobs);
  if (running.length) {
    const oldest = running.reduce((min, w) => {
      const t = num(w?.startedAtMs);
      return t > 0 && t < min ? t : min;
    }, Infinity);
    segment(`Running ${running.length} Agent${running.length === 1 ? '' : 's'}`, Number.isFinite(oldest) ? formatElapsed(env.now - oldest) : '');
  }
  if (shellStatus.count > 0) segment(`Running ${shellStatus.count} Shell${shellStatus.count === 1 ? '' : 's'}`, shellStatus.elapsedLabel);
  if (shellStatus.unconfirmed > 0) {
    const n = shellStatus.unconfirmed;
    parts.push(`${YLW}⚠ ${n} Shell${n === 1 ? '' : 's'} termination unconfirmed${R} ${D}·${R} /shells`);
  }
  const web = isRecord(args.activeTools) ? args.activeTools.web_search : null;
  const webCount = web ? num(web.count) : 0;
  if (webCount > 0) {
    const started = web ? num(web.startedAt) : 0;
    segment('Web Searching', started > 0 ? formatElapsed(env.now - started) : '');
  }
  const cycle = data.memoryCycle;
  if (isRecord(cycle)) {
    const runningCycle = cycle.running || null;
    const fresh = Number(cycle.updatedAt) > env.now - MEMORY_CYCLE_FRESH_MS;
    const ownerAlive = !Number(runningCycle?.pid) || env.isPidAlive(Number(runningCycle.pid));
    if (fresh && ownerAlive && runningCycle?.cycle === 'cycle1' && Number(runningCycle.started_at) > 0) {
      segment('Memory', formatElapsed(env.now - Number(runningCycle.started_at)));
    }
  }
  return parts;
}

/* ── the footer ─────────────────────────────────────────────────────────────────────────────────────── */

/** A footer renderer: its state (the displayed quota readings, the route's spend section) lives as long as it does. */
export function createFooterRenderer() {
  const state = { routeSectionKey: null, routeSectionStartedAt: 0, armedProviders: new Set(), held: new Map() };
  /**
   * `args` are the statusline arguments of the TUI (route, stats, windows, agents, tools, `shellStatus`);
   * `data` the files' contents (see the header); `env` is `{ now, cols, processStartedAt, isPidAlive }`.
   */
  return function render(args, data, env) {
    const colors = palette();
    const { R, D } = colors;
    const stats = args.stats && typeof args.stats === 'object' ? args.stats : {};
    const ctxPct = measuredContextUsage({
      stats,
      contextWindow: args.contextWindow,
      displayContextWindow: args.displayContextWindow,
      rawContextWindow: args.rawContextWindow,
    }).percent;
    // Node asked the gateway for the route's window; the displayed one is the session's (display, else context).
    const sep = ` ${D}│${R} `;
    const l1Parts = [
      formatModelSegment({ ...args, cols: env.cols }, colors),
      formatContextSegment(ctxPct, env.cols, stats.currentContextSource, colors),
      ...quotaSegmentsFor(args, data, env, state, colors),
    ].filter(Boolean);
    const l2Parts = activitySegments(args, data, env, colors, args.shellStatus || { count: 0, unconfirmed: 0, elapsedLabel: '' });
    const l1 = l1Parts.join(sep) || 'mixdog';
    const l2 = l2Parts.join(sep);
    return l2 ? `${l1}\n${l2}` : l1;
  };
}
