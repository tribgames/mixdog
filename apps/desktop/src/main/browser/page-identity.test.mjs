import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrowserPageIdentityStore, pageIdentityKey, trackBrowserPageIdentity } from './page-identity.ts';
import { createBrowserPageIdentityFile } from './page-identity-file.ts';
import { createBrowserPagePreviews, fetchPagePreviewMarkup, parsePreviewMarkup } from './page-preview.ts';
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

test('a saved snapshot restores pages, site icons and screenshots under live records, skipping junk', () => {
  const saved = createBrowserPageIdentityStore();
  saved.update('https://a.test/p', {
    title: 'Saved',
    favicon: 'data:image/png;base64,AA',
    thumbnail: 'data:image/jpeg;base64,S',
  });
  saved.update('https://b.test/q', { title: 'Old title' });
  const snapshot = JSON.parse(JSON.stringify(saved.snapshot()));
  snapshot.pages.push(['file:///C:/x', { title: 'x' }], ['https://c.test/x', { favicon: 'javascript:1' }], 'junk');
  snapshot.thumbnails.push(['https://c.test/y', 'not-an-image']);

  const changed = [];
  const store = createBrowserPageIdentityStore({ onChange: (origin) => changed.push(origin) });
  store.update('https://b.test/q', { title: 'Live title' });
  changed.length = 0;
  // b.test's page was recorded live, so the saved one does not replace it.
  assert.deepEqual(store.restore(snapshot), ['https://a.test']);
  assert.deepEqual(changed, []);
  assert.deepEqual(store.lookup('https://a.test/p'), {
    url: 'https://a.test/p',
    title: 'Saved',
    favicon: 'data:image/png;base64,AA',
    thumbnail: 'data:image/jpeg;base64,S',
  });
  assert.equal(store.lookup('https://a.test/other').favicon, 'data:image/png;base64,AA');
  assert.equal(store.lookup('https://b.test/q').title, 'Live title');
  assert.equal(store.lookup('https://c.test/x'), null);
  assert.equal(store.lookup('https://c.test/y'), null);
  assert.deepEqual(store.restore(null), []);
});

test('the identity file writes a sealed snapshot after changes and restores it on the next start', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'page-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seal = {
    encrypt: async (text) => Buffer.from(`sealed:${text}`),
    decrypt: async (data) => {
      const text = data.toString();
      return text.startsWith('sealed:') ? text.slice(7) : null;
    },
  };
  const first = createBrowserPageIdentityStore();
  const firstFile = createBrowserPageIdentityFile({ store: first, directory, saveDelayMs: 60_000, ...seal });
  assert.deepEqual(await firstFile.loaded, []);
  await firstFile.flush();
  await assert.rejects(readFile(firstFile.file), 'nothing changed, nothing written');
  first.update('https://a.test/p', { title: 'Kept', thumbnail: 'data:image/jpeg;base64,S' });
  firstFile.schedule();
  await firstFile.flush();
  assert.match((await readFile(firstFile.file)).toString(), /^sealed:/);

  const second = createBrowserPageIdentityStore();
  const secondFile = createBrowserPageIdentityFile({ store: second, directory, ...seal });
  assert.deepEqual(await secondFile.loaded, ['https://a.test']);
  assert.deepEqual(second.lookup('https://a.test/p'), {
    url: 'https://a.test/p',
    title: 'Kept',
    thumbnail: 'data:image/jpeg;base64,S',
  });

  // An unreadable file is discarded, not trusted.
  await writeFile(secondFile.file, 'garbage');
  const third = createBrowserPageIdentityFile({ store: createBrowserPageIdentityStore(), directory, ...seal });
  assert.deepEqual(await third.loaded, []);
  await assert.rejects(readFile(third.file));
});

test('a page head yields its title, preview image and icon, resolved against the address that answered', () => {
  const html = `<html><head>
    <title> Repo &amp; things </title>
    <meta content="/social.png" property="og:image">
    <meta name="twitter:image" content="https://cdn.test/tw.png">
    <link rel="apple-touch-icon" href="/apple.png">
    <link rel="shortcut icon" href='/favicon.ico'>
  </head>`;
  assert.deepEqual(parsePreviewMarkup(html, 'https://a.test/x/y'), {
    title: 'Repo & things',
    image: 'https://a.test/social.png',
    icon: 'https://a.test/favicon.ico',
  });
  assert.deepEqual(
    parsePreviewMarkup(
      '<meta property="og:title" content="OG"><meta property="og:image" content="javascript:1">',
      'https://a.test/'
    ),
    { title: 'OG' }
  );
});

