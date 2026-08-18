import assert from 'node:assert/strict';
import { test } from 'node:test';

test('session catalog flushes its latest coalesced rows on pagehide', async () => {
  const previousWindow = globalThis.window;
  const values = new Map();
  const listeners = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    setTimeout: () => 7,
    clearTimeout: () => {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  try {
    const cache = await import(`./session-catalog-cache.ts?test=${Date.now()}`);
    cache.scheduleCachedSessionCatalogWrite([{
      id: 'session-1',
      title: 'Latest',
      preview: 'Latest',
      updatedAt: 1,
      messageCount: 1,
      cwd: '',
      classification: 'task',
      projectPath: null,
    }]);
    assert.equal(values.has(cache.SESSION_CATALOG_STORAGE_KEY), false);
    listeners.get('pagehide')();
    assert.equal(
      JSON.parse(values.get(cache.SESSION_CATALOG_STORAGE_KEY)).rows[0].title,
      'Latest',
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
