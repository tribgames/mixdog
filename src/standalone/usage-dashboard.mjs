import { fetchOAuthUsageSnapshot, readCachedOAuthUsageSnapshot } from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function clean(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || '';
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
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

function normaliseWindows(value, source = 'config') {
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [entry?.label || entry?.name || `W${index + 1}`, entry])
    : value && typeof value === 'object'
      ? Object.entries(value)
      : [];
  return entries.map(([key, entry]) => {
    if (!entry || typeof entry !== 'object') return null;
    const limitUsd = num(entry.limitUsd ?? entry.limit_usd ?? entry.budgetUsd ?? entry.budget_usd ?? entry.limit_usd_cents / 100, null);
    const usedUsd = num(entry.usedUsd ?? entry.used_usd ?? entry.spendUsd ?? entry.spend_usd ?? entry.costUsd ?? entry.cost_usd ?? entry.used_usd_cents / 100, null);
    const remainingUsd = num(entry.remainingUsd ?? entry.remaining_usd ?? entry.leftUsd ?? entry.left_usd ?? entry.balanceUsd ?? entry.balance_usd ?? entry.remaining_usd_cents / 100, null);
    const usedPct = num(entry.usedPct ?? entry.used_pct ?? entry.percent ?? entry.pct, null);
    const remainingCredits = num(entry.remainingCredits ?? entry.remaining_credits ?? entry.creditsRemaining ?? entry.credits_remaining, null);
    const limitCredits = num(entry.limitCredits ?? entry.limit_credits, null);
    const usedCredits = num(entry.usedCredits ?? entry.used_credits, null);
    const resetAt = num(entry.resetAt ?? entry.reset_at ?? entry.resetsAt ?? entry.resets_at, null);
    const out = {
      label: clean(entry.label) || String(key || 'USE').toUpperCase(),
      source: clean(entry.source) || source,
    };
    if (remainingUsd !== null) out.remainingUsd = round(remainingUsd, 4);
    if (limitUsd !== null) out.limitUsd = round(limitUsd, 4);
    if (usedUsd !== null) out.usedUsd = round(usedUsd, 4);
    if (usedPct !== null) out.usedPct = round(usedPct, 2);
    if (remainingCredits !== null) out.remainingCredits = round(remainingCredits, 4);
    if (limitCredits !== null) out.limitCredits = round(limitCredits, 4);
    if (usedCredits !== null) out.usedCredits = round(usedCredits, 4);
    if (resetAt) out.resetAt = resetAt;
    if (out.usedPct === undefined && out.limitUsd > 0 && out.usedUsd !== undefined) {
      out.usedPct = round(Math.min(100, out.usedUsd * 100 / out.limitUsd), 2);
    }
    return out;
  }).filter(Boolean);
}

function localBudget(providerCfg = {}) {
  const limitUsd = num(
    providerCfg.limitUsd ?? providerCfg.limit_usd ?? providerCfg.budgetUsd ?? providerCfg.budget_usd
      ?? providerCfg.monthlyBudgetUsd ?? providerCfg.monthly_budget_usd,
    null,
  );
  const usedUsd = num(providerCfg.usedUsd ?? providerCfg.used_usd ?? providerCfg.spendUsd ?? providerCfg.spend_usd ?? providerCfg.costUsd ?? providerCfg.cost_usd, null);
  const remainingUsd = num(providerCfg.remainingUsd ?? providerCfg.remaining_usd ?? providerCfg.leftUsd ?? providerCfg.left_usd, null);
  if (remainingUsd !== null) {
    return { remainingUsd: round(remainingUsd, 4), usedUsd: usedUsd === null ? null : round(usedUsd, 4), limitUsd: limitUsd === null ? null : round(limitUsd, 4), source: 'local-budget' };
  }
  if (limitUsd !== null && usedUsd !== null) {
    return { remainingUsd: round(Math.max(0, limitUsd - usedUsd), 4), usedUsd: round(usedUsd, 4), limitUsd: round(limitUsd, 4), source: 'local-budget' };
  }
  const balance = providerCfg.balance && typeof providerCfg.balance === 'object' ? providerCfg.balance : null;
  const balanceRemaining = num(balance?.remainingUsd ?? balance?.remaining_usd ?? balance?.balanceUsd ?? balance?.balance_usd, null);
  if (balanceRemaining !== null) return { remainingUsd: round(balanceRemaining, 4), source: clean(balance?.source) || 'configured-balance' };
  return null;
}

