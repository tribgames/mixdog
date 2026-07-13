const AUTH_BINDINGS = Symbol.for('mixdog.providerAuthBindings');

export function boundProviderAuthPath(provider) {
  const bindings = globalThis[AUTH_BINDINGS];
  const value = bindings && typeof bindings === 'object'
    ? bindings[String(provider || '').trim()]
    : null;
  return typeof value === 'string' && value ? value : null;
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
