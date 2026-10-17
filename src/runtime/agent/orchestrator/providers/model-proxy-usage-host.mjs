// Desktop-owned, read-only measurements and serving-account proof. Only the
// shared wire sanitizer's opaque scopes and bounded quota fields leave here.
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { ACCOUNT_PROVIDERS } from '../../../shared/provider-accounts.mjs';
import { providerUsageAccounts } from '../../../../session-runtime/services/provider-admin.mjs';
import { normalizeAccountIdentity, sameAccountIdentity } from './lib/oauth-token-utils.mjs';
import { measureOAuthUsageSnapshot } from './oauth-usage.mjs';
import { sanitizeModelProxyUsageReply } from './model-proxy-usage-wire.mjs';

const namespaces = new Map();
function installationScope() {
  const path = join(resolvePluginData(), 'model-proxy-usage-owner.json');
  if (!namespaces.has(path)) {
    const value = updateJsonAtomicSync(
      path,
      (old) => ({ id: typeof old?.id === 'string' && old.id ? old.id : randomUUID() }),
      { mode: 0o600, secret: true }
    );
    namespaces.set(path, value.id);
  }
  return namespaces.get(path);
}

const DIRECT_USAGE = new Set(['openai-oauth', 'anthropic-oauth', 'grok-oauth']);
const ADAPTER_USAGE = new Set(['cursor-oauth', 'antigravity-oauth', 'muse-code-oauth', 'command-code-oauth']);

// Only normalized identity already held by an adapter can prove a send. Other
// adapters, and the implicit-default pool path without a routing stamp, remain
// unattributed rather than guessing from the selected/default roster account.
function servingIdentity(instance) {
  return instance?.credentials?.identity || instance?.tokens?.identity || null;
}

function measurementIdentityMatches(expected, identity) {
  const known = normalizeAccountIdentity(identity);
  return !known || sameAccountIdentity(expected, known);
}

// Auth-store formats used by the corresponding describe() helpers. These are
// full provider identities, not the display accountId hints in public rows.
function measurementIdentity(provider, auth) {
  if (auth?.identity) return auth.identity;
  if (provider === 'grok-oauth' || provider === 'antigravity-oauth') {
    return { id: auth?.user_id, email: auth?.email };
  }
  if (provider === 'muse-code-oauth') return { id: auth?.accountId, email: auth?.email };
  if (provider === 'command-code-oauth') return { id: auth?.userId };
  return null;
}

function measurementAdapterIdentity(provider, instance) {
  return measurementIdentity(provider, instance?.credentials || instance?.tokens);
}

