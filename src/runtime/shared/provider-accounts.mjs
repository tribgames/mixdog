import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readJsonStateSync, unsupportedState, updateJsonAtomic } from './atomic-file.mjs';
import { resolvePluginData } from './plugin-paths.mjs';

export const ACCOUNT_PROVIDERS = Object.freeze([
  'openai-oauth',
  'anthropic-oauth',
  'grok-oauth',
  'muse-code-oauth',
  'command-code-oauth',
  'mimo-oauth',
  'cursor-oauth',
  'devin-oauth',
  'antigravity-oauth',
  'opencode-go-oauth',
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
  // A newer build's roster is left in place: reads see no accounts and writes
  // refuse, so a downgrade never discards it.
  if (Number.isSafeInteger(raw.version) && raw.version > 1) {
    throw unsupportedState(`Provider account settings version ${raw.version} is newer than this build.`);
  }
  if (raw.version !== 1 || !raw.providers || typeof raw.providers !== 'object') {
    throw new Error('Provider account settings are unreadable.');
  }
  for (const [provider, pool] of Object.entries(raw.providers)) {
    // A provider a newer build added is carried as is: this build never reads
    // or writes its pool, and treating it as damage would discard it.
    if (!ACCOUNT_PROVIDERS.includes(provider)) continue;
    if (!Array.isArray(pool?.accounts) || pool.accounts.length > MAX_ACCOUNTS) {
      throw new Error('Invalid provider account list.');
    }
    const ids = pool.accounts.map((row) => requireAccountId(row.id));
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate provider account id.');
  }
  return raw;
}

// Every OAuth provider's init reads the roster, so a damaged one (crash
// leftovers, truncation, a shape this build rejects) must never throw: it is
// kept aside and the last good copy, which every write keeps, is restored.
function read(dataDir) {
  return readJsonStateSync(file(dataDir), { validate, fallback: validate(null), secret: true });
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
const ACCOUNT_POLICIES = Object.freeze(['manual', 'limit', 'headroom']);

// `auto` predates `policy` and is still written beside it, so a build that
// knows only `auto` reads the same switching on/off. Whenever the two
// disagree (an older build toggled `auto`), `auto` decides whether switching
// is on at all.
export function providerAccountPolicy(pool) {
  if (pool?.auto === false) return 'manual';
  return pool?.policy === 'headroom' ? 'headroom' : 'limit';
}

// A reading stored before per-model gating is stale: it is dropped on read so
// it steers nothing until the account is measured again.
function dropStaleUsage(provider, row) {
  if (!staleQuotaWindows(provider, row.usage?.windows)) return row;
  const fresh = { ...row };
  delete fresh.usage;
  return fresh;
}

function normalizePool(provider, pool) {
  if (!pool) return pool;
  const policy = providerAccountPolicy(pool);
  const labelled = normalizeLabels(pool);
  const accounts = labelled.accounts.map((row) => dropStaleUsage(provider, row));
  return { ...labelled, accounts, policy, auto: policy !== 'manual' };
}

export function readProviderAccountPool(provider, dataDir = resolvePluginData()) {
  requireAccountProvider(provider);
  return (
    normalizePool(provider, read(dataDir).providers[provider]) || {
      accounts: [],
      selectedId: null,
      auto: true,
      policy: 'limit',
    }
  );
}

async function update(provider, mutate) {
  requireAccountProvider(provider);
  // A roster that parses yet fails validation is recovered here first; the
  // mutator's validate would otherwise refuse every write. I/O failures throw.
  read();
  const result = await updateJsonAtomic(
    file(),
    (raw) => {
      const state = validate(raw);
      const pool = state.providers[provider] || { accounts: [], selectedId: null, auto: true };
      mutate(pool);
      state.providers[provider] = pool;
      return validate(state);
    },
    { mode: 0o600, secret: true, fsyncDir: true, backup: true }
  );
  return normalizePool(provider, result.providers[provider]);
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
  return update(provider, (pool) => {
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
    ...windowScopeFields(row),
  }));
  if (!readProviderAccountPool(provider).accounts.some((row) => row.id === id)) return;
  await update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    row.usage = { windows, checkedAt: Date.now() };
    // A fresh observation of available quota releases a prior refusal. Only
    // the meters the refusal drew on testify (a full Claude/GPT bucket says
    // nothing about a Gemini refusal), and only a MEASURED window: a provider
    // that reports a window without a percentage says nothing about that
    // meter, and requiring a number from it kept accounts refused that every
    // real reading had freed. Each bucket's block is weighed on its own.
    const lifted = (block) => {
      const measured = blockEvidenceWindows(block).filter((window) => window.usedPct !== null);
      return measured.length > 0 && measured.every((window) => window.usedPct < 100);
    };
    setAccountBlocks(
      row,
      accountBlocks(row).filter((block) => !lifted(block))
    );
  });
}