test('a preview reads only the head of an HTML page and gives up on anything else', async () => {
  let pulls = 0;
  let signal;
  const page = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(
        new TextEncoder().encode(pulls === 1 ? '<head><title>T</title></head>' : 'x'.repeat(16 * 1024))
      );
    },
  });
  const markup = await fetchPagePreviewMarkup(async (_url, init) => {
    signal = init.signal;
    assert.equal(init.cache, 'force-cache');
    assert.equal(init.credentials, 'include');
    return Object.defineProperty(new Response(page, { headers: { 'content-type': 'text/html' } }), 'url', {
      value: 'https://a.test/final',
    });
  }, 'https://a.test/start');
  assert.deepEqual(markup, { url: 'https://a.test/final', title: 'T' });
  // The stream may read one chunk ahead; the body past the head is never consumed.
  assert.ok(pulls <= 2, `pulled ${pulls} chunks past the head`);
  assert.ok(signal.aborted);

  const json = await fetchPagePreviewMarkup(
    async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    'https://a.test/'
  );
  assert.equal(json, null);
  assert.equal(await fetchPagePreviewMarkup(async () => new Response('', { status: 404 }), 'https://a.test/'), null);
  assert.equal(await fetchPagePreviewMarkup(async () => assert.fail('never fetched'), 'file:///C:/x.html'), null);
});

test('previews wait, run once per page, two at a time, and skip a page that got its screenshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shots = new Set();
  const reads = [];
  const recorded = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const previews = createBrowserPagePreviews({
    lookup: (url) => (shots.has(url) ? { url, thumbnail: 'data:shot' } : null),
    read: async (url) => {
      reads.push(url);
      await gate;
      return { thumbnail: `data:image/jpeg;base64,${url}` };
    },
    record: (url, patch) => recorded.push([url, patch.thumbnail]),
  });
  for (const url of [
    'https://a.test/1',
    'https://a.test/1#x',
    'https://a.test/2',
    'https://a.test/3',
    'https://a.test/4',
  ]) {
    previews.request(url);
  }
  shots.add('https://a.test/4');
  assert.deepEqual(reads, []);
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(reads, ['https://a.test/1', 'https://a.test/2']);
  release();
  await settle();
  await settle();
  assert.deepEqual(reads, ['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);
  assert.deepEqual(
    recorded.map(([url]) => url),
    ['https://a.test/1', 'https://a.test/2', 'https://a.test/3']
  );
  previews.request('https://a.test/1');
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(reads.length, 3);
  previews.dispose();
});

test('a preview fills only what is still missing when it finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createBrowserPageIdentityStore();
  let finish;
  const previews = createBrowserPagePreviews({
    lookup: (url) => store.lookup(url),
    read: () => new Promise((resolve) => (finish = resolve)),
    record: (url, patch) => store.update(url, patch),
  });
  previews.request('https://a.test/p');
  t.mock.timers.tick(2000);
  await settle();
  // The browser recorded the page while the preview was in flight.
  store.update('https://a.test/p', { title: 'Live', favicon: 'data:image/png;base64,LIVE' });
  finish({ title: 'Preview', favicon: 'data:image/png;base64,OLD', thumbnail: 'data:image/jpeg;base64,P' });
  await settle();
  assert.deepEqual(store.lookup('https://a.test/p'), {
    url: 'https://a.test/p',
    title: 'Live',
    favicon: 'data:image/png;base64,LIVE',
    thumbnail: 'data:image/jpeg;base64,P',
  });
});

test('past the attempt limit no new page is previewed, and none is read twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const previews = createBrowserPagePreviews({
    lookup: () => null,
    read: async (url) => {
      reads.push(url);
      return null;
    },
    record: () => assert.fail('nothing to record'),
  });
  for (let i = 0; i < 501; i++) previews.request(`https://a.test/${i}`);
  previews.request('https://a.test/0');
  for (let i = 0; i < 300; i++) {
    t.mock.timers.tick(2000);
    await settle();
  }
  assert.equal(reads.length, 500);
  assert.equal(new Set(reads).size, 500);
  assert.ok(!reads.includes('https://a.test/500'));
  previews.dispose();
});

test('a preview never parses past the head or the byte cap, even inside one chunk', async () => {
  const one = (html) => async () => new Response(html, { headers: { 'content-type': 'text/html' } });
  assert.deepEqual(
    await fetchPagePreviewMarkup(
      one('<head><title>T</title></head><body><meta property="og:image" content="https://a.test/body.png">'),
      'https://a.test/'
    ),
    { url: 'https://a.test/', title: 'T' }
  );
  assert.deepEqual(
    await fetchPagePreviewMarkup(
      one('<title>T</title><meta property="og:image" content="https://a.test/late.png">'),
      'https://a.test/',
      {
        maxBytes: 16,
      }
    ),
    { url: 'https://a.test/', title: 'T' }
  );
});

test('a restored snapshot never evicts what this session recorded live', () => {
  const saved = createBrowserPageIdentityStore();
  for (let i = 0; i < 300; i++)
    saved.update(`https://s.test/${i}`, { title: `S${i}`, thumbnail: 'data:image/jpeg;base64,S' });
  const store = createBrowserPageIdentityStore();
  store.update('https://live.test/p', { title: 'Live', thumbnail: 'data:image/jpeg;base64,L' });
  store.restore(JSON.parse(JSON.stringify(saved.snapshot())));
  assert.deepEqual(store.lookup('https://live.test/p'), {
    url: 'https://live.test/p',
    title: 'Live',
    thumbnail: 'data:image/jpeg;base64,L',
  });
  // The oldest saved page made room; the newest saved ones are back.
  assert.equal(store.lookup('https://s.test/0'), null);
  assert.equal(store.lookup('https://s.test/299').title, 'S299');
});
