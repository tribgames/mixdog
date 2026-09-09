import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonAtomicSync } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

export const ACCOUNT_PROVIDERS = Object.freeze([
  'openai-oauth', 'anthropic-oauth', 'grok-oauth', 'cursor-oauth', 'antigravity-oauth',
]);
const MAX_ACCOUNTS = 20;
const file = () => join(resolvePluginData(), 'provider-accounts.json');

export function requireAccountProvider(provider) {
  if (!ACCOUNT_PROVIDERS.includes(provider)) throw new TypeError('Unknown OAuth provider.');
  return provider;
}

export function requireAccountId(id) {
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

function read() {
  try { return validate(JSON.parse(readFileSync(file(), 'utf8'))); }
  catch (error) {
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

export function readProviderAccountPool(provider) {
  requireAccountProvider(provider);
  return normalizeLabels(read().providers[provider]) || { accounts: [], selectedId: null, auto: true };
}

function update(provider, mutate) {
  requireAccountProvider(provider);
  // Read failures must not be interpreted as an empty account roster.
  read();
  const result = updateJsonAtomicSync(file(), (raw) => {
    const state = validate(raw);
    const pool = state.providers[provider] || { accounts: [], selectedId: null, auto: true };
    mutate(pool);
    state.providers[provider] = pool;
    return validate(state);
  }, { mode: 0o600, secret: true, fsyncDir: true });
  return normalizeLabels(result.providers[provider]);
}

export function providerAccountPath(provider, id) {
  requireAccountProvider(provider);
  requireAccountId(id);
  return id === 'default' ? null
    : join(resolvePluginData(), 'provider-accounts', provider, `${id}.json`);
}

export function newProviderAccountId() { return randomUUID(); }

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
  if (!change || typeof change !== 'object' || Array.isArray(change)
    || Object.keys(change).some((key) => !['selectedId', 'order', 'auto', 'rename'].includes(key))) {
    throw new TypeError('Invalid provider account change.');
  }
  return update(provider, (pool) => {
    if (change.rename !== undefined) {
      const rename = change.rename;
      if (!rename || typeof rename !== 'object' || typeof rename.label !== 'string'
        || !rename.label.trim() || rename.label.length > 80) throw new TypeError('Invalid account name.');
      const account = pool.accounts.find((row) => row.id === rename.id);
      if (!account) throw new Error('Account is no longer connected.');
      account.label = rename.label.trim();
    }
    if (change.selectedId !== undefined) {
      requireAccountId(change.selectedId);
      if (!pool.accounts.some((row) => row.id === change.selectedId)) throw new Error('Account is no longer connected.');
      pool.selectedId = change.selectedId;
    }
    if (change.order !== undefined) {
      const ids = pool.accounts.map((row) => row.id);
      if (!Array.isArray(change.order) || change.order.length !== ids.length
        || new Set(change.order).size !== ids.length || change.order.some((id) => !ids.includes(id))) {
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
    if (windows.length && windows.every((window) => window.usedPct !== null && window.usedPct < 100)) {
      delete row.blockedUntil;
    }
  });
}

export function blockProviderAccount(provider, id, until) {
  return update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (row) row.blockedUntil = until;
  });
}

export function providerAccountExhausted(row, now = Date.now()) {
  if (row?.blockedUntil > now) return true;
  return (row?.usage?.windows || []).some((window) =>
    window.usedPct >= 100 && (window.resetAt ? window.resetAt > now : now - row.usage.checkedAt < 60_000));
}

export function chooseProviderAccount(pool, excluded = new Set(), now = Date.now()) {
  const usable = (row) => row && !excluded.has(row.id) && !providerAccountExhausted(row, now);
  const selected = pool.accounts.find((row) => row.id === pool.selectedId);
  if (pool.auto === false) return excluded.has(selected?.id) ? null : selected || null;
  if (usable(selected)) return selected;
  return pool.accounts.find(usable) || null;
}
