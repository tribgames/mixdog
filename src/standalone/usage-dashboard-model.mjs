import { num, round } from '../runtime/agent/orchestrator/providers/lib/usage-primitives.mjs';

export function clean(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || '';
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'N/A';
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

export function normaliseWindows(value, source = 'config') {
  let entries = [];
  if (Array.isArray(value)) {
    entries = value.map((entry, index) => [entry?.label || entry?.name || `W${index + 1}`, entry]);
  } else if (value && typeof value === 'object') {
    entries = Object.entries(value);
  }
  return entries
    .map(([key, entry]) => {
      if (!entry || typeof entry !== 'object') return null;
      const limitUsd = num(
        entry.limitUsd ?? entry.limit_usd ?? entry.budgetUsd ?? entry.budget_usd ?? entry.limit_usd_cents / 100,
        null
      );
      const usedUsd = num(
        entry.usedUsd ??
          entry.used_usd ??
          entry.spendUsd ??
          entry.spend_usd ??
          entry.costUsd ??
          entry.cost_usd ??
          entry.used_usd_cents / 100,
        null
      );
      const remainingUsd = num(
        entry.remainingUsd ??
          entry.remaining_usd ??
          entry.leftUsd ??
          entry.left_usd ??
          entry.balanceUsd ??
          entry.balance_usd ??
          entry.remaining_usd_cents / 100,
        null
      );
      const usedPct = num(entry.usedPct ?? entry.used_pct ?? entry.percent ?? entry.pct, null);
      const remainingCredits = num(
        entry.remainingCredits ?? entry.remaining_credits ?? entry.creditsRemaining ?? entry.credits_remaining,
        null
      );
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
        out.usedPct = round(Math.min(100, (out.usedUsd * 100) / out.limitUsd), 2);
      }
      return out;
    })
    .filter(Boolean);
}

