import { runtimeAsyncLocalStorage } from '../../../shared/root-async-context.mjs';

const requestToolScope = runtimeAsyncLocalStorage();
const NATIVE_PREFIX_COUNT = Symbol('mixdog.providerNativeToolPrefixCount');
const finalizedProviderRequestTools = new WeakSet();
let requestToolScopeGeneration = 0;

function normalizedProvider(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase();
}

export function providerNativeToolPrefixCount(requestTools, fallback = 0) {
  const raw =
    Array.isArray(requestTools) && Number.isInteger(requestTools[NATIVE_PREFIX_COUNT])
      ? requestTools[NATIVE_PREFIX_COUNT]
      : fallback;
  return Math.max(0, Math.min(Array.isArray(requestTools) ? requestTools.length : 0, Number(raw) || 0));
}

export function isFinalizedProviderRequestTools(requestTools) {
  return Array.isArray(requestTools) && finalizedProviderRequestTools.has(requestTools);
}

export function finalizeProviderRequestTools(requestTools, nativePrefixCount = 0) {
  Object.defineProperty(requestTools, NATIVE_PREFIX_COUNT, {
    value: Math.max(0, Math.min(requestTools.length, Number(nativePrefixCount) || 0)),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  finalizedProviderRequestTools.add(requestTools);
  return Object.freeze(requestTools);
}

export function runWithProviderRequestToolsScope(scope, callback) {
  const store = {
    session: scope.session,
    provider: normalizedProvider(scope.provider),
    messages: scope.messages,
    requestTools: scope.requestTools,
    nativePrefixCount: providerNativeToolPrefixCount(scope.requestTools, scope.nativePrefixCount),
    generation: ++requestToolScopeGeneration,
    active: true,
  };
  return requestToolScope.run(store, () => {
    let result;
    try {
      result = callback();
    } catch (error) {
      deactivate(store);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => deactivate(store));
    }
    deactivate(store);
    return result;
  });
}

// An inactive scope is never read again, but any handle, timer or listener
// created under it keeps the store: drop what pins the session.
function deactivate(store) {
  store.active = false;
  store.session = null;
  store.messages = null;
  store.requestTools = null;
}

export function invalidateProviderRequestToolsScope(scope = requestToolScope.getStore()) {
  if (scope && typeof scope === 'object') deactivate(scope);
}

export function scopedProviderRequestTools(session, provider, messages) {
  const scope = requestToolScope.getStore();
  return scope &&
    scope.active === true &&
    scope.session === session &&
    scope.provider === normalizedProvider(provider) &&
    scope.messages === messages
    ? scope
    : null;
}
