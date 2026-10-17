import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonText, updateJsonAtomic } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

export const ACCOUNT_PROVIDERS = Object.freeze([
  'openai-oauth',
  'anthropic-oauth',
  'grok-oauth',
  'muse-code-oauth',
  'command-code-oauth',
  'mimo-oauth',
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
  if (raw.defaultAccountEpochs !== undefined) {
    if (!raw.defaultAccountEpochs || typeof raw.defaultAccountEpochs !== 'object' || Array.isArray(raw.defaultAccountEpochs)) {
      throw new Error('Provider account lifecycle settings are unreadable.');
    }
    for (const [provider, epoch] of Object.entries(raw.defaultAccountEpochs)) {
      requireAccountProvider(provider);
      if (typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(epoch)) {
        throw new Error('Provider account lifecycle settings are unreadable.');
      }
    }
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
    return validate(parseJsonText(readFileSync(file(dataDir), 'utf8')));
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

// How the roster picks an account. `manual` serves from the selected account
// only; `limit` keeps the selected account until it reaches a limit and then
// moves to the account with the most headroom; `headroom` starts every new
// session on the account with the most headroom and keeps it for that session.
export const ACCOUNT_POLICIES = Object.freeze(['manual', 'limit', 'headroom']);

// `auto` predates `policy` and is still written beside it, so a build that
// knows only `auto` reads the same switching on/off. Whenever the two
// disagree (an older build toggled `auto`), `auto` decides whether switching
// is on at all.
export function providerAccountPolicy(pool) {
  if (pool?.auto === false) return 'manual';
  return pool?.policy === 'headroom' ? 'headroom' : 'limit';
}

function normalizePool(pool) {
  if (!pool) return pool;
  const policy = providerAccountPolicy(pool);
  return { ...normalizeLabels(pool), policy, auto: policy !== 'manual' };
}

export function readProviderAccountPool(provider, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  return (
    normalizePool(read(dataDir).providers[provider]) || { accounts: [], selectedId: null, auto: true, policy: 'limit' }
  );
}

// Private metering lifecycle evidence, deliberately outside the public pool
// shape. Legacy/implicit defaults retain their original scope until removal;
// materializing a default or refreshing its credentials does not rotate it.
export function providerAccountUsageIncarnation(provider, id, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  requireAccountId(id);
  return id === 'default' ? read(dataDir).defaultAccountEpochs?.[provider] ?? null : null;
}

async function update(provider, mutate) {
  requireAccountProvider(provider);
  // Read failures must not be interpreted as an empty account roster.
  read();
  const result = await updateJsonAtomic(
    file(),
    (raw) => {
      const state = validate(raw);
      const pool = state.providers[provider] || { accounts: [], selectedId: null, auto: true };
      mutate(pool, state);
      state.providers[provider] = pool;
      return validate(state);
    },
    { mode: 0o600, secret: true, fsyncDir: true }
  );
  return normalizePool(result.providers[provider]);
}

/**
 * The provider-side session one account sends under: account-bound
 * connection and delta state stays apart per account without changing the
 * visible Mixdog session. Usage recorded before spend kept the visible id
 * carries this id, so a session's past spend is found through it as well.
 */
export function accountScopedSessionId(provider, accountId, sessionId) {
  return `account-${createHash('sha256').update(`${provider}:${accountId}:${sessionId}`).digest('hex')}`;
}

export function providerAccountPath(provider, id, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  requireAccountId(id);
  return id === 'default' ? null : join(dataDir, 'provider-accounts', provider, `${id}.json`);
}

export function newProviderAccountId() {
  return randomUUID();
}

export async function registerProviderAccount(provider, id, { label = '', includeDefault = false } = {}) {
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

export async function changeProviderAccounts(provider, change) {
  if (
    !change ||
    typeof change !== 'object' ||
    Array.isArray(change) ||
    Object.keys(change).some((key) => !['selectedId', 'order', 'auto', 'policy', 'useCredits', 'rename'].includes(key))
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
      // Turning switching on keeps a non-manual policy; on from manual is the
      // classic switch-at-limit behaviour.
      const current = providerAccountPolicy(pool);
      if (!change.auto) pool.policy = 'manual';
      else if (current === 'manual') pool.policy = 'limit';
      else pool.policy = current;
      pool.auto = change.auto;
    }
    if (change.policy !== undefined) {
      if (!ACCOUNT_POLICIES.includes(change.policy)) throw new TypeError('Unknown account switching policy.');
      pool.policy = change.policy;
      pool.auto = change.policy !== 'manual';
    }
    if (change.useCredits !== undefined) {
      if (typeof change.useCredits !== 'boolean') throw new TypeError('Credit use must be boolean.');
      pool.useCredits = change.useCredits;
    }
  });
}

// Selects `id` only while the selection is still `expectedSelectedId`, checked
// under the write's own lock, so a newer selection (a manual switch) wins. A
// given `expectedPolicy` must also still hold: a policy change while the
// request ran (e.g. to Manual) cancels the commit.
// Returns the pool when the selection moved, otherwise null.
export async function selectProviderAccountIf(provider, expectedSelectedId, id, expectedPolicy) {
  requireAccountId(id);
  let moved = false;
  const pool = await update(provider, (pool) => {
    if (pool.selectedId !== expectedSelectedId || !pool.accounts.some((row) => row.id === id)) return;
    if (expectedPolicy && providerAccountPolicy(pool) !== expectedPolicy) return;
    pool.selectedId = id;
    moved = true;
  });
  return moved ? pool : null;
}

export async function removeProviderAccount(provider, id) {
  requireAccountId(id);
  return update(provider, (pool, state) => {
    // A default can be authenticated without a materialized row. Its explicit
    // removal is still a lifecycle boundary; keep the tombstone when empty so
    // a later login cannot resurrect the removed lifetime's history scope.
    if (id === 'default') {
      state.defaultAccountEpochs = { ...state.defaultAccountEpochs, [provider]: randomUUID() };
    }
    pool.accounts = pool.accounts.filter((row) => row.id !== id);
    if (pool.selectedId === id) pool.selectedId = pool.accounts[0]?.id || null;
  });
}

export async function recordProviderAccountUsage(provider, id, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.quotaWindows)) return;
  const windows = snapshot.quotaWindows.slice(0, 12).map((row) => ({
    label: String(row.label || '').slice(0, 40),
    usedPct: typeof row.usedPct === 'number' && Number.isFinite(row.usedPct) ? row.usedPct : null,
    resetAt: typeof row.resetAt === 'number' && Number.isFinite(row.resetAt) ? row.resetAt : null,
  }));
  if (!readProviderAccountPool(provider).accounts.some((row) => row.id === id)) return;
  await update(provider, (pool) => {
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
// `options.quota` records that the block came from a typed quota refusal or an
// exhausted usage window, so later sends still count it as quota evidence.
export async function blockProviderAccount(provider, id, until, model = '', source = 'inferred', options = {}) {
  return update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    row.blockedUntil = Math.min(until, Date.now() + MAX_BLOCK_MS);
    const scope = String(model || '').trim();
    if (scope) row.blockedModel = scope;
    else delete row.blockedModel;
    if (source === 'retry-after') row.blockedSource = source;
    else delete row.blockedSource;
    if (options.quota === true) row.blockedQuota = true;
    else delete row.blockedQuota;
  });
}

// Connecting or hand-picking an account states that its quota is expected to
// be different now. A re-created subscription reuses the same account id, so
// the refusal window and the meter recorded against the OLD subscription would
// otherwise outlive it and refuse a request the provider would have served.
// Both are dropped; the next usage reading refills them.
export async function clearProviderAccountQuotaState(provider, id) {
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
  delete row.blockedQuota;
}

// Single-token weekly labels ("7D Fable", "7D Opus") belong to that Claude
// family only. A full Fable window must not idle an Opus request. Unscoped
// 5H/7D meters and multi-word surfaces ("7D OAuth apps") still apply to every
// model.
const FAMILY_QUOTA_WINDOW = /^7D\s+([A-Za-z][A-Za-z0-9]*)$/i;

export function quotaWindowAppliesToModel(window, model) {
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

// Earliest moment any of the given exhausted accounts can serve `model` again,
// or null when unknown. Per account the LATEST blocking reset counts (every
// blocking window must clear); across accounts the EARLIEST account does. A
// server-scheduled block (`retry-after`) is a known time; an inferred block or
// a full window without a reset time leaves that account's reset unknown.
export function providerAccountsResetAt(rows, now = Date.now(), model = '', options = {}) {
  const known = [];
  for (const row of rows || []) {
    if (!providerAccountExhausted(row, now, model, options)) continue;
    const times = [];
    let unknown = false;
    if (row.blockedUntil > now && blockAppliesToModel(row, model)) {
      if (row.blockedSource === 'retry-after') times.push(row.blockedUntil);
      else unknown = true;
    }
    if (options.useCredits !== true) {
      for (const window of row.usage?.windows || []) {
        if (!(window.usedPct >= 100) || !quotaWindowAppliesToModel(window, model)) continue;
        if (window.resetAt > now) times.push(window.resetAt);
        else if (!window.resetAt && now - row.usage.checkedAt < 60_000) unknown = true;
      }
    }
    if (!unknown && times.length) known.push(Math.max(...times));
  }
  return known.length ? Math.min(...known) : null;
}

function windowFull(row, window, now) {
  return window.usedPct >= 100 && (window.resetAt ? window.resetAt > now : now - row.usage.checkedAt < 60_000);
}

export function providerAccountExhausted(row, now = Date.now(), model = '', options = {}) {
  if (row?.blockedUntil > now && blockAppliesToModel(row, model)) return true;
  if (options.useCredits === true) return false;
  return (row?.usage?.windows || []).some(
    (window) => quotaWindowAppliesToModel(window, model) && windowFull(row, window, now)
  );
}

function quotaWindowFamily(window) {
  return FAMILY_QUOTA_WINDOW.exec(String(window?.label || '').trim())?.[1] || '';
}

// Which limit currently holds the account, independent of any one model:
// `{ scope: 'account' }` when every request is refused (an unscoped window is
// full, or a block with no narrower meter to attribute it to), `{ scope:
// 'model', families }` when only model-family meters ("7D Fable") or a block
// attributed to one are spent, so other models still run — else null.
export function providerAccountLimit(row, now = Date.now(), options = {}) {
  if (!row) return null;
  const windows = row.usage?.windows || [];
  const blocked = row.blockedUntil > now;
  const scope = String(row.blockedModel || '').trim();
  const scopedWindows = windows.filter((window) => quotaWindowFamily(window));
  // A block counts as family-scoped only when a family meter covers the model
  // that earned it; any other refusal is treated as the account's.
  const covering = scope ? scopedWindows.filter((window) => quotaWindowAppliesToModel(window, scope)) : [];
  if (blocked && !covering.length) return { scope: 'account' };
  const credits = options.useCredits === true;
  if (!credits && windows.some((window) => !quotaWindowFamily(window) && windowFull(row, window, now))) {
    return { scope: 'account' };
  }
  const families = new Set(blocked ? covering.map(quotaWindowFamily) : []);
  if (!credits) {
    for (const window of scopedWindows) if (windowFull(row, window, now)) families.add(quotaWindowFamily(window));
  }
  return families.size ? { scope: 'model', families: [...families] } : null;
}

// The account refuses `model` only through a model-scoped limit: it still
// serves other models, so it remains the provider's account of record.
export function providerAccountExhaustedForModelOnly(row, now = Date.now(), model = '', options = {}) {
  return (
    providerAccountExhausted(row, now, model, options) && providerAccountLimit(row, now, options)?.scope === 'model'
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

// `sessionAccountId` is the account the requesting session already runs on
// (headroom policy only): kept while usable, so a session switches only on a
// limit. Without one, the session's first request takes the account with the
// most headroom.
export function chooseProviderAccount(
  pool,
  excluded = new Set(),
  now = Date.now(),
  model = '',
  { sessionAccountId } = {}
) {
  const options = { useCredits: pool.useCredits === true };
  const usable = (row) => row && !excluded.has(row.id) && !providerAccountExhausted(row, now, model, options);
  const selected = pool.accounts.find((row) => row.id === pool.selectedId);
  const policy = providerAccountPolicy(pool);
  if (policy === 'manual') {
    if (excluded.has(selected?.id)) return null;
    return options.useCredits || usable(selected) ? selected || null : null;
  }
  const preferred =
    policy === 'headroom' ? pool.accounts.find((row) => sessionAccountId && row.id === sessionAccountId) : selected;
  if (usable(preferred)) return preferred;
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
