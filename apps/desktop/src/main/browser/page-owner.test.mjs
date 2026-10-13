import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserPageOwner } from './page-owner.ts';

function fixture() {
  const loads = [];
  const guests = [];
  const owner = createBrowserPageOwner({
    sessions: { registerVisibleGuest() {}, bindVisibleGuest() {}, unregisterVisibleGuest() {} },
    create() {
      const handlers = {};
      const guest = {
        id: guests.length + 1,
        url: 'about:blank',
        getURL: () => guest.url,
        on: (event, handler) => {
          handlers[event] = handler;
        },
        once: (event, handler) => {
          handlers[event] = handler;
        },
        loadURL: (url) =>
          new Promise((resolve) => {
            loads.push({ url, resolve });
          }),
      };
      guests.push({
        guest,
        destroy: () => handlers.destroyed?.(),
        navigate: (url) => {
          guest.url = url;
          handlers['did-navigate']?.();
        },
      });
      return { window: { isDestroyed: () => false, destroy() {} }, guest };
    },
    initialize() {},
  });
  return { owner, loads, guests };
}

test('a replacement stops being one when the user claims it or navigates it', async () => {
  const { owner, loads, guests } = fixture();
  const first = owner.ensure('s');
  loads[0].resolve();
  await first;
  guests[0].destroy();
  const second = owner.ensure('s');
  loads[1].resolve();
  await second;
  assert.equal(owner.replacement('s'), guests[1].guest);
  owner.claim('s', guests[1].guest);
  assert.equal(owner.replacement('s'), null, 'reused by "+" or selected');

  guests[1].destroy();
  const third = owner.ensure('s');
  loads[2].resolve();
  await third;
  assert.equal(owner.replacement('s'), guests[2].guest);
  guests[2].navigate('about:blank');
  assert.equal(owner.replacement('s'), guests[2].guest, 'a blank commit is still the stand-in');
  guests[2].navigate('https://x.test/');
  assert.equal(owner.replacement('s'), null);
});

test('only a page made after the previous one went away is a replacement', async () => {
  const { owner, loads, guests } = fixture();
  const first = owner.ensure('s');
  loads[0].resolve();
  await first;
  assert.equal(owner.replacement('s'), null, 'the first page of a session is not a replacement');

  guests[0].destroy();
  const second = owner.ensure('s');
  loads[1].resolve();
  await second;
  assert.equal(owner.replacement('s'), guests[1].guest);

  owner.release('s');
  assert.equal(owner.replacement('s'), null);
  const third = owner.ensure('s');
  loads[2].resolve();
  await third;
  assert.equal(owner.replacement('s'), null, 'a released session starts afresh');
});

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