export function createModelProxyUsage({
  accounts = providerUsageAccounts,
  owner = installationScope,
  fetchUsage = measureOAuthUsageSnapshot,
  now = Date.now,
} = {}) {
  const readings = new Map();
  function roster(provider) {
    const rows = new Map();
    if (!ACCOUNT_PROVIDERS.includes(provider)) return { selectedId: null, rows };
    const pool = accounts(provider);
    for (const row of pool.accounts.slice(0, 20)) {
      if (!row.authenticated || !row.identity || (!row.identity.id && !row.identity.email)) continue;
      const lifetime = [owner(), provider, row.id, row.identity];
      if (row.id === 'default' && row.incarnation) lifetime.push(row.incarnation);
      const scope = `proxy-${createHash('sha256')
        .update(JSON.stringify(lifetime))
        .digest('hex')}`;
      rows.set(row.id, { ...row, scope });
    }
    return { selectedId: pool.selectedId, rows };
  }
  const envelope = (provider, status, current, snapshot) => {
    const account = current.rows.get(current.selectedId)?.scope;
    return sanitizeModelProxyUsageReply(provider, {
      status,
      accounts: [...current.rows.values()].map((row) => row.scope),
      ...(account ? { account } : {}),
      ...(snapshot ? { snapshot: { ...snapshot, provider, accountId: account, source: 'desktop-oauth' } } : {}),
    });
  };
  const same = (before, after) =>
    before?.scope === after?.scope && before?.version != null && before.version === after?.version;

  return {
    // Called just before an actual roster attempt, never retrospectively for a
    // failed/partial attempt. File revisions conservatively retire even a
    // same-identity refresh, including an intervening A -> B -> A replacement.
    captureAccount(provider, id, instance) {
      let before;
      try {
        before = roster(provider).rows.get(id);
        const identity = servingIdentity(instance);
        if (!before || before.version == null || !sameAccountIdentity(before.identity, identity)) return undefined;
      } catch {
        return undefined;
      }
      return () => {
        try {
          const after = roster(provider).rows.get(id);
          return same(before, after) && sameAccountIdentity(before.identity, servingIdentity(instance))
            ? before.scope
            : undefined;
        } catch {
          return undefined;
        }
      };
    },
    async snapshot(provider, instance, { force = false } = {}) {
      let initial;
      try {
        initial = roster(provider);
      } catch {
        return { status: 'unavailable', accounts: [] };
      }
      if (!DIRECT_USAGE.has(provider) && !ADAPTER_USAGE.has(provider)) {
        return envelope(provider, 'unsupported', initial);
      }
      const selected = initial.rows.get(initial.selectedId);
      if (!selected || !instance) return envelope(provider, 'unavailable', initial);
      let snapshot = null;
      let status = 'unavailable';
      let bound;
      try {
        bound = instance.forAccount
          ? instance.forAccount(initial.selectedId)
          : initial.selectedId === 'default' || instance.providerAccountId === initial.selectedId
            ? instance
            : null;
        if (!bound) return envelope(provider, 'unavailable', initial);
        if (!DIRECT_USAGE.has(provider) && typeof bound.getUsageSnapshot !== 'function') {
          return envelope(provider, 'unsupported', initial);
        }
        if (!measurementIdentityMatches(selected.identity, measurementAdapterIdentity(provider, bound))) {
          readings.delete(selected.scope);
          throw new Error('The measurement adapter does not match its account.');
        }
        // Direct meters consume ensureAuth's return value, which can differ
        // from both disk and the adapter's final state. Check that exact auth
        // without mutating a shared adapter or rejecting a fresh lazy one.
        const measurement =
          DIRECT_USAGE.has(provider) && typeof bound.ensureAuth === 'function'
            ? {
                async ensureAuth(...args) {
                  const auth = await bound.ensureAuth(...args);
                  if (!measurementIdentityMatches(selected.identity, measurementIdentity(provider, auth))) {
                    throw new Error('The measurement credential does not match its account.');
                  }
                  return auth;
                },
              }
            : bound;
        let cached = readings.get(selected.scope);
        if (
          !cached ||
          (!cached.pending && (force || cached.version !== selected.version || now() - cached.at > 60_000))
        ) {
          const entry = { pending: true, at: 0, version: selected.version, promise: null };
          entry.promise = Promise.resolve()
            .then(() => fetchUsage({ provider, accountId: initial.selectedId }, measurement))
            .then(
              (value) => {
                entry.pending = false;
                entry.at = value?.cachedAt || 0;
                if (!value && readings.get(selected.scope) === entry) readings.delete(selected.scope);
                return value;
              },
              () => {
                if (readings.get(selected.scope) === entry) readings.delete(selected.scope);
                return null;
              }
            );
          readings.set(selected.scope, entry);
          // Bound replacements in a desktop process that can stay open for months.
          if (readings.size > 160) readings.delete(readings.keys().next().value);
          cached = entry;
        }
        const value = await cached.promise;
        snapshot = cached.version === selected.version ? value : null;
        status = snapshot ? 'ready' : 'unavailable';
      } catch {
        // Quota failure does not revoke independently established history ownership.
      }
      let current;
      try {
        current = roster(provider);
      } catch {
        return { status: 'unavailable', accounts: [] };
      }
      if (
        initial.selectedId !== current.selectedId ||
        !same(selected, current.rows.get(initial.selectedId)) ||
        !measurementIdentityMatches(selected.identity, measurementAdapterIdentity(provider, bound))
      ) {
        readings.delete(selected.scope);
        return envelope(provider, 'unavailable', current);
      }
      return envelope(provider, status, current, snapshot);
    },
  };
}
