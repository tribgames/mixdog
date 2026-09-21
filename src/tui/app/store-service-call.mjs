/**
 * store-service-call.mjs — call a store method as a daemon RPC.
 *
 * A daemon-backed store can be missing a method this TUI calls (older session
 * service, protocol allowlist). Rejecting instead of throwing keeps every
 * caller on its normal `.catch` reporting path rather than letting a
 * synchronous TypeError escape a key handler.
 */
export function createStoreServiceCall(store) {
  return (name, ...args) => {
    const target = store?.[name];
    if (typeof target !== 'function') {
      return Promise.reject(new TypeError(`project service method ${name} is unavailable`));
    }
    return Promise.resolve(target.apply(store, args));
  };
}
