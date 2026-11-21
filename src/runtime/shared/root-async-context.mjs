import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';

// Shared by every copy of this module in the process, so a second copy (a late
// or duplicated import) sees the same root and the same stores.
const STATE_KEY = Symbol.for('mixdog.rootAsyncContext');
globalThis[STATE_KEY] ??= { root: null, stores: new Set() };
const state = globalThis[STATE_KEY];

/** An AsyncLocalStorage the root context leaves: every runtime store is made here. */
export function runtimeAsyncLocalStorage() {
  const store = new AsyncLocalStorage();
  // Weak: per-instance stores (resource-admission controllers) come and go.
  state.stores.add(new WeakRef(store));
  return store;
}

function activeStores() {
  const active = [];
  for (const ref of state.stores) {
    const store = ref.deref();
    if (!store) state.stores.delete(ref);
    else if (store.getStore() !== undefined) active.push(store);
  }
  return active;
}

/** Capture the current context as the root; refused (false) inside a request. */
export function initRootAsyncContext() {
  if (state.root) return true;
  if (activeStores().length > 0) return false;
  state.root = new AsyncResource('MixdogRootContext');
  return true;
}

/** Run `fn` (synchronously) in the root context; returns its result. */
export function runInRootAsyncContext(fn) {
  if (state.root) return state.root.runInAsyncScope(fn);
  return activeStores().reduce((inner, store) => () => store.exit(inner), fn)();
}