export function normaliseResetCredits(value) {
  if (!value || typeof value !== 'object') return null;
  const availableCount = num(value.availableCount ?? value.available_count, null);
  const offerRevision = clean(value.offerRevision ?? value.offer_revision);
  if (availableCount === null || !offerRevision) return null;
  const nextExpiresAt = num(value.nextExpiresAt ?? value.next_expires_at, null);
  const rawAvailableCredits = value.availableCredits ?? value.available_credits;
  const availableCredits = (Array.isArray(rawAvailableCredits) ? rawAvailableCredits : [])
    .map((credit) => {
      if (!credit || typeof credit !== 'object' || Array.isArray(credit)) return null;
      const expiresAt = num(credit.expiresAt ?? credit.expires_at, null);
      const grantedAt = num(credit.grantedAt ?? credit.granted_at, null);
      return {
        ...(expiresAt && expiresAt > 0 ? { expiresAt } : {}),
        ...(grantedAt && grantedAt > 0 ? { grantedAt } : {}),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY)
    );
  return {
    availableCount: Math.max(0, Math.floor(availableCount)),
    offerRevision,
    availableCredits,
    ...(nextExpiresAt && nextExpiresAt > 0 ? { nextExpiresAt } : {}),
  };
}

export function localBudget(providerCfg = {}) {
  const limitUsd = num(
    providerCfg.limitUsd ??
      providerCfg.limit_usd ??
      providerCfg.budgetUsd ??
      providerCfg.budget_usd ??
      providerCfg.monthlyBudgetUsd ??
      providerCfg.monthly_budget_usd,
    null
  );
  const usedUsd = num(
    providerCfg.usedUsd ??
      providerCfg.used_usd ??
      providerCfg.spendUsd ??
      providerCfg.spend_usd ??
      providerCfg.costUsd ??
      providerCfg.cost_usd,
    null
  );
  const remainingUsd = num(
    providerCfg.remainingUsd ?? providerCfg.remaining_usd ?? providerCfg.leftUsd ?? providerCfg.left_usd,
    null
  );
  if (remainingUsd !== null) {
    return {
      remainingUsd: round(remainingUsd, 4),
      usedUsd: usedUsd === null ? null : round(usedUsd, 4),
      limitUsd: limitUsd === null ? null : round(limitUsd, 4),
      source: 'local-budget',
    };
  }
  if (limitUsd !== null && usedUsd !== null) {
    return {
      remainingUsd: round(Math.max(0, limitUsd - usedUsd), 4),
      usedUsd: round(usedUsd, 4),
      limitUsd: round(limitUsd, 4),
      source: 'local-budget',
    };
  }
  const balance = providerCfg.balance && typeof providerCfg.balance === 'object' ? providerCfg.balance : null;
  const balanceRemaining = num(
    balance?.remainingUsd ?? balance?.remaining_usd ?? balance?.balanceUsd ?? balance?.balance_usd,
    null
  );
  if (balanceRemaining !== null)
    return { remainingUsd: round(balanceRemaining, 4), source: clean(balance?.source) || 'configured-balance' };
  return null;
}

export function snapshotRemaining(snapshot) {
  const balanceRemaining = num(snapshot?.balance?.remainingUsd ?? snapshot?.balance?.remaining_usd, null);
  if (balanceRemaining !== null) {
    const usedUsd = num(snapshot?.balance?.usedUsd ?? snapshot?.balance?.used_usd, null);
    const limitUsd = num(snapshot?.balance?.limitUsd ?? snapshot?.balance?.limit_usd, null);
    return {
      remainingUsd: round(balanceRemaining, 4),
      ...(usedUsd !== null ? { usedUsd: round(usedUsd, 4) } : {}),
      ...(limitUsd !== null ? { limitUsd: round(limitUsd, 4) } : {}),
      source: clean(snapshot?.balance?.source) || clean(snapshot?.source) || 'provider-api',
    };
  }
  const windows = normaliseWindows(snapshot?.quotaWindows, clean(snapshot?.source) || 'provider-api');
  const usd = windows.filter((w) => num(w.remainingUsd, null) !== null);
  if (usd.length === 1)
    return { remainingUsd: usd[0].remainingUsd, source: usd[0].source || clean(snapshot?.source) || 'provider-api' };
  return null;
}

export function snapshotUsage(snapshot) {
  const usedUsd = num(snapshot?.balance?.usedUsd ?? snapshot?.balance?.used_usd, null);
  if (usedUsd === null) return null;
  const limitUsd = num(snapshot?.balance?.limitUsd ?? snapshot?.balance?.limit_usd, null);
  return {
    usedUsd: round(usedUsd, 4),
    limitUsd: limitUsd === null ? null : round(limitUsd, 4),
    source: clean(snapshot?.balance?.source) || clean(snapshot?.source) || 'provider-api',
  };
}

export function snapshotTokenUsage(snapshot) {
  const value = snapshot?.tokenUsage;
  if (!value || typeof value !== 'object') return null;
  const inputTokens = num(value.inputTokens ?? value.input_tokens, 0);
  const outputTokens = num(value.outputTokens ?? value.output_tokens, 0);
  const cachedInputTokens = num(value.cachedInputTokens ?? value.cached_input_tokens, 0);
  const requests = num(value.requests ?? value.numModelRequests ?? value.num_model_requests, 0);
  if (!inputTokens && !outputTokens && !cachedInputTokens && !requests) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    requests,
    source: clean(value.source) || clean(snapshot?.source) || 'provider-api',
  };
}

export function displayWindow(w) {
  const label = String(w?.label || 'USE').toUpperCase();
  if (num(w?.remainingUsd, null) !== null) return `${label} ${money(w.remainingUsd)}`;
  if (num(w?.usedUsd, null) !== null && num(w?.limitUsd, null) !== null)
    return `${label} ${money(w.usedUsd)}/${money(w.limitUsd)}`;
  if (num(w?.remainingCredits, null) !== null && num(w?.limitCredits, null) !== null)
    return `${label} ${compactNumber(w.remainingCredits)}/${compactNumber(w.limitCredits)}`;
  if (num(w?.remainingCredits, null) !== null) return `${label} ${compactNumber(w.remainingCredits)}`;
  if (num(w?.usedCredits, null) !== null && num(w?.limitCredits, null) !== null)
    return `${label} ${compactNumber(w.usedCredits)}/${compactNumber(w.limitCredits)}`;
  if (num(w?.usedPct, null) !== null) return `${label} ${Math.round(w.usedPct)}%`;
  return label;
}

function providerDescription(id, group) {
  switch (String(id || '').toLowerCase()) {
    case 'openai-oauth':
      return 'OpenAI OAuth subscription quota';
    case 'anthropic-oauth':
      return 'Anthropic OAuth subscription quota';
    case 'grok-oauth':
      return 'Grok Build subscription quota';
    case 'antigravity-oauth':
      return 'Antigravity subscription quota';
    case 'opencode-go':
      return 'OpenCode Go subscription quota';
    case 'openai':
      return 'OpenAI API billing';
    case 'anthropic':
      return 'Anthropic API billing';
    case 'deepseek':
      return 'DeepSeek API billing';
    case 'gemini':
      return 'Gemini API billing';
    case 'xai':
      return 'xAI API billing';
    case 'mixdog-local':
      return 'Mixdog Local Provider';
    default:
      if (group === 'local') return 'Local provider';
      return group === 'oauth' ? 'Subscription quota' : 'API billing';
  }
}

