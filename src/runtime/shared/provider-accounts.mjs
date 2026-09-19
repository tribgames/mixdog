import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonAtomicSync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

export const ACCOUNT_PROVIDERS = Object.freeze([
  'openai-oauth',
  'anthropic-oauth',
  'grok-oauth',
  'cursor-oauth',
  'antigravity-oauth',
]);
const MAX_ACCOUNTS = 20;
// `dataDir` defaults to this process's data dir; an isolated runtime passes
// the host's dir explicitly while its own MIXDOG_DATA_DIR points elsewhere.
const file = (dataDir = resolvePluginData()) => join(dataDir, 'provider-accounts.json');

function requireAccountProvider(provider) {
  if (!ACCOUNT_PROVIDERS.includes(provider)) throw new TypeError('Unknown OAuth provider.');
  return provider;
}

function requireAccountId(id) {
  if (id !== 'default' && (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) {
    throw new TypeError('Invalid provider account id.');
  }
  return id;
}

function validate(raw) {
  if (raw == null) return { version: 1, providers: {} };
  if (raw.version !== 1 || !raw.providers || typeof raw.providers !== 'object') {
    throw new Error('Provider account settings are unreadable.');
  }
  for (const [provider, pool] of Object.entries(raw.providers)) {
    requireAccountProvider(provider);
    if (!Array.isArray(pool.accounts) || pool.accounts.length > MAX_ACCOUNTS) {
      throw new Error('Invalid provider account list.');
    }
    const ids = pool.accounts.map((row) => requireAccountId(row.id));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate provider account id.');
  }
  return raw;
}

function read(dataDir) {
  try {
    return validate(JSON.parse(readFileSync(file(dataDir), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return validate(null);
    throw error;
  }
}

// Labels an earlier build assigned automatically. They read as a different
// kind of entry ("default", "existing") next to user-named accounts, so they
// are normalized on read. The legacy label only ever marked the FIRST
// registered credential (later ones were "Account 2", "Account 3"…), so it
// maps to the fixed "Account 1" rather than to the row's current position —
// a position-based name would change every time the user reorders.
const LEGACY_AUTO_LABELS = new Set(['default account', 'existing account', '기존 계정']);

function normalizeLabels(pool) {
  if (!pool) return pool;
  const accounts = pool.accounts.map((row, index) => {
    const label = String(row.label || '').trim();
    if (LEGACY_AUTO_LABELS.has(label.toLowerCase())) return { ...row, label: 'Account 1' };
    if (!label) return { ...row, label: `Account ${index + 1}` };
    return row;
  });
  return { ...pool, accounts };
}

export function readProviderAccountPool(provider, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  return normalizeLabels(read(dataDir).providers[provider]) || { accounts: [], selectedId: null, auto: true };
}

function update(provider, mutate) {
  requireAccountProvider(provider);
  // Read failures must not be interpreted as an empty account roster.
  read();
  const result = updateJsonAtomicSync(
    file(),
    (raw) => {
      const state = validate(raw);
      const pool = state.providers[provider] || { accounts: [], selectedId: null, auto: true };
      mutate(pool);
      state.providers[provider] = pool;
      return validate(state);
    },
    { mode: 0o600, secret: true, fsyncDir: true }
  );
  return normalizeLabels(result.providers[provider]);
}

export function providerAccountPath(provider, id, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  requireAccountId(id);
  return id === 'default' ? null : join(dataDir, 'provider-accounts', provider, `${id}.json`);
}

export function newProviderAccountId() {
  return randomUUID();
}

export function registerProviderAccount(provider, id, { label = '', includeDefault = false } = {}) {
  requireAccountId(id);
  return update(provider, (pool) => {
    if (includeDefault && !pool.accounts.some((row) => row.id === 'default')) {
      pool.accounts.unshift({ id: 'default', label: 'Account 1' });
    }
    if (!pool.accounts.some((row) => row.id === id)) {
      if (pool.accounts.length >= MAX_ACCOUNTS) throw new Error('At most 20 accounts can be connected.');
      pool.accounts.push({ id, label: String(label).trim().slice(0, 80) || `Account ${pool.accounts.length + 1}` });
    }
    pool.selectedId ||= pool.accounts[0]?.id || null;
  });
}

export function changeProviderAccounts(provider, change) {
  if (
    !change ||
    typeof change !== 'object' ||
    Array.isArray(change) ||
    Object.keys(change).some((key) => !['selectedId', 'order', 'auto', 'rename'].includes(key))
  ) {
    throw new TypeError('Invalid provider account change.');
  }
  return update(provider, (pool) => {
    if (change.rename !== undefined) {
      const rename = change.rename;
      if (
        !rename ||
        typeof rename !== 'object' ||
        typeof rename.label !== 'string' ||
        !rename.label.trim() ||
        rename.label.length > 80
      )
        throw new TypeError('Invalid account name.');
      const account = pool.accounts.find((row) => row.id === rename.id);
      if (!account) throw new Error('Account is no longer connected.');
      account.label = rename.label.trim();
    }
    if (change.selectedId !== undefined) {
      requireAccountId(change.selectedId);
      if (!pool.accounts.some((row) => row.id === change.selectedId))
        throw new Error('Account is no longer connected.');
      pool.selectedId = change.selectedId;
    }
    if (change.order !== undefined) {
      const ids = pool.accounts.map((row) => row.id);
      if (
        !Array.isArray(change.order) ||
        change.order.length !== ids.length ||
        new Set(change.order).size !== ids.length ||
        change.order.some((id) => !ids.includes(id))
      ) {
        throw new TypeError('Account order must contain every connected account exactly once.');
      }
      pool.accounts = change.order.map((id) => pool.accounts.find((row) => row.id === id));
    }
    if (change.auto !== undefined) {
      if (typeof change.auto !== 'boolean') throw new TypeError('Automatic account switching must be boolean.');
      pool.auto = change.auto;
    }
  });
}

export function removeProviderAccount(provider, id) {
  requireAccountId(id);
  return update(provider, (pool) => {
    pool.accounts = pool.accounts.filter((row) => row.id !== id);
    if (pool.selectedId === id) pool.selectedId = pool.accounts[0]?.id || null;
  });
}

export function recordProviderAccountUsage(provider, id, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.quotaWindows)) return;
  const windows = snapshot.quotaWindows.slice(0, 12).map((row) => ({
    label: String(row.label || '').slice(0, 40),
    usedPct: typeof row.usedPct === 'number' && Number.isFinite(row.usedPct) ? row.usedPct : null,
    resetAt: typeof row.resetAt === 'number' && Number.isFinite(row.resetAt) ? row.resetAt : null,
  }));
  if (!readProviderAccountPool(provider).accounts.some((row) => row.id === id)) return;
  update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    row.usage = { windows, checkedAt: Date.now() };
    // A fresh observation of available quota releases a prior typed refusal.
    // Only a MEASURED window can testify: a provider that reports a window
    // without a percentage says nothing about that meter, and requiring a
    // number from it kept accounts refused that every real reading had freed.
    const measured = windows.filter((window) => window.usedPct !== null);
    if (measured.length && measured.every((window) => window.usedPct < 100)) clearAccountBlock(row);
  });
}

