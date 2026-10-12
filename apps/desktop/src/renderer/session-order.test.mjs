import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySessionOrder,
  commitVisibleOrder,
  listOrderId,
  normalizeCustomOrders,
  normalizeOrderPrefs,
  splitListOrderId,
  syncCustomOrders,
} from './session-order.ts';

const rows = ['d', 'c', 'b', 'a'].map((id) => ({ id }));
const ids = (list) => list.map((row) => row.id);

test('defaults: sessions by activity, favorites custom', () => {
  assert.deepEqual(normalizeOrderPrefs(null), { sessions: 'recent', favorites: 'custom' });
  assert.deepEqual(normalizeOrderPrefs({ sessions: 'custom', favorites: 'bogus' }), {
    sessions: 'custom',
    favorites: 'custom',
  });
});

test('recent mode keeps activity order and ignores stored order', () => {
  assert.deepEqual(ids(applySessionOrder(rows, 'recent', ['a', 'b'])), ['d', 'c', 'b', 'a']);
});

test('custom mode follows stored order, unknown sessions go on top, stale ids drop', () => {
  assert.deepEqual(ids(applySessionOrder(rows, 'custom', ['a', 'gone', 'c'])), ['d', 'b', 'a', 'c']);
  assert.deepEqual(ids(applySessionOrder(rows, 'custom')), ['d', 'c', 'b', 'a']);
});

test('syncCustomOrders prepends new ids and keeps identity when unchanged', () => {
  const orders = { recent: ['a', 'b'] };
  const next = syncCustomOrders(orders, [{ key: 'recent', ids: ['c', 'a', 'b'] }]);
  assert.deepEqual(next.recent, ['c', 'a', 'b']);
  assert.equal(syncCustomOrders(next, [{ key: 'recent', ids: ['a', 'c'] }]), next);
  assert.deepEqual(syncCustomOrders({}, [{ key: 'favorites', ids: ['x', 'y'] }]).favorites, ['x', 'y']);
});

test('commitVisibleOrder keeps paged-out rows below the reordered head', () => {
  assert.deepEqual(commitVisibleOrder(['a', 'b', 'c', 'd'], 3, ['c', 'a', 'b']), ['c', 'a', 'b', 'd']);
});

test('list-scoped ids round-trip and normalizeCustomOrders drops junk', () => {
  assert.deepEqual(splitListOrderId(listOrderId('project:C:/x', 's1')), { listKey: 'project:C:/x', sessionId: 's1' });
  assert.deepEqual(normalizeCustomOrders({ a: ['x', 1, ''], b: 'no' }), { a: ['x'] });
  assert.deepEqual(normalizeCustomOrders([]), {});
});
