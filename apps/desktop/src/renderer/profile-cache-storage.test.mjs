import assert from 'node:assert/strict';
import test from 'node:test';

import { profileCacheStorage } from './profile-cache-storage.ts';

/** A window whose main process keeps `files`, beside a Local Storage holding `local`. */
function withWindow(t, { files, local = {} }) {
  const stored = new Map(Object.entries(local));
  const kept = files && new Map(Object.entries(files));
  const previous = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      removeItem: (key) => void stored.delete(key),
    },
    ...(kept
      ? {
          mixdogDesktop: {
            readRendererCache: (name) => kept.get(name) ?? null,
            writeRendererCache: (name, text) => void kept.set(name, text),
          },
        }
      : {}),
  };
  t.after(() => {
    globalThis.window = previous;
  });
  return { stored, kept };
}

test('a cache is read from and written to its profile file, whatever key it is asked under', (t) => {
  const { stored, kept } = withWindow(t, { files: { 'session-catalog': 'filed' }, local: { old: 'left alone' } });
  const storage = profileCacheStorage('session-catalog');
  assert.equal(storage.getItem('old'), 'filed');
  storage.setItem('old', 'next');
  assert.deepEqual([...kept], [['session-catalog', 'next']]);
  assert.deepEqual([...stored], [['old', 'left alone']], 'a filed cache does not look at Local Storage');
});

test('a value an earlier version left in Local Storage moves to the file the first time it is read', (t) => {
  const { stored, kept } = withWindow(t, { files: {}, local: { 'mixdog.cache.v1': 'earlier', other: 'x' } });
  const storage = profileCacheStorage('transcript-row-heights-v2');
  assert.equal(storage.getItem('mixdog.cache.v1'), 'earlier');
  assert.deepEqual([...kept], [['transcript-row-heights-v2', 'earlier']]);
  assert.deepEqual([...stored], [['other', 'x']], 'it no longer takes room in Local Storage');
  assert.equal(profileCacheStorage('session-catalog').getItem('absent'), null);
});

test('a surface with no main process keeps its own storage', (t) => {
  withWindow(t, { files: null });
  assert.equal(profileCacheStorage('session-catalog'), null);
});