// A refusal window is an AVOIDANCE hint for the roster, not the retry schedule —
// the request-level retry honours Retry-After on its own. Generous enough to
// cover a full five-hour burst window, tight enough that a header asking for
// four days cannot take an account out of rotation for four days.
const MAX_BLOCK_MS = 6 * 60 * 60_000;

// `model` records WHICH model earned the refusal. A block with no model is
// account-wide, as before. `source` records whether the server scheduled the
// window or we inferred it, which decides whether re-measuring the account
// early can tell us anything.
export function blockProviderAccount(provider, id, until, model = '', source = 'inferred') {
  return update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    row.blockedUntil = Math.min(until, Date.now() + MAX_BLOCK_MS);
    const scope = String(model || '').trim();
    if (scope) row.blockedModel = scope;
    else delete row.blockedModel;
    if (source === 'retry-after') row.blockedSource = source;
    else delete row.blockedSource;
  });
}

// Connecting or hand-picking an account states that its quota is expected to
// be different now. A re-created subscription reuses the same account id, so
// the refusal window and the meter recorded against the OLD subscription would
// otherwise outlive it and refuse a request the provider would have served.
// Both are dropped; the next usage reading refills them.
export function clearProviderAccountQuotaState(provider, id) {
  return update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    clearAccountBlock(row);
    delete row.usage;
  });
}

