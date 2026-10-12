import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBrowserPageIdentityStore, pageIdentityKey, trackBrowserPageIdentity } from './page-identity.ts';
import { fetchDeclaredFavicon, looksLikeSvg } from './favicon-fetch.ts';

function fakeGuest(url) {
  return Object.assign(new EventEmitter(), {
    url,
    getURL() {
      return this.url;
    },
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
  });
}

const trackFavicons = (pageUrl) => {
  const store = createBrowserPageIdentityStore();
  const guest = fakeGuest(pageUrl);
  const fetched = [];
  trackBrowserPageIdentity(guest, store, {
    favicon: async (url, page) => {
      fetched.push([url, page]);
      return 'data:icon';
    },
    thumbnail: async () => null,
  });
  return { store, guest, fetched };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the icon a page declares is read on any origin, with the page it came from', async () => {
  const { store, guest, fetched } = trackFavicons('https://github.com/mixdog/mixdog');
  guest.emit('page-favicon-updated', {}, ['https://github.githubassets.com/favicons/favicon.svg']);
  await settle();
  assert.deepEqual(fetched, [
    ['https://github.githubassets.com/favicons/favicon.svg', 'https://github.com/mixdog/mixdog'],
  ]);
  assert.equal(store.lookup('https://github.com/other').favicon, 'data:icon');
});

test('nothing but a declared http(s) icon is ever read: no guessed /favicon.ico, no other schemes', async () => {
  const { store, guest, fetched } = trackFavicons('https://a.test/page');
  // Navigation, title and load events never invent an icon address.
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://a.test/page' });
  guest.emit('page-title-updated', {}, 'A');
  guest.emit('did-stop-loading');
  guest.emit('page-favicon-updated', {}, [
    'chrome://favicon/x',
    'file:///C:/icon.png',
    'ftp://a.test/f.ico',
    'javascript:1',
  ]);
  guest.emit('page-favicon-updated', {}, []);
  await settle();
  assert.deepEqual(fetched, []);
  assert.equal(store.lookup('https://a.test/page').favicon, undefined);
});

const pngResponse = (body, init = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'image/png', ...init.headers }, ...init });

