import {
  ACCOUNT_PROVIDERS,
  accountScopedSessionId,
  readProviderAccountPool,
  chooseProviderAccount,
  selectProviderAccountIf,
  blockProviderAccount,
  providerAccountExhausted,
  providerAccountExhaustedForModelOnly,
  providerAccountPolicy,
  providerAccountsResetAt,
} from '../../../shared/provider-accounts.mjs';
import { withProviderAccount, hasExplicitProviderAuthBinding } from '../../../shared/provider-auth-binding.mjs';
import { retryAfterMsFromError, isExplicitUserAbortError, typedErrorCode } from './retry-classifier.mjs';
import { fetchOAuthUsageSnapshot, readCachedOAuthUsageSnapshot } from './oauth-usage.mjs';

// Only an explicit quota refusal advances the roster; a generic 429, auth
// refusal, policy denial or transport failure retains its existing recovery.
export function isAccountQuotaError(error) {
  const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
  if (status === 401 || status === 403 || isExplicitUserAbortError(error)) return false;
  return ['insufficient_quota', 'quota_exceeded', 'usage_limit_reached', 'usage_not_included'].includes(
    String(typedErrorCode(error) || error?.error?.type || '').toLowerCase()
  );
}

// Burst throttles reopen within seconds. A 429 whose Retry-After points
// minutes or days ahead is a closed subscription window, whichever scoped
// limit the usage endpoint attributes it to.
const QUOTA_WINDOW_RETRY_AFTER_MS = 60_000;

// A refused account is never dispatched to again, so no ordinary success can
// prove its quota came back: the roster only shrinks until the window expires.
// Before the pool gives up, it re-measures EVERY account it is about to refuse
// for — including one the server scheduled with Retry-After, because a
// re-created subscription invalidates that schedule as surely as it
// invalidates our own inference. The usage endpoint costs no model tokens, and
// a reading below 100% releases the account. Paced per account so repeated
// refusals inside one turn cannot turn recovery into polling; a new user
// request clears that pacing (`resetAccountProbePacing`).
const PROBE_INTERVAL_MS = 5 * 60_000;
const lastProbeAt = new Map();

// Sending a request is the user asking for a current answer, so the refusal it
// may run into must be re-measured rather than repeated from a stored reading.
// Called once per agent loop entry — never per in-turn provider round, which
// is what keeps the pacing meaningful.
export function resetAccountProbePacing() {
  lastProbeAt.clear();
}

async function probeRefusedAccounts(providerName, pool, model, account) {
  const now = Date.now();
  const due = pool.accounts
    .filter((row) => providerAccountExhausted(row, now, model, { useCredits: pool.useCredits === true }))
    .filter((row) => now - (lastProbeAt.get(`${providerName}:${row.id}`) || 0) >= PROBE_INTERVAL_MS)
    .sort((a, b) => (a.usage?.checkedAt || 0) - (b.usage?.checkedAt || 0));
  if (!due.length) return false;
  await Promise.all(
    due.map((row) => {
      lastProbeAt.set(`${providerName}:${row.id}`, now);
      return fetchOAuthUsageSnapshot({ provider: providerName, accountId: row.id }, account(row.id), () => {}, {
        force: true,
      }).catch(() => null);
    })
  );
  return true;
}

function accountsExhaustedError(useCredits) {
  const error = new Error(
    useCredits
      ? 'All connected accounts have exhausted their quota. Check account usage and reset times.'
      : 'The plan limit is reached and credit use is off. Turn on credit use or wait for the limit to reset.'
  );
  error.code = 'provider_accounts_exhausted';
  return error;
}

// Structured proof that the send ended because no account can serve `model`
// (not merely because a generic 429 or a stopped loop surfaced an error).
function quotaExhausted(error, providerName, model, rows, options = {}) {
  if (error && typeof error === 'object') {
    error.quotaExhausted = {
      provider: providerName,
      model: String(model || ''),
      resetAt: providerAccountsResetAt(rows, Date.now(), model, options),
    };
  }
  return error;
}