function snapshotRemaining(snapshot) {
  const balanceRemaining = num(snapshot?.balance?.remainingUsd ?? snapshot?.balance?.remaining_usd, null);
  if (balanceRemaining !== null) return { remainingUsd: round(balanceRemaining, 4), source: clean(snapshot?.balance?.source) || clean(snapshot?.source) || 'provider-api' };
  const windows = normaliseWindows(snapshot?.quotaWindows, clean(snapshot?.source) || 'provider-api');
  const usd = windows.filter(w => num(w.remainingUsd, null) !== null);
  if (usd.length === 1) return { remainingUsd: usd[0].remainingUsd, source: usd[0].source || clean(snapshot?.source) || 'provider-api' };
  return null;
}

function displayWindow(w) {
  const label = String(w?.label || 'USE').toUpperCase();
  if (num(w?.remainingUsd, null) !== null) return `${label} ${money(w.remainingUsd)} left`;
  if (num(w?.usedUsd, null) !== null && num(w?.limitUsd, null) !== null) return `${label} ${money(w.usedUsd)}/${money(w.limitUsd)}`;
  if (num(w?.remainingCredits, null) !== null) return `${label} ${compactNumber(w.remainingCredits)}cr left`;
  if (num(w?.usedCredits, null) !== null && num(w?.limitCredits, null) !== null) return `${label} ${compactNumber(w.usedCredits)}/${compactNumber(w.limitCredits)}cr`;
  if (num(w?.usedPct, null) !== null) return `${label} ${Math.round(w.usedPct)}%`;
  return label;
}

function rowTone(row) {
  if (row.status === 'error') return 'error';
  if (row.status === 'missing') return 'missing';
  if (row.status === 'local') return 'local';
  const remaining = num(row.remainingUsd, null);
  if (remaining !== null) return remaining <= 1 ? 'danger' : remaining <= 5 ? 'warn' : 'ok';
  const pct = Math.max(...(row.windows || []).map(w => num(w.usedPct, -1)));
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  if (row.status === 'hidden' || row.status === 'partial' || row.status === 'estimated') return 'warn';
  return 'ok';
}

async function oauthSnapshot(providerId, { refresh, getProvider, log }) {
  if (refresh && typeof getProvider === 'function') {
    const providerObj = getProvider(providerId);
    if (providerObj) return await fetchOAuthUsageSnapshot({ provider: providerId, model: '' }, providerObj, log);
  }
  return readCachedOAuthUsageSnapshot({ provider: providerId, model: '' });
}

function baseRow(item, group, providerCfg = {}) {
  return {
    id: item.id,
    label: item.name || item.id,
    group,
    type: item.type || group,
    enabled: item.enabled === true,
    authenticated: item.authenticated === true,
    remainingUsd: null,
    usedUsd: null,
    limitUsd: null,
    windows: [],
    status: 'hidden',
    source: 'unavailable',
    sourceLabel: 'unavailable',
    primary: 'hidden',
    detail: 'provider does not expose account balance',
    updatedAt: null,
    includeInTotal: false,
    totalBucket: null,
    config: providerCfg,
  };
}

function applyKnownRemaining(row, known, { estimated = false } = {}) {
  if (!known || num(known.remainingUsd, null) === null) return row;
  row.remainingUsd = known.remainingUsd;
  if (known.usedUsd !== null && known.usedUsd !== undefined) row.usedUsd = known.usedUsd;
  if (known.limitUsd !== null && known.limitUsd !== undefined) row.limitUsd = known.limitUsd;
  row.status = estimated ? 'estimated' : 'ok';
  row.source = known.source || (estimated ? 'local-budget' : 'provider-api');
  row.sourceLabel = estimated ? 'local budget' : 'API';
  row.primary = `${money(row.remainingUsd)} left`;
  row.detail = row.limitUsd !== null && row.usedUsd !== null
    ? `${money(row.usedUsd)} / ${money(row.limitUsd)} used`
    : row.source;
  row.includeInTotal = true;
  row.totalBucket = estimated ? 'local' : 'api';
  return row;
}

