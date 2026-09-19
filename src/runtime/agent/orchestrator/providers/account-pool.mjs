import { createHash } from 'node:crypto';
import {
  ACCOUNT_PROVIDERS,
  readProviderAccountPool,
  chooseProviderAccount,
  changeProviderAccounts,
  blockProviderAccount,
  providerAccountExhausted,
} from '../../../shared/provider-accounts.mjs';
import { withProviderAccount, hasExplicitProviderAuthBinding } from '../../../shared/provider-auth-binding.mjs';
import { retryAfterMsFromError, isExplicitUserAbortError, typedErrorCode } from './retry-classifier.mjs';
import { fetchOAuthUsageSnapshot } from './oauth-usage.mjs';

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
    .filter((row) => providerAccountExhausted(row, now, model))
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

function accountsExhaustedError() {
  const error = new Error('All connected accounts have exhausted their quota. Check account usage and reset times.');
  error.code = 'provider_accounts_exhausted';
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
  const scope = createHash('sha256').update(`${providerName}:${row.id}:${options.sessionId || ''}`).digest('hex');
  if (options.sessionId) opts.sessionId = `account-${scope}`;
  opts.providerState = options.providerState?.providerAccountId === row.id ? options.providerState : undefined;
  const history = messages.map((message) => {
    if (message.providerReplay?.accountId === row.id) return message;
    const { providerReplay, reasoning, thinkingBlocks, ...plain } = message;
    return plain;
  });
  return { opts, history, emitted: () => emitted };
}

// Commit only a successful fallback, without overwriting a newer selection.
function commitFallbackAccount(providerName, pool, row) {
  if (row.id === pool.selectedId) return;
  const current = readProviderAccountPool(providerName);
  if (current.selectedId === pool.selectedId && current.accounts.some((entry) => entry.id === row.id)) {
    changeProviderAccounts(providerName, { selectedId: row.id });
  }
}

// Whether the failed account's quota window is exhausted, plus the server's
// retry delay. Anthropic and other subscriptions may use the same 429 code
// for burst throttling and exhausted subscription windows, so the native
// usage endpoint decides rather than a human-readable message.
async function accountQuotaExhausted(providerName, row, model, error, account) {
  const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
  const delay = retryAfterMsFromError(error);
  let exhausted = isAccountQuotaError(error) || (status === 429 && delay > QUOTA_WINDOW_RETRY_AFTER_MS);
  if (!exhausted && status === 429) {
    await fetchOAuthUsageSnapshot({ provider: providerName, accountId: row.id }, account(row.id), () => {}, {
      force: true,
    });
    exhausted = providerAccountExhausted(
      readProviderAccountPool(providerName).accounts.find((entry) => entry.id === row.id),
      Date.now(),
      model
    );
  }
  return { exhausted, delay };
}

// The pool's send: walks the eligible accounts until one answers, blocking
// the ones whose quota window is exhausted along the way.
function poolSend(providerName, account) {
  return async function send(messages, model, tools, options = {}) {
    const attempted = new Set();
    let lastError;
    let probed = false;
    while (attempted.size < 20) {
      options.signal?.throwIfAborted();
      const pool = readProviderAccountPool(providerName);
      if (!pool.accounts.length) return account('default').send(messages, model, tools, options);
      const row = chooseProviderAccount(pool, attempted, Date.now(), model);
      if (!row) {
        // Once per send: a refusal built on a stale meter must not outlive the
        // meter. Re-measuring can only widen the roster, so it is tried before
        // the failure is reported, never in place of reporting it.
        if (!probed) {
          probed = true;
          if (await probeRefusedAccounts(providerName, pool, model, account)) continue;
        }
        if (lastError) throw lastError;
        throw accountsExhaustedError();
      }
      attempted.add(row.id);
      const bound = boundAccountSend(providerName, row, messages, options);
      try {
        const result = await account(row.id).send(bound.history, model, tools, bound.opts);
        if (result?.providerReplay) result.providerReplay = { ...result.providerReplay, accountId: row.id };
        if (result?.providerState) result.providerState = { ...result.providerState, providerAccountId: row.id };
        commitFallbackAccount(providerName, pool, row);
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const { exhausted, delay } = await accountQuotaExhausted(providerName, row, model, error, account);
        if (options.signal?.aborted || !exhausted) throw error;
        blockProviderAccount(
          providerName,
          row.id,
          Date.now() + (delay > 0 ? delay : 5 * 60_000),
          model,
          delay > 0 ? 'retry-after' : 'inferred'
        );
        if (
          pool.auto === false ||
          bound.emitted() ||
          error.unsafeToRetry ||
          error.liveTextEmitted ||
          error.emittedToolCall
        )
          throw error;
        lastError = error;
        options.onStageChange?.('reconnecting', { message: 'Quota exhausted — switching to the next account' });
      }
    }
    throw lastError || new Error('Provider account attempts exhausted.');
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
