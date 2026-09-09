import { createHash } from 'node:crypto';
import {
  ACCOUNT_PROVIDERS, readProviderAccountPool, chooseProviderAccount,
  changeProviderAccounts, blockProviderAccount,
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
  return ['insufficient_quota', 'quota_exceeded', 'usage_limit_reached', 'usage_not_included']
    .includes(String(typedErrorCode(error) || error?.error?.type || '').toLowerCase());
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

  async function send(messages, model, tools, options = {}) {
    const attempted = new Set();
    let lastError;
    while (attempted.size < 20) {
      options.signal?.throwIfAborted();
      const pool = readProviderAccountPool(providerName);
      if (!pool.accounts.length) return account('default').send(messages, model, tools, options);
      const row = chooseProviderAccount(pool, attempted);
      if (!row) {
        if (lastError) throw lastError;
        const error = new Error('All connected accounts have exhausted their quota. Check account usage and reset times.');
        error.code = 'provider_accounts_exhausted';
        throw error;
      }
      attempted.add(row.id);
      if (row.id !== pool.selectedId) changeProviderAccounts(providerName, { selectedId: row.id });
      let emitted = false;
      const opts = { ...options };
      // Observe output even when the caller does not subscribe to that callback.
      for (const key of ['onStreamDelta', 'onTextDelta', 'onToolCall', 'onThinkingDelta']) {
        opts[key] = (...args) => {
          emitted = true;
          return options[key]?.(...args);
        };
      }
      // Keep account-bound connection/delta state apart without changing the
      // visible Mixdog session. No stale server state crosses an account switch.
      const scope = createHash('sha256').update(`${providerName}:${row.id}:${options.sessionId || ''}`).digest('hex');
      if (options.sessionId) opts.sessionId = `account-${scope}`;
      opts.providerState = options.providerState?.providerAccountId === row.id ? options.providerState : undefined;
      const history = messages.map((message) => {
        if (message.providerReplay?.accountId === row.id) return message;
        const { providerReplay, reasoning, thinkingBlocks, ...plain } = message;
        return plain;
      });
      try {
        const result = await account(row.id).send(history, model, tools, opts);
        if (result?.providerReplay) result.providerReplay = { ...result.providerReplay, accountId: row.id };
        if (result?.providerState) result.providerState = { ...result.providerState, providerAccountId: row.id };
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        let exhausted = isAccountQuotaError(error);
        const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);
        // Anthropic and other subscriptions may use the same 429 code for
        // burst throttling and exhausted subscription windows. Ask the native
        // usage endpoint rather than interpreting a human-readable message.
        if (!exhausted && status === 429) {
          await fetchOAuthUsageSnapshot({ provider: providerName, accountId: row.id }, account(row.id), () => {}, { force: true });
          exhausted = providerAccountExhausted(readProviderAccountPool(providerName).accounts.find((entry) => entry.id === row.id));
        }
        if (options.signal?.aborted || !exhausted) throw error;
        const delay = retryAfterMsFromError(error);
        blockProviderAccount(providerName, row.id, Date.now() + (delay > 0 ? delay : 5 * 60_000));
        if (pool.auto === false || emitted || error.unsafeToRetry || error.liveTextEmitted || error.emittedToolCall) throw error;
        lastError = error;
        options.onStageChange?.('reconnecting', { message: 'Quota exhausted — switching to the next account' });
      }
    }
    throw lastError || new Error('Provider account attempts exhausted.');
  }

  return new Proxy({}, {
    get(_target, key) {
      if (key === 'send') return send;
      if (key === 'forAccount') return account;
      if (key === 'providerAccountId') return readProviderAccountPool(providerName).selectedId || 'default';
      return active()[key];
    },
  });
}