function clearAccountBlock(row) {
  delete row.blockedUntil;
  delete row.blockedModel;
  delete row.blockedSource;
}

// Single-token weekly labels ("7D Fable", "7D Opus") belong to that Claude
// family only. A full Fable window must not idle an Opus request. Unscoped
// 5H/7D meters and multi-word surfaces ("7D OAuth apps") still apply to every
// model.
const FAMILY_QUOTA_WINDOW = /^7D\s+([A-Za-z][A-Za-z0-9]*)$/i;

function quotaWindowAppliesToModel(window, model) {
  const match = FAMILY_QUOTA_WINDOW.exec(String(window?.label || '').trim());
  if (!match) return true;
  const family = match[1].toLowerCase();
  const id = String(model || '').toLowerCase();
  if (!id) return false;
  return new RegExp(`(?:^|[-_/.@])${family}(?:[-_/.@]|$)`).test(id);
}

// A refusal earned by one model must not idle a model that draws on a
// different meter — the same rule the usage windows already follow. Two models
// share a block when one scoped window covers both; when the account exposes no
// scoped meter at all (a plain 5H/7D subscription) the block stays account-wide,
// because there is no narrower category to attribute it to.
function blockAppliesToModel(row, model) {
  const scope = String(row?.blockedModel || '').trim();
  if (!scope || !model || scope === String(model)) return true;
  const scoped = (row?.usage?.windows || []).filter((window) =>
    FAMILY_QUOTA_WINDOW.test(String(window?.label || '').trim())
  );
  if (!scoped.length) return true;
  return scoped.some((window) => quotaWindowAppliesToModel(window, scope) && quotaWindowAppliesToModel(window, model));
}

export function providerAccountExhausted(row, now = Date.now(), model = '') {
  if (row?.blockedUntil > now && blockAppliesToModel(row, model)) return true;
  return (row?.usage?.windows || []).some(
    (window) =>
      window.usedPct >= 100 &&
      quotaWindowAppliesToModel(window, model) &&
      (window.resetAt ? window.resetAt > now : now - row.usage.checkedAt < 60_000)
  );
}

// How old a recorded reading may be and still steer the roster. Long enough
// that an hour-old reading of a five-hour window still means something, short
// enough that yesterday's number cannot send every fallback to one account.
const USAGE_EVIDENCE_MAX_AGE_MS = 60 * 60_000;

// Remaining headroom across every window that applies to this model, or null
// when nothing recent measured the account. The fullest window decides: an
// account with 4% of its burst window left cannot serve now, however untouched
// its weekly allowance is.
function accountHeadroom(row, now, model) {
  const usage = row?.usage;
  if (!usage || now - usage.checkedAt > USAGE_EVIDENCE_MAX_AGE_MS) return null;
  const used = (usage.windows || [])
    .filter((window) => typeof window.usedPct === 'number' && quotaWindowAppliesToModel(window, model))
    .map((window) => window.usedPct);
  return used.length ? 100 - Math.max(...used) : null;
}

export function chooseProviderAccount(pool, excluded = new Set(), now = Date.now(), model = '') {
  const usable = (row) => row && !excluded.has(row.id) && !providerAccountExhausted(row, now, model);
  const selected = pool.accounts.find((row) => row.id === pool.selectedId);
  if (pool.auto === false) return excluded.has(selected?.id) ? null : selected || null;
  if (usable(selected)) return selected;
  // Falling back in roster order is blind: the account after the one that just
  // refused may itself be nearly spent, so the request pays a second switch to
  // learn what a recorded meter already knew. Ranking needs evidence for EVERY
  // candidate — with a partial roster it would keep picking the one measured
  // account while the unmeasured ones never take their turn.
  const candidates = pool.accounts.filter(usable);
  if (candidates.length < 2) return candidates[0] || null;
  const headroom = candidates.map((row) => accountHeadroom(row, now, model));
  if (headroom.some((value) => value === null)) return candidates[0];
  return candidates[headroom.indexOf(Math.max(...headroom))];
}
