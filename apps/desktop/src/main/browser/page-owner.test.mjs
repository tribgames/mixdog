import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserPageOwner } from './page-owner.ts';

function fixture() {
  const loads = [];
  const owner = createBrowserPageOwner({
    sessions: { registerVisibleGuest() {}, bindVisibleGuest() {}, unregisterVisibleGuest() {} },
    create() {
      const guest = {
        id: 1,
        once() {},
        loadURL: (url) =>
          new Promise((resolve) => {
            loads.push({ url, resolve });
          }),
      };
      return { window: { isDestroyed: () => false, destroy() {} }, guest };
    },
    initialize() {},
  });
  return { owner, loads };
}

test('settled waits for a page still committing its initial document', async () => {
  const { owner, loads } = fixture();
  assert.equal(await Promise.race([owner.settled('s'), 'none']), undefined, 'no page: settles at once');

  const created = owner.ensure('s');
  let settled = false;
  const waiting = owner.settled('s').then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads.length, 1);
  assert.equal(loads[0].url, 'about:blank');
  assert.equal(settled, false, 'a second caller must not drive the page before its first document');

  loads[0].resolve();
  await waiting;
  await created;
  assert.equal(settled, true);
});