// The model-id tokens a window's gate names, as recorded: lowercased and bounded.
function modelTokens(value) {
  if (!Array.isArray(value)) return null;
  return value
    .slice(0, 12)
    .map((token) =>
      String(token || '')
        .trim()
        .toLowerCase()
        .slice(0, 80)
    )
    .filter(Boolean);
}

function windowScopeFields(row) {
  const models = modelTokens(row.models);
  const except = modelTokens(row.except);
  const limit = typeof row.limit === 'string' ? row.limit.trim().slice(0, 80) : '';
  const scope = {};
  if (models) scope.models = models;
  else if (except?.length) scope.except = except;
  if (limit) scope.limit = limit;
  return scope;
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
// `options.limit` is the server's id of the limit the refusal named; the block
// then covers that limit's windows. `options.reset` marks `until` as the
// quota reset the server named: it is kept as given (a fresh reading showing
// room still lifts it early), while advice and inferred delays stay capped.
// A new refusal of the same model replaces that model's block; every other
// block still running keeps its own deadline, so refusing one bucket never
// frees another.
export async function blockProviderAccount(provider, id, until, model = '', source = 'inferred', options = {}) {
  return update(provider, (pool) => {
    const row = pool.accounts.find((entry) => entry.id === id);
    if (!row) return;
    const now = Date.now();
    const block = { blockedUntil: options.reset === true ? until : Math.min(until, now + MAX_BLOCK_MS) };
    const scope = String(model || '').trim();
    if (scope) block.blockedModel = scope;
    const limit = String(options.limit || '').trim();
    if (limit) block.blockedLimit = limit;
    if (source === 'retry-after') block.blockedSource = source;
    if (options.quota === true) block.blockedQuota = true;
    const running = accountBlocks(row).filter(
      (entry) => entry.blockedUntil > now && String(entry.blockedModel || '') !== scope
    );
    setAccountBlocks(row, [...running, block]);
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

const BLOCK_FIELDS = Object.freeze(['blockedUntil', 'blockedModel', 'blockedLimit', 'blockedSource', 'blockedQuota']);

function clearAccountBlock(row) {
  for (const key of BLOCK_FIELDS) delete row[key];
  delete row.blockedBuckets;
}

const blockOf = (source) =>
  Object.fromEntries(BLOCK_FIELDS.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));

// Every block the account holds, oldest first, each read beside the account's
// usage. The row's own fields carry the latest; earlier blocks of other
// buckets still running sit in `blockedBuckets`.
function accountBlocks(row) {
  const blocks = [
    ...(Array.isArray(row?.blockedBuckets) ? row.blockedBuckets : []),
    ...(row?.blockedUntil === undefined ? [] : [blockOf(row)]),
  ];
  return blocks.map((block) => ({ ...block, usage: row.usage }));
}

function setAccountBlocks(row, blocks) {
  clearAccountBlock(row);
  if (blocks.length) Object.assign(row, blockOf(blocks.at(-1)));
  if (blocks.length > 1) row.blockedBuckets = blocks.slice(0, -1).map(blockOf);
  return row;
}

// The row holding only the blocks `keep` accepts (none by default), so a check
// can weigh the usage windows, or only the quota refusals, on their own.
export function providerAccountWithBlocks(row, keep = () => false) {
  return row && setAccountBlocks({ ...row }, accountBlocks(row).filter(keep));
}

// Labels every current reading scopes with `models`/`except`. A stored window
// carrying one of them without a scope predates per-model gating and would
// read as account-wide, so its whole reading is stale.
const SCOPED_WINDOW_LABELS = Object.freeze({
  'anthropic-oauth': ['EXTRA'],
  'antigravity-oauth': ['7D Argon', '5H Claude/GPT', '7D Claude/GPT'],
  'cursor-oauth': ['Basic', 'API'],
});

export function staleQuotaWindows(provider, windows) {
  const labels = SCOPED_WINDOW_LABELS[provider] || [];
  return (Array.isArray(windows) ? windows : []).some(
    (window) =>
      labels.includes(String(window?.label || '').trim()) &&
      !Array.isArray(window.models) &&
      !Array.isArray(window.except)
  );
}

// Which models one quota window gates — the single rule every window and every
// block follows. The usage reading scopes a window to the server's quota
// bucket: `models` gates only model ids naming one of those tokens (an empty
// list gates nothing: a display-only meter such as paid extra usage), `except`
// gates every model but those. A window without either keeps the older label
// rule: a single-token weekly label ("7D Fable", "7D Opus") belongs to that
// family only, and every other window (5H/7D, multi-word surfaces such as
// "7D OAuth apps") gates every model.
const FAMILY_QUOTA_WINDOW = /^7D\s+([A-Za-z][A-Za-z0-9]*)$/i;

function windowScope(window) {
  if (Array.isArray(window?.models)) return { models: window.models };
  if (Array.isArray(window?.except) && window.except.length) return { except: window.except };
  const family = FAMILY_QUOTA_WINDOW.exec(String(window?.label || '').trim())?.[1];
  return family ? { models: [family.toLowerCase()] } : null;
}

const displayOnly = (window) => Array.isArray(window?.models) && window.models.length === 0;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesModel(model, tokens) {
  const id = String(model).toLowerCase();
  return tokens.some((token) => new RegExp(`(?:^|[-_/.@])${escapeRegExp(token)}(?:[-_/.@]|$)`).test(id));
}

export function quotaWindowAppliesToModel(window, model) {
  const scope = windowScope(window);
  if (!scope) return true;
  if (!model) return false;
  return scope.models ? namesModel(model, scope.models) : !namesModel(model, scope.except);
}

// The meters a block stands for: the windows of the limit the refusal named,
// else the scoped windows that gate the model that earned it.
function blockWindows(row) {
  const windows = row?.usage?.windows || [];
  const limit = String(row?.blockedLimit || '');
  const named = limit ? windows.filter((window) => window.limit === limit) : [];
  if (named.length) return named;
  const earned = String(row?.blockedModel || '').trim();
  return earned ? windows.filter((window) => windowScope(window) && quotaWindowAppliesToModel(window, earned)) : [];
}

// The windows a fresh reading must show below 100% to lift a block: the
// block's own meters plus every meter, scoped or shared, the model that earned
// it (or, for an account-wide block, any model) draws on.
function blockEvidenceWindows(row) {
  const earned = String(row?.blockedModel || '').trim();
  const gating = (row?.usage?.windows || []).filter((window) =>
    earned ? quotaWindowAppliesToModel(window, earned) : !displayOnly(window)
  );
  return [...new Set([...blockWindows(row), ...gating])];
}

// A refusal earned by one model must not idle a model that draws on a
// different meter — the same rule the usage windows follow. Two models share a
// block when one of the block's windows gates both; when the account exposes
// no scoped meter for the model (a plain 5H/7D subscription) the block stays
// account-wide, because there is no narrower category to attribute it to.
function blockAppliesToModel(row, model) {
  const earned = String(row?.blockedModel || '').trim();
  if (!earned || !model || earned === String(model)) return true;
  const windows = blockWindows(row);
  if (!windows.length) return true;
  return windows.some((window) => quotaWindowAppliesToModel(window, model));
}

// When the blocks holding `model` lift (every block when no model is named):
// the latest of their deadlines, or null when none holds it. Past deadlines
// are returned as they are, so a caller compares the result with its clock.
export function providerAccountBlockedUntil(row, model = '') {
  const ends = accountBlocks(row)
    .filter((block) => blockAppliesToModel(block, model))
    .map((block) => Number(block.blockedUntil))
    .filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : null;
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
    for (const block of accountBlocks(row)) {
      if (!(block.blockedUntil > now) || !blockAppliesToModel(block, model)) continue;
      if (block.blockedSource === 'retry-after') times.push(block.blockedUntil);
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
  if (accountBlocks(row).some((block) => block.blockedUntil > now && blockAppliesToModel(block, model))) return true;
  if (options.useCredits === true) return false;
  return (row?.usage?.windows || []).some(
    (window) => quotaWindowAppliesToModel(window, model) && windowFull(row, window, now)
  );
}

// The display name of a scoped limit: the family of a legacy "7D Fable" label,
// else the label without its window prefix ("5H Claude/GPT" → "Claude/GPT").
function quotaWindowFamily(window) {
  const label = String(window?.label || '').trim();
  return FAMILY_QUOTA_WINDOW.exec(label)?.[1] || label.replace(/^(?:5H|7D)\s+/i, '') || label;
}

// Which limit currently holds the account, independent of any one model:
// `{ scope: 'account' }` when every request is refused (an unscoped window is
// full, or a block with no narrower meter to attribute it to), `{ scope:
// 'model', families }` when only scoped meters ("7D Fable", "5H Claude/GPT")
// or a block attributed to one are spent, so other models still run — else null.
export function providerAccountLimit(row, now = Date.now(), options = {}) {
  if (!row) return null;
  const windows = row.usage?.windows || [];
  // A block counts as scoped only when scoped meters cover it; any other
  // refusal is treated as the account's.
  const covering = accountBlocks(row)
    .filter((block) => block.blockedUntil > now)
    .map(blockWindows);
  if (covering.some((meters) => !meters.length || meters.some((window) => !windowScope(window)))) {
    return { scope: 'account' };
  }
  const credits = options.useCredits === true;
  if (!credits && windows.some((window) => !windowScope(window) && windowFull(row, window, now))) {
    return { scope: 'account' };
  }
  const families = new Set(covering.flat().map(quotaWindowFamily));
  if (!credits) {
    for (const window of windows) {
      if (windowScope(window) && !displayOnly(window) && windowFull(row, window, now)) {
        families.add(quotaWindowFamily(window));
      }
    }
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

/** Whether a usage reading taken at `checkedAt` may still steer a decision. */
export function quotaReadingFresh(checkedAt, now = Date.now()) {
  const at = Number(checkedAt);
  return at > 0 && now - at <= USAGE_EVIDENCE_MAX_AGE_MS;
}

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