// The send bound to one account: output callbacks are observed even when the
// caller does not subscribe, and account-bound connection/delta state stays
// apart without changing the visible Mixdog session, so no stale server state
// crosses an account switch. `emitted()` reports whether output reached the
// caller.
function boundAccountSend(providerName, row, messages, options) {
  let emitted = false;
  const opts = { ...options };
  for (const key of ['onStreamDelta', 'onTextDelta', 'onToolCall', 'onThinkingDelta']) {
    opts[key] = (...args) => {
      emitted = true;
      return options[key]?.(...args);
    };
  }
  if (options.sessionId) {
    opts.sessionId = accountScopedSessionId(providerName, row.id, options.sessionId);
    // The spend still belongs to the visible session (usage-accounting.mjs).
    opts.usageSessionId = options.usageSessionId || options.sessionId;
  }
  opts.providerState = options.providerState?.providerAccountId === row.id ? options.providerState : undefined;
  const history = messages.map((message) => {
    if (message.providerReplay?.accountId === row.id) return message;
    const { providerReplay, reasoning, thinkingBlocks, ...plain } = message;
    return plain;
  });
  return { opts, history, emitted: () => emitted };
}

// Commit only a successful fallback, without overwriting a newer selection:
// the selection is compared under the write's lock, not before it. A fallback
// forced by a model-scoped limit ("7D Fable" full, or a block attributed to
// one family) serves this request only: the selected account still serves
// every other model, so it stays the provider's account of record.
async function commitFallbackAccount(providerName, pool, row, model, refusalScoped, policy) {
  if (row.id === pool.selectedId || refusalScoped) return null;
  if (accountExhaustedForModelOnly(providerName, pool.selectedId, model)) return null;
  return selectProviderAccountIf(providerName, pool.selectedId, row.id, policy);
}

// The account each session runs on under the headroom policy. Every answer
// records its provider and account in the assistant message's
// `providerMetadata` (and in provider state when the adapter keeps one), so
// the binding survives a restart and eviction from this map, which only
// spares the history walk. Bounded, oldest binding first out.
const SESSION_ACCOUNT_LIMIT = 1000;
const ROUTING_METADATA_KEY = 'accountRouting';
const sessionAccounts = new Map();

// Forget every in-memory binding, as a restart does (tests).
export function resetSessionAccountBindings() {
  sessionAccounts.clear();
}

function rememberSessionAccount(key, id) {
  sessionAccounts.delete(key);
  sessionAccounts.set(key, id);
  if (sessionAccounts.size > SESSION_ACCOUNT_LIMIT) sessionAccounts.delete(sessionAccounts.keys().next().value);
}

function accountExhaustedForModelOnly(providerName, id, model) {
  const pool = readProviderAccountPool(providerName);
  const row = pool.accounts.find((entry) => entry.id === id);
  return (
    Boolean(row) &&
    providerAccountExhaustedForModelOnly(row, Date.now(), model, { useCredits: pool.useCredits === true })
  );
}

// Only a binding recorded for THIS provider counts: a session that switched
// providers carries another roster's account ids (every roster has a `default`).
// The session's binding is read before the serving account, which differs
// when a model-scoped limit lent this one answer to another account.
function sessionAccountId(providerName, key, messages, options) {
  if (key && sessionAccounts.has(key)) return sessionAccounts.get(key);
  const state = options.providerState;
  if (state?.providerAccountId && state.providerAccountProvider === providerName) {
    return state.providerSessionAccountId || state.providerAccountId;
  }
  for (let index = (messages?.length || 0) - 1; index >= 0; index -= 1) {
    const routing = messages[index]?.providerMetadata?.[ROUTING_METADATA_KEY];
    if (routing?.accountId && routing.provider === providerName) return routing.sessionAccountId || routing.accountId;
  }
  return null;
}

// Stamp the serving account on the answer, independent of transport state,
// with the account the session stays bound to (`bindingId`).
function recordServingAccount(providerName, result, id, bindingId) {
  if (!result || typeof result !== 'object') return;
  if (result.providerReplay) result.providerReplay = { ...result.providerReplay, accountId: id };
  if (result.providerState) {
    result.providerState = {
      ...result.providerState,
      providerAccountId: id,
      providerSessionAccountId: bindingId,
      providerAccountProvider: providerName,
    };
  }
  const metadata =
    result.providerMetadata && typeof result.providerMetadata === 'object' ? result.providerMetadata : {};
  result.providerMetadata = {
    ...metadata,
    [ROUTING_METADATA_KEY]: { provider: providerName, accountId: id, sessionAccountId: bindingId },
  };
}

