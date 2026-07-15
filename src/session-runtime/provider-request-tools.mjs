import { AsyncLocalStorage } from 'node:async_hooks';

const requestToolScope = new AsyncLocalStorage();
const NATIVE_PREFIX_COUNT = Symbol('mixdog.providerNativeToolPrefixCount');
let requestToolScopeGeneration = 0;

function normalizedProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

export function providerNativeToolPrefixCount(requestTools, fallback = 0) {
  const raw = Array.isArray(requestTools) && Number.isInteger(requestTools[NATIVE_PREFIX_COUNT])
    ? requestTools[NATIVE_PREFIX_COUNT]
    : fallback;
  return Math.max(0, Math.min(Array.isArray(requestTools) ? requestTools.length : 0, Number(raw) || 0));
}

export function finalizeProviderRequestTools(requestTools, nativePrefixCount = 0) {
  Object.defineProperty(requestTools, NATIVE_PREFIX_COUNT, {
    value: Math.max(0, Math.min(requestTools.length, Number(nativePrefixCount) || 0)),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(requestTools);
}

export function runWithProviderRequestToolsScope(scope, callback) {
  const store = {
    session: scope.session,
    provider: normalizedProvider(scope.provider),
    messages: scope.messages,
    requestTools: scope.requestTools,
    nativePrefixCount: providerNativeToolPrefixCount(
      scope.requestTools,
      scope.nativePrefixCount,
    ),
    generation: ++requestToolScopeGeneration,
    active: true,
  };
  return requestToolScope.run(store, () => {
    let result;
    try {
      result = callback();
    } catch (error) {
      store.active = false;
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => {
        store.active = false;
      });
    }
    store.active = false;
    return result;
  });
}

export function invalidateProviderRequestToolsScope(scope = requestToolScope.getStore()) {
  if (scope && typeof scope === 'object') scope.active = false;
}

export function scopedProviderRequestTools(session, provider, messages) {
  const scope = requestToolScope.getStore();
  return scope
    && scope.active === true
    && scope.session === session
    && scope.provider === normalizedProvider(provider)
    && scope.messages === messages
    ? scope
    : null;
}