test('a declared icon loads like a page subresource; redirects stay http(s) and at most three hops', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url, init.referrer, init.credentials, init.redirect]);
    if (url === 'https://github.githubassets.com/favicon.ico') {
      return new Response(null, { status: 302, headers: { location: 'https://cdn.other.test/fav.png' } });
    }
    if (url === 'https://cdn.other.test/fav.png') return pngResponse(new Uint8Array([1, 2, 3]));
    if (url === 'https://a.test/to-file.ico') {
      return new Response(null, { status: 301, headers: { location: 'file:///C:/secret.png' } });
    }
    if (url === 'https://a.test/to-data.ico') {
      return new Response(null, { status: 302, headers: { location: 'data:image/png;base64,AAAA' } });
    }
    const loop = /^https:\/\/a\.test\/loop(\d+)$/.exec(url);
    if (loop) {
      return new Response(null, { status: 302, headers: { location: `/loop${Number(loop[1]) + 1}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const page = 'https://github.com/page';
  const ok = await fetchDeclaredFavicon(fetch, 'https://github.githubassets.com/favicon.ico', page);
  assert.deepEqual([...ok.bytes], [1, 2, 3]);
  assert.equal(ok.type, 'image/png');
  assert.deepEqual(calls, [
    ['https://github.githubassets.com/favicon.ico', page, 'include', 'manual'],
    ['https://cdn.other.test/fav.png', page, 'include', 'manual'],
  ]);
  calls.length = 0;
  for (const url of ['file:///C:/icon.png', 'chrome://favicon/x', 'ftp://a.test/f.ico']) {
    assert.equal(await fetchDeclaredFavicon(fetch, url, page), null);
  }
  assert.equal(await fetchDeclaredFavicon(fetch, 'https://a.test/f.ico', 'file:///C:/page.html'), null);
  assert.deepEqual(calls, []);
  assert.equal(await fetchDeclaredFavicon(fetch, 'https://a.test/to-file.ico', page), null);
  assert.equal(await fetchDeclaredFavicon(fetch, 'https://a.test/to-data.ico', page), null);
  assert.deepEqual(
    calls.map(([url]) => url),
    ['https://a.test/to-file.ico', 'https://a.test/to-data.ico']
  );
  calls.length = 0;
  assert.equal(await fetchDeclaredFavicon(fetch, 'https://a.test/loop0', page), null);
  assert.deepEqual(
    calls.map(([url]) => url),
    ['https://a.test/loop0', 'https://a.test/loop1', 'https://a.test/loop2', 'https://a.test/loop3']
  );
});

test('an oversized favicon body is aborted mid-stream, and a stalled one times out', async () => {
  let pulls = 0;
  let cancelled = false;
  let signal;
  const endless = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const big = await fetchDeclaredFavicon(
    async (_url, init) => {
      signal = init.signal;
      return pngResponse(endless);
    },
    'https://a.test/favicon.ico',
    'https://a.test/'
  );
  assert.equal(big, null);
  assert.ok(signal.aborted);
  assert.ok(cancelled);
  assert.ok(pulls <= 10, `read ${pulls} chunks past a 128 KB cap`);

  const declared = await fetchDeclaredFavicon(
    async () => pngResponse(new Uint8Array(1), { headers: { 'content-length': String(1024 * 1024) } }),
    'https://a.test/favicon.ico',
    'https://a.test/'
  );
  assert.equal(declared, null);

  const stalled = await fetchDeclaredFavicon(
    async (_url, init) =>
      pngResponse(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
          },
        })
      ),
    'https://a.test/favicon.ico',
    'https://a.test/',
    { timeoutMs: 20 }
  );
  assert.equal(stalled, null);
});

test('a rejected favicon response releases its request at once', async () => {
  let signal;
  const missing = await fetchDeclaredFavicon(
    async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ pull() {} }), { status: 404 });
    },
    'https://a.test/favicon.ico',
    'https://a.test/'
  );
  assert.equal(missing, null);
  assert.ok(signal.aborted);
});

test('only real SVG markup passes as an SVG icon', () => {
  assert.ok(looksLikeSvg('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'));
  assert.ok(!looksLikeSvg('<!doctype html><html><body>Not found</body></html>'));
  assert.ok(!looksLikeSvg('\u0089PNG'));
});

test('the store answers a page by its address and any page of a visited site by its icon', () => {
  const changed = [];
  const store = createBrowserPageIdentityStore({ onChange: (origin) => changed.push(origin) });
  assert.equal(pageIdentityKey('file:///C:/x.html'), null);
  assert.equal(pageIdentityKey('https://a.test/p#top'), 'https://a.test/p');
  store.update('https://a.test/p#top', { title: 'Page', favicon: 'data:icon', thumbnail: 'data:shot' });
  assert.deepEqual(store.lookup('https://a.test/p/'), {
    url: 'https://a.test/p/',
    title: 'Page',
    favicon: 'data:icon',
    thumbnail: 'data:shot',
  });
  assert.deepEqual(store.lookup('https://a.test/other'), { url: 'https://a.test/other', favicon: 'data:icon' });
  assert.equal(store.lookup('https://b.test/'), null);
  assert.equal(store.lookup('about:blank'), null);
  assert.deepEqual(changed, ['https://a.test']);
});

test('a guest files its title, icon and screenshot under the address asked for and the one loaded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createBrowserPageIdentityStore();
  const guest = fakeGuest('https://a.test/final');
  const fetched = [];
  trackBrowserPageIdentity(guest, store, {
    favicon: async (url) => {
      fetched.push(url);
      return 'data:icon';
    },
    thumbnail: async () => 'data:shot',
  });
  guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://a.test/start' });
  guest.emit('page-title-updated', {}, '  Final  ');
  guest.emit('page-favicon-updated', {}, ['chrome://x', 'https://cdn.other.test/a.ico', 'https://a.test/favicon.ico']);
  guest.emit('did-stop-loading');
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  // The first loadable address the page declared, whatever its origin.
  assert.deepEqual(fetched, ['https://cdn.other.test/a.ico']);
  for (const url of ['https://a.test/final', 'https://a.test/start']) {
    assert.deepEqual(store.lookup(url), { url, title: 'Final', favicon: 'data:icon', thumbnail: 'data:shot' });
  }
});
