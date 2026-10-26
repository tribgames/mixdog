import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_EXPANDED_PROJECTS_KEY,
  PROJECT_OPEN_KEY,
  SECTION_OPEN_DEFAULTS,
  closedKeys,
  isOpen,
  normalizeOpenMap,
  readOpenMap,
  readProjectOpenMap,
  toggleOpen,
  withOpen,
  writeOpenMap,
} from './sidebar-open-state.ts';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
}

test('absent entries use the default: open, except Archived', () => {
  assert.equal(isOpen({}, 'c:/work/alpha'), true);
  assert.equal(isOpen({}, 'archived', SECTION_OPEN_DEFAULTS.archived), false);
  for (const id of ['projects', 'favorites', 'recent', 'automations']) {
    assert.equal(isOpen({}, id, SECTION_OPEN_DEFAULTS[id]), true);
  }
  assert.equal(isOpen({ toString: false }, 'constructor'), true);
});

test('toggle stores the resolved value of the explicit choice', () => {
  const closed = toggleOpen({}, 'a');
  assert.deepEqual(closed, { a: false });
  assert.deepEqual(toggleOpen(closed, 'a'), { a: true });
  assert.deepEqual(toggleOpen({}, 'archived', false), { archived: true });
});

test('withOpen keeps the same map when already resolved to the value', () => {
  const map = { a: false };
  assert.equal(withOpen(map, 'b', true), map);
  assert.equal(withOpen(map, 'a', false), map);
  assert.deepEqual(withOpen(map, 'a', true), { a: true });
});

test('maps round-trip through storage and drop junk', () => {
  const storage = memoryStorage();
  writeOpenMap(storage, 'k', { a: false, b: true });
  assert.deepEqual(readOpenMap(storage, 'k'), { a: false, b: true });
  assert.deepEqual(normalizeOpenMap({ a: 1, '': true, c: false }), { c: false });
  assert.deepEqual(normalizeOpenMap([true]), {});
  assert.deepEqual(readOpenMap(memoryStorage({ k: '{bad' }), 'k'), {});
  assert.deepEqual([...closedKeys({ a: false, b: true, c: false })], ['a', 'c']);
});

test('legacy expanded-only set migrates once into the map and is removed', () => {
  const storage = memoryStorage({ [LEGACY_EXPANDED_PROJECTS_KEY]: JSON.stringify(['a', '', 7, 'b']) });
  assert.deepEqual(readProjectOpenMap(storage), { a: true, b: true });
  assert.equal(storage.getItem(LEGACY_EXPANDED_PROJECTS_KEY), null);
  assert.deepEqual(JSON.parse(storage.getItem(PROJECT_OPEN_KEY)), { a: true, b: true });
});

test('migration does not run when the new key exists, and a fresh profile stays empty', () => {
  const storage = memoryStorage({
    [PROJECT_OPEN_KEY]: JSON.stringify({ a: false }),
    [LEGACY_EXPANDED_PROJECTS_KEY]: JSON.stringify(['b']),
  });
  assert.deepEqual(readProjectOpenMap(storage), { a: false });
  assert.notEqual(storage.getItem(LEGACY_EXPANDED_PROJECTS_KEY), null);
  const fresh = memoryStorage();
  assert.deepEqual(readProjectOpenMap(fresh), {});
  assert.equal(fresh.getItem(PROJECT_OPEN_KEY), null);
});