// Whether the failed account's quota window is exhausted, plus the server's
// retry delay. Anthropic and other subscriptions may use the same 429 code
// for burst throttling and exhausted subscription windows, so the native
// usage endpoint decides rather than a human-readable message.
async function accountQuotaExhausted(providerName, row, model, error, account) {
  const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
  const delay = retryAfterMsFromError(error);
  const typed = isAccountQuotaError(error);
  let exhausted = typed || (status === 429 && delay > QUOTA_WINDOW_RETRY_AFTER_MS);
  // Proof of a spent quota: a typed quota refusal or an exhausted usage window
  // (a long Retry-After alone only rotates the roster, it proves nothing).
  let evidence = typed;
  if (!typed && status === 429) {
    await fetchOAuthUsageSnapshot({ provider: providerName, accountId: row.id }, account(row.id), () => {}, {
      force: true,
    });
    const pool = readProviderAccountPool(providerName);
    const entry = pool.accounts.find((item) => item.id === row.id);
    const options = { useCredits: pool.useCredits === true };
    evidence = providerAccountExhausted({ ...entry, blockedUntil: 0 }, Date.now(), model, options);
    exhausted = exhausted || evidence || providerAccountExhausted(entry, Date.now(), model, options);
  }
  return { exhausted, delay, evidence };
}

