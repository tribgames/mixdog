// A named-database IndexedDB for renderer tests: get / put / delete on object
// stores, values structured-cloned like the real one (so a CryptoKey survives),
// requests that settle on later tasks, and readwrite transactions that run one
// after another, as the real ones do on a store.
const later = (fn) => setTimeout(fn, 0);

export function fakeIndexedDB() {
  const databases = new Map();
  const stats = { opens: 0 };
  let tail = Promise.resolve();

  const transaction = (stores, name) => {
    const store = stores.get(name);
    const tx = {};
    const turn = tail;
    let release = () => {};
    tail = new Promise((resolve) => {
      release = resolve;
    });
    let pending = 0;
    let finished = false;
    const settle = () => {
      if (pending !== 0 || finished) return;
      finished = true;
      tx.oncomplete?.();
      release();
    };
    const run = (apply) => {
      const request = {};
      pending += 1;
      turn.then(() =>
        later(() => {
          request.result = apply();
          request.onsuccess?.();
          pending -= 1;
          later(settle);
        })
      );
      return request;
    };
    tx.objectStore = () => ({
      get: (key) => run(() => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
      put: (value, key) =>
        run(() => {
          store.set(key, structuredClone(value));
          return key;
        }),
      delete: (key) => run(() => void store.delete(key)),
    });
    return tx;
  };

  return {
    databases,
    stats,
    open(name) {
      const request = {};
      stats.opens += 1;
      later(() => {
        const created = !databases.has(name);
        if (created) databases.set(name, new Map());
        const stores = databases.get(name);
        request.result = {
          createObjectStore: (store) => stores.set(store, new Map()),
          transaction: (store) => transaction(stores, store),
          close() {},
        };
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}
