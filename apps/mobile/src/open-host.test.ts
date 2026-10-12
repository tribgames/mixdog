import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RELAY_ORIGIN, emptyHostBook, type HostBook } from './hosts.ts';
import { openHostFlow, type OpenHostDeps } from './open-host.ts';

const URL_ = `${DEFAULT_RELAY_ORIGIN}/d/0123456789abcdef0123456789abcdef/`;

function harness(cancelAt: 'never' | 'save' | 'sync') {
  let current = true;
  let book: HostBook = emptyHostBook();
  const saved: HostBook[] = [];
  const nav: string[] = [];
  const deps: OpenHostDeps = {
    getBook: () => book,
    setBook: (b) => {
      book = b;
    },
    saveBook: async () => {
      saved.push(book);
      await Promise.resolve();
      if (cancelAt === 'save' && saved.length === 1) current = false;
    },
    syncOrigins: async () => {
      await Promise.resolve();
      if (cancelAt === 'sync') current = false;
    },
    isCurrent: () => current,
    onRedeemed: () => {},
    navigate: (u) => nav.push(u),
    now: () => 1,
  };
  return { deps, nav, saved, book: () => book };
}

test('an uncancelled attempt saves the host and navigates', async () => {
  const h = harness('never');
  await openHostFlow(h.deps, URL_, { name: 'PC', ticket: 't' });
  assert.equal(h.nav.length, 1);
  assert.ok(h.nav[0].includes('#pair=t'));
});

for (const point of ['save', 'sync'] as const) {
  test(`Cancel during ${point} neither navigates nor keeps the host`, async () => {
    const h = harness(point);
    await openHostFlow(h.deps, URL_, { name: 'PC', ticket: 't' });
    assert.deepEqual(h.nav, []);
    assert.deepEqual(h.book(), emptyHostBook());
    assert.deepEqual(h.saved.at(-1), emptyHostBook());
  });
}