// The pool's send: walks the eligible accounts until one answers, blocking
// the ones whose quota window is exhausted along the way.
function poolSend(providerName, account) {
  return async function send(messages, model, tools, options = {}) {
    const attempted = new Set();
    let lastError;
    let probed = false;
    const evidenced = new Set();
    const sessionKey = options.sessionId ? `${providerName}:${options.sessionId}` : null;
    const boundId = sessionAccountId(providerName, sessionKey, messages, options);
    // Whether this send already left an account, and whether the latest quota
    // refusal held only for this model's family.
    let switched = false;
    let refusalScoped = false;
    // Mark `error` only when every account in `ids` (default: the roster) is
    // exhausted with quota evidence: observed in this send, or a full window.
    const markExhausted = (error, ids) => {
      const pool = readProviderAccountPool(providerName);
      // Manual policy: the eligible set is the selected account alone.
      const scope = ids || (providerAccountPolicy(pool) === 'manual' ? [pool.selectedId] : null);
      const rows = scope ? pool.accounts.filter((entry) => scope.includes(entry.id)) : pool.accounts;
      const opts = { useCredits: pool.useCredits === true };
      const now = Date.now();
      const all =
        rows.length > 0 &&
        rows.every((entry) =>
          providerAccountExhausted(
            evidenced.has(entry.id) || entry.blockedQuota === true ? entry : { ...entry, blockedUntil: 0 },
            now,
            model,
            opts
          )
        );
      return all ? quotaExhausted(error, providerName, model, rows, opts) : error;
    };
    while (attempted.size < 20) {
      options.signal?.throwIfAborted();
      const pool = readProviderAccountPool(providerName);
      if (!pool.accounts.length) {
        if (pool.useCredits !== true) {
          const stored = readCachedOAuthUsageSnapshot({ provider: providerName, model: '' });
          if (stored?.quotaWindows?.length) {
            const row = { usage: { windows: stored.quotaWindows, checkedAt: stored.cachedAt } };
            if (providerAccountExhausted(row, Date.now(), model)) {
              throw quotaExhausted(accountsExhaustedError(false), providerName, model, [row]);
            }
          }
        }
        return account('default').send(messages, model, tools, options);
      }
      const policy = providerAccountPolicy(pool);
      const row = chooseProviderAccount(pool, attempted, Date.now(), model, { sessionAccountId: boundId });
      if (!row) {
        // Once per send: a refusal built on a stale meter must not outlive the
        // meter. Re-measuring can only widen the roster, so it is tried before
        // the failure is reported, never in place of reporting it.
        if (!probed) {
          probed = true;
          if (await probeRefusedAccounts(providerName, pool, model, account)) continue;
        }
        throw markExhausted(lastError || accountsExhaustedError(pool.useCredits === true));
      }
      attempted.add(row.id);
      const bound = boundAccountSend(providerName, row, messages, options);
      try {
        const result = await account(row.id).send(bound.history, model, tools, bound.opts);
        // Headroom policy: a session's first pick, or its move off its account
        // on a limit, becomes the selection; continuing on its account does
        // not, so concurrent sessions never flip the selection back and forth.
        // A move forced by a model-scoped limit serves this request only.
        const leftBound = Boolean(boundId) && row.id !== boundId;
        const scoped = switched
          ? refusalScoped
          : policy === 'headroom' && leftBound && accountExhaustedForModelOnly(providerName, boundId, model);
        recordServingAccount(providerName, result, row.id, scoped && boundId ? boundId : row.id);
        if (sessionKey && policy === 'headroom' && !scoped) rememberSessionAccount(sessionKey, row.id);
        const commit = policy !== 'headroom' || !boundId || leftBound;
        if (commit && (await commitFallbackAccount(providerName, pool, row, model, scoped, policy))) {
          // Publish only a committed selection, never a speculative retry or
          // one superseded by a manual switch. The existing progress channel
          // carries this across runtime shards to the attached UI.
          try {
            await options.onStageChange?.('account-changed', {
              provider: providerName,
              accountId: row.id,
              at: Date.now(),
            });
          } catch {
            // A UI refresh must not turn a successful model response into a retry.
          }
        }
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error?.reauthRequired === true) {
          if (
            policy === 'manual' ||
            bound.emitted() ||
            error.unsafeToRetry ||
            error.liveTextEmitted ||
            error.emittedToolCall
          )
            throw error;
          lastError = error;
          switched = true;
          refusalScoped = false;
          options.onStageChange?.('reconnecting', { message: 'Sign-in expired — switching to the next account' });
          continue;
        }
        const { exhausted, delay, evidence } = await accountQuotaExhausted(providerName, row, model, error, account);
        if (options.signal?.aborted || !exhausted) throw error;
        if (evidence) evidenced.add(row.id);
        await blockProviderAccount(
          providerName,
          row.id,
          Date.now() + (delay > 0 ? delay : 5 * 60_000),
          model,
          delay > 0 ? 'retry-after' : 'inferred',
          { quota: evidence === true }
        );
        if (bound.emitted() || error.unsafeToRetry || error.liveTextEmitted || error.emittedToolCall) throw error;
        // Manual policy: the eligible set is the selected account alone.
        if (policy === 'manual') throw markExhausted(error, [row.id]);
        lastError = error;
        switched = true;
        refusalScoped = accountExhaustedForModelOnly(providerName, row.id, model);
        options.onStageChange?.('reconnecting', { message: 'Quota exhausted — switching to the next account' });
      }
    }
    throw markExhausted(lastError || new Error('Provider account attempts exhausted.'));
  };
}

export function createAccountPoolProvider(providerName, create) {
  if (!ACCOUNT_PROVIDERS.includes(providerName) || hasExplicitProviderAuthBinding(providerName)) return create();
  const instances = new Map();
  const account = (id) => {
    if (!instances.has(id)) {
      const instance = withProviderAccount(providerName, id, create);
      const bound = new Proxy(instance, {
        get(target, key) {
          if (key === 'providerAccountId') return id;
          const value = target[key];
          return typeof value === 'function'
            ? (...args) => withProviderAccount(providerName, id, () => value.apply(target, args))
            : value;
        },
      });
      instances.set(id, bound);
    }
    return instances.get(id);
  };
  const active = () => account(readProviderAccountPool(providerName).selectedId || 'default');
  const send = poolSend(providerName, account);

  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'send') return send;
        if (key === 'forAccount') return account;
        if (key === 'providerAccountId') return readProviderAccountPool(providerName).selectedId || 'default';
        return active()[key];
      },
    }
  );
}
