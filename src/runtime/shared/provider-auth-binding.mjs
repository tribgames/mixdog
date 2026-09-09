import { AsyncLocalStorage } from 'node:async_hooks';
import { ACCOUNT_PROVIDERS, providerAccountPath, readProviderAccountPool } from './provider-accounts.mjs';

const AUTH_BINDINGS = Symbol.for('mixdog.providerAuthBindings');
const scopedBindings = new AsyncLocalStorage();

export function hasExplicitProviderAuthBinding(provider) {
  return Boolean(globalThis[AUTH_BINDINGS]?.[provider]);
}

export function withProviderAccount(provider, id, run) {
  return scopedBindings.run({
    ...scopedBindings.getStore(),
    [provider]: { id, path: providerAccountPath(provider, id) },
  }, run);
}

export function currentProviderAccountId(provider) {
  const scoped = scopedBindings.getStore()?.[provider];
  if (scoped) return scoped.id;
  // Explicit host bindings (benchmarks, isolated runtimes) take precedence.
  if (globalThis[AUTH_BINDINGS]?.[provider]) return 'default';
  if (!ACCOUNT_PROVIDERS.includes(provider)) return 'default';
  return readProviderAccountPool(provider).selectedId || 'default';
}

export function boundProviderAuthPath(provider) {
  const scoped = scopedBindings.getStore()?.[provider];
  if (scoped) return scoped.path || globalThis[AUTH_BINDINGS]?.[provider] || null;
  const bindings = globalThis[AUTH_BINDINGS];
  const value = bindings && typeof bindings === 'object'
    ? bindings[String(provider || '').trim()]
    : null;
  if (typeof value === 'string' && value) return value;
  if (!ACCOUNT_PROVIDERS.includes(provider)) return null;
  return providerAccountPath(provider, currentProviderAccountId(provider));
}

export function replaceProviderAuthBindings(next = {}) {
  const previous = globalThis[AUTH_BINDINGS];
  globalThis[AUTH_BINDINGS] = Object.freeze({ ...next });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous === undefined) delete globalThis[AUTH_BINDINGS];
    else globalThis[AUTH_BINDINGS] = previous;
  };
}