function snapshotUnavailable(snapshot) {
  const value = snapshot?.unavailable;
  return value && typeof value === 'object' ? value : null;
}

function apiUnavailableDetail(id, snapshot) {
  const providerId = String(id || '').toLowerCase();
  const unavailable = snapshotUnavailable(snapshot);
  const message = clean(unavailable?.message);
  if (providerId === 'openai') {
    if (/invalid|incorrect api key|unauthorized/i.test(message)) return `OpenAI usage probe failed: ${message}`;
    if (/api\.usage\.read|insufficient permissions/i.test(message)) {
      return 'OpenAI spend needs api.usage.read; remaining credit is web UI only';
    }
    if (message) return `OpenAI usage probe failed: ${message}; remaining credit is web UI only`;
    return 'OpenAI API does not expose remaining credit; org spend needs api.usage.read';
  }
  if (providerId === 'anthropic') {
    if (message) return `Anthropic cost probe: ${message}`;
    return 'Anthropic balance is Console-only; usage needs ANTHROPIC_ADMIN_API_KEY';
  }
  if (providerId === 'gemini') return 'Gemini balance is AI Studio/Cloud Billing only; no key-scope probe';
  if (providerId === 'xai') return message || 'xAI balance needs XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID';
  if (providerId === 'deepseek')
    return message ? `DeepSeek balance unavailable: ${message}` : 'DeepSeek balance unavailable';
  return message || 'Usage not exposed';
}

export function applyApiUnavailable(row, id, snapshot) {
  row.status = 'hidden';
  row.source = snapshotUnavailable(snapshot) ? 'provider-api-unavailable' : 'provider-hidden';
  row.sourceLabel = 'unavailable';
  row.primary = '-';
  row.detail = apiUnavailableDetail(id, snapshot);
  return row;
}

export function rowTone(row) {
  if (row.status === 'error') return 'error';
  if (row.status === 'missing') return 'missing';
  if (row.status === 'local') return 'local';
  const remaining = num(row.remainingUsd, null);
  if (remaining !== null) {
    if (remaining <= 1) return 'danger';
    return remaining <= 5 ? 'warn' : 'ok';
  }
  const pct = Math.max(...(row.windows || []).map((w) => num(w.usedPct, -1)));
  if (pct >= 95) return 'danger';
  if (pct >= 80) return 'warn';
  if (row.status === 'hidden' || row.status === 'partial' || row.status === 'estimated') return 'warn';
  return 'ok';
}

export function baseRow(item, group, providerCfg = {}) {
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
    description: providerDescription(item.id, group),
    updatedAt: null,
    includeInTotal: false,
    totalBucket: null,
    config: providerCfg,
  };
}

const PROVIDER_RANKS = {
  'openai-oauth': 10,
  'anthropic-oauth': 20,
  'grok-oauth': 30,
  'cursor-oauth': 35,
  'antigravity-oauth': 36,
  'opencode-go': 40,
  openai: 50,
  anthropic: 60,
  deepseek: 70,
  gemini: 80,
  xai: 90,
  'mixdog-local': 100,
};

function providerRank(row) {
  const id = String(row?.id || '').toLowerCase();
  return PROVIDER_RANKS[id] ?? 900;
}

export function applyKnownRemaining(row, known, { estimated = false } = {}) {
  if (!known || num(known.remainingUsd, null) === null) return row;
  row.remainingUsd = known.remainingUsd;
  if (known.usedUsd !== null && known.usedUsd !== undefined) row.usedUsd = known.usedUsd;
  if (known.limitUsd !== null && known.limitUsd !== undefined) row.limitUsd = known.limitUsd;
  row.status = estimated ? 'estimated' : 'ok';
  row.source = known.source || (estimated ? 'local-budget' : 'provider-api');
  row.sourceLabel = estimated ? 'local budget' : 'API';
  row.primary = `${money(row.remainingUsd)}`;
  row.detail =
    row.limitUsd !== null && row.usedUsd !== null ? `${money(row.usedUsd)} / ${money(row.limitUsd)} used` : row.source;
  row.includeInTotal = true;
  row.totalBucket = estimated ? 'local' : 'api';
  return row;
}