export async function createUsageDashboard(config = {}, options = {}) {
  const setup = options.setup || { api: [], oauth: [], local: [] };
  const providers = config.providers || {};
  const rows = [];
  const checkedAt = Date.now();

  for (const item of setup.api || []) {
    const providerCfg = providers[item.id] || {};
    const row = baseRow(item, 'api', providerCfg);
    if (!row.authenticated) {
      row.status = 'missing';
      row.source = 'not-configured';
      row.sourceLabel = 'no key';
      row.primary = 'not configured';
      row.detail = item.envName ? `set ${item.envName}` : 'API key missing';
    } else {
      applyKnownRemaining(row, localBudget(providerCfg), { estimated: true });
      if (!row.includeInTotal) {
        const windows = normaliseWindows(providerCfg.quotaWindows || providerCfg.usageWindows || providerCfg.limits || providerCfg.budgets, 'config');
        row.windows = windows;
        if (windows.length) {
          row.status = 'partial';
          row.source = 'configured-windows';
          row.sourceLabel = 'config';
          row.primary = windows.map(displayWindow).slice(0, 2).join(' · ');
          row.detail = 'configured quota windows';
        } else {
          row.status = 'hidden';
          row.source = 'provider-hidden';
          row.sourceLabel = 'hidden';
          row.primary = 'balance hidden';
          row.detail = 'provider dashboard required';
        }
      }
    }
    row.tone = rowTone(row);
    rows.push(row);
  }

  for (const item of setup.oauth || []) {
    const providerCfg = providers[item.id] || {};
    const row = baseRow(item, 'oauth', providerCfg);
    if (!row.authenticated) {
      row.status = 'missing';
      row.source = 'not-configured';
      row.sourceLabel = 'not signed in';
      row.primary = 'not signed in';
      row.detail = item.detail || 'OAuth credentials missing';
    } else {
      try {
        const snapshot = await oauthSnapshot(item.id, options);
        const known = snapshotRemaining(snapshot);
        const windows = normaliseWindows(snapshot?.quotaWindows, clean(snapshot?.source) || 'provider-api');
        row.windows = windows;
        row.updatedAt = num(snapshot?.cachedAt, null);
        if (known) {
          applyKnownRemaining(row, known, { estimated: false });
          row.sourceLabel = 'API';
          if (windows.length) row.detail = windows.map(displayWindow).slice(0, 3).join(' · ');
        } else if (windows.length) {
          row.status = 'partial';
          row.source = clean(snapshot?.source) || 'provider-api';
          row.sourceLabel = 'API window';
          row.primary = windows.map(displayWindow).slice(0, 2).join(' · ');
          row.detail = windows.map(displayWindow).slice(2, 5).join(' · ') || 'quota windows only';
        } else {
          applyKnownRemaining(row, localBudget(providerCfg), { estimated: true });
          if (!row.includeInTotal) {
            row.status = 'hidden';
            row.source = 'provider-hidden';
            row.sourceLabel = 'hidden';
            row.primary = 'balance hidden';
            row.detail = 'provider dashboard required';
          }
        }
      } catch (err) {
        row.status = 'error';
        row.source = 'error';
        row.sourceLabel = 'error';
        row.primary = 'fetch failed';
        row.detail = err?.message || String(err);
      }
    }
    row.tone = rowTone(row);
    rows.push(row);
  }

  for (const item of setup.local || []) {
    const row = baseRow(item, 'local', providers[item.id] || {});
    row.status = item.enabled || item.detected ? 'local' : 'missing';
    row.source = 'local-provider';
    row.sourceLabel = item.enabled || item.detected ? 'local' : 'off';
    row.primary = item.enabled || item.detected ? 'local provider' : 'disabled';
    row.detail = item.baseURL || item.defaultURL || 'no billing';
    row.tone = rowTone(row);
    rows.push(row);
  }

  const total = rows.reduce((acc, row) => {
    acc.providerCount += 1;
    acc[`${row.status}Count`] = (acc[`${row.status}Count`] || 0) + 1;
    if (row.includeInTotal && num(row.remainingUsd, null) !== null) {
      acc.knownRemainingUsd += row.remainingUsd;
      if (row.totalBucket === 'api') acc.apiVerifiedRemainingUsd += row.remainingUsd;
      else acc.localEstimatedRemainingUsd += row.remainingUsd;
    }
    if (row.status === 'missing') acc.notConfiguredCount += 1;
    return acc;
  }, {
    providerCount: 0,
    knownRemainingUsd: 0,
    apiVerifiedRemainingUsd: 0,
    localEstimatedRemainingUsd: 0,
    hiddenCount: 0,
    notConfiguredCount: 0,
    errorCount: 0,
  });

  total.knownRemainingUsd = round(total.knownRemainingUsd, 4) || 0;
  total.apiVerifiedRemainingUsd = round(total.apiVerifiedRemainingUsd, 4) || 0;
  total.localEstimatedRemainingUsd = round(total.localEstimatedRemainingUsd, 4) || 0;

  rows.sort((a, b) => {
    const rank = { ok: 0, estimated: 1, partial: 2, hidden: 3, error: 4, missing: 5, local: 6 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.label).localeCompare(String(b.label));
  });

  return {
    title: 'Usage',
    subtitle: 'Total provider quota / balance dashboard',
    checkedAt,
    refresh: options.refresh === true,
    total,
    rows,
    format: { money },
  };
}