export function applyKnownUsage(row, known) {
  if (!known || num(known.usedUsd, null) === null) return row;
  row.usedUsd = known.usedUsd;
  if (known.limitUsd !== null && known.limitUsd !== undefined) row.limitUsd = known.limitUsd;
  row.status = 'partial';
  row.source = known.source || 'provider-api';
  row.sourceLabel = 'usage';
  row.primary =
    row.limitUsd !== null && row.limitUsd !== undefined
      ? `Used ${money(row.usedUsd)}/${money(row.limitUsd)}`
      : `Used ${money(row.usedUsd)}`;
  row.detail = 'Spend reported; remaining credit unavailable';
  row.includeInTotal = false;
  row.totalBucket = null;
  return row;
}

export function applyTokenUsage(row, usage) {
  if (!usage) return row;
  const totalTokens = num(usage.inputTokens, 0) + num(usage.outputTokens, 0);
  row.status = 'partial';
  row.source = usage.source || 'provider-api';
  row.sourceLabel = 'usage';
  row.primary = `${compactNumber(totalTokens)} tokens`;
  row.detail = `${compactNumber(usage.inputTokens)} in · ${compactNumber(usage.outputTokens)} out${usage.requests ? ` · ${compactNumber(usage.requests)} req` : ''}`;
  row.includeInTotal = false;
  row.totalBucket = null;
  return row;
}

export function applyWindowQuota(row, windows, { source = 'quota', detail = 'quota windows' } = {}) {
  const normalized = normaliseWindows(windows, source);
  if (!normalized.length) return false;
  const localEstimate = normalized.every((w) => {
    const s = String(w?.source || '').toLowerCase();
    return !s || s.includes('local') || s.includes('config');
  });
  row.windows = normalized;
  row.status = localEstimate ? 'estimated' : 'partial';
  row.source = source;
  row.sourceLabel = localEstimate ? 'local estimate' : source;
  row.primary = normalized.map(displayWindow).slice(0, 2).join(' · ');
  row.detail = localEstimate ? 'Local estimate, not provider-reported' : detail;
  return true;
}

function usageTotal(rows) {
  const total = rows.reduce(
    (acc, row) => {
      acc.providerCount += 1;
      acc[`${row.status}Count`] = (acc[`${row.status}Count`] || 0) + 1;
      if (row.includeInTotal && num(row.remainingUsd, null) !== null) {
        acc.knownRemainingUsd += row.remainingUsd;
        if (row.totalBucket === 'api') acc.apiVerifiedRemainingUsd += row.remainingUsd;
        else acc.localEstimatedRemainingUsd += row.remainingUsd;
      }
      if (row.status === 'missing') acc.notConfiguredCount += 1;
      return acc;
    },
    {
      providerCount: 0,
      knownRemainingUsd: 0,
      apiVerifiedRemainingUsd: 0,
      localEstimatedRemainingUsd: 0,
      hiddenCount: 0,
      notConfiguredCount: 0,
      errorCount: 0,
    }
  );
  total.knownRemainingUsd = round(total.knownRemainingUsd, 4) || 0;
  total.apiVerifiedRemainingUsd = round(total.apiVerifiedRemainingUsd, 4) || 0;
  total.localEstimatedRemainingUsd = round(total.localEstimatedRemainingUsd, 4) || 0;
  return total;
}

function snapshotRow(row) {
  return {
    ...row,
    windows: row.windows.map((window) => ({ ...window })),
    ...(row.resetCredits
      ? {
          resetCredits: {
            ...row.resetCredits,
            availableCredits: row.resetCredits.availableCredits.map((credit) => ({ ...credit })),
          },
        }
      : {}),
  };
}

export function usageDashboardSnapshot(rows, { checkedAt, refresh = false, checking = false } = {}) {
  return {
    title: 'Provider Quotas',
    subtitle: 'Statusline-style provider quota windows.',
    checkedAt,
    refresh: refresh === true,
    checking: checking === true,
    total: usageTotal(rows),
    // Each publication owns its rows: later probes and UI observers must not
    // change a previously published snapshot or mutate the collector through it.
    rows: rows
      .slice()
      .sort((a, b) => providerRank(a) - providerRank(b) || String(a.label).localeCompare(String(b.label)))
      .map(snapshotRow),
    format: { money },
  };
}
