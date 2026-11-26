import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as settle } from 'node:timers/promises';

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
  await settle();
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

test('page-identity.bin is loaded on first lookup, not at startup, and thumbnails are served from disk', async (t) => {
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === 'electron'
        ? {
            url: 'data:text/javascript,export const nativeImage={createFromBuffer:()=>({isEmpty:()=>true,toDataURL:()=>""})};',
            shortCircuit: true,
          }
        : next(specifier, context),
  });
  const { createBrowserHostPageIdentity } = await import('./host-page-identity.ts');
  const { PAGE_THUMB_PREFIX, readBrowserPageThumbnail, resolveBrowserPageThumbnail } = await import(
    './page-thumbnail-disk.ts'
  );

  const directory = await mkdtemp(join(tmpdir(), 'page-identity-lazy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let decryptCalls = 0;
  const seal = {
    encrypt: async (text) => Buffer.from(`sealed:${text}`),
    decrypt: async (data) => {
      decryptCalls += 1;
      const text = data.toString();
      return text.startsWith('sealed:') ? text.slice(7) : null;
    },
  };

  // Seed a legacy page-identity.bin containing a base64 thumbnail payload.
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const legacyDataUrl = `data:image/jpeg;base64,${jpgBytes.toString('base64')}`;
  const seeded = createBrowserPageIdentityStore();
  seeded.update('https://lazy.test/doc', { title: 'Lazy Doc', thumbnail: legacyDataUrl });
  const seedFile = createBrowserPageIdentityFile({ store: seeded, directory, saveDelayMs: 60_000, ...seal });
  seedFile.schedule();
  await seedFile.flush();
  decryptCalls = 0;

  // Startup construction must not read page-identity.bin.
  const announced = [];
  const host = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession must not be created on lookup'),
    directory,
    announce: (origin) => announced.push(origin),
    ...seal,
  });
  await settle();
  assert.equal(decryptCalls, 0, 'page-identity.bin must not be read at startup');

  // Flushing without changes must not read page-identity.bin either.
  await host.file.flush();
  assert.equal(decryptCalls, 0);

  // First lookup triggers lazy loading from disk and announces the loaded origin.
  host.store.lookup('https://lazy.test/doc');
  await host.file.ensureLoaded();
  await settle();
  assert.equal(decryptCalls, 1, 'page-identity.bin loaded on first lookup');
  assert.deepEqual(announced, ['https://lazy.test']);

  const loaded = host.store.lookup('https://lazy.test/doc');
  assert.equal(loaded?.title, 'Lazy Doc');
  assert.ok(loaded?.thumbnail?.startsWith(PAGE_THUMB_PREFIX), 'thumbnail migrated to disk media URL');
  assert.equal(loaded?.thumbnail?.startsWith('data:'), false, 'no base64 thumbnail retained in memory');

  // Snapshot stores only the compact disk URL, never base64 image bytes.
  const snap = host.store.snapshot();
  assert.ok(snap.thumbnails[0][1].startsWith(PAGE_THUMB_PREFIX));

  // Migrating legacy inline base64 thumbnails schedules a rewrite of page-identity.bin.
  await host.file.flush();
  const rewritten = (await readFile(host.file.file)).toString();
  assert.equal(rewritten.includes('data:image/'), false, 'page-identity.bin drops migrated inline base64 payloads');
  assert.equal(rewritten.includes(PAGE_THUMB_PREFIX), true, 'page-identity.bin persists disk thumbnail URLs');

  // Disk file is encrypted (never plaintext image bytes), and the media reader decrypts exact bytes with its token.
  const loadedUrl = new URL(loaded.thumbnail);
  const fileName = loadedUrl.pathname.replace(/^\/+/, '');
  const token = loadedUrl.searchParams.get('t') ?? '';
  assert.ok(token.length >= 32, 'thumbnail URL includes a runtime capability token');
  const resolved = resolveBrowserPageThumbnail(fileName);
  assert.ok(resolved, 'disk thumbnail resolves for mixdog-media://page-thumb/');
  assert.equal(resolved.mime, 'image/jpeg');
  const rawMigrated = await readFile(resolved.path);
  assert.equal(rawMigrated.equals(jpgBytes), false, 'thumbnail file on disk must be encrypted, not plaintext');
  assert.equal(rawMigrated.includes(jpgBytes), false, 'plaintext JPEG bytes must not appear on disk');
  assert.equal(await readBrowserPageThumbnail(fileName, ''), null, 'missing token cannot decrypt thumbnail');
  const decryptedMigrated = await readBrowserPageThumbnail(fileName, token);
  assert.equal(decryptedMigrated?.mime, 'image/jpeg');
  assert.deepEqual(decryptedMigrated?.bytes, jpgBytes);

  // Live updates also write encrypted thumbnails to disk rather than storing base64 in memory.
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  host.store.update('https://live.test/page', {
    title: 'Live',
    thumbnail: `data:image/png;base64,${pngBytes.toString('base64')}`,
  });
  const live = host.store.lookup('https://live.test/page');
  assert.ok(live?.thumbnail?.startsWith(PAGE_THUMB_PREFIX));
  const liveUrl = new URL(live.thumbnail);
  const liveFileName = liveUrl.pathname.replace(/^\/+/, '');
  const liveToken = liveUrl.searchParams.get('t') ?? '';
  const decryptedLive = await readBrowserPageThumbnail(liveFileName, liveToken);
  assert.equal(decryptedLive?.mime, 'image/png');
  assert.deepEqual(decryptedLive?.bytes, pngBytes);
  const liveResolved = resolveBrowserPageThumbnail(liveFileName);
  assert.ok(liveResolved);
  assert.equal((await readFile(liveResolved.path)).includes(pngBytes), false, 'live PNG bytes are encrypted on disk');

  // Disposing previews tears down disk thumbnail registration so directories do not leak.
  host.previews.dispose();
  assert.equal(resolveBrowserPageThumbnail(liveFileName), null, 'disposing host unregisters thumbnail directory');
  assert.equal(await readBrowserPageThumbnail(liveFileName, liveToken), null);

  // Restoring in a new host instance re-mints a fresh runtime token and rejects the old run's token.
  const restarted = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory,
    announce: () => {},
    ...seal,
  });
  t.after(() => restarted.dispose());
  await restarted.file.ensureLoaded();
  const restored = restarted.store.lookup('https://lazy.test/doc');
  assert.ok(restored?.thumbnail?.startsWith(PAGE_THUMB_PREFIX));
  const restartedUrl = new URL(restored.thumbnail);
  const restartedToken = restartedUrl.searchParams.get('t') ?? '';
  assert.notEqual(restartedToken, token, 'restored thumbnail rotates capability token on restart');
  assert.equal(await readBrowserPageThumbnail(fileName, token), null, 'prior run token is rejected after restart');
  assert.deepEqual((await readBrowserPageThumbnail(fileName, restartedToken))?.bytes, jpgBytes);
});

test('disk page thumbnail storage skips plaintext writes when safeStorage encryption is unavailable', async (t) => {
  const { createBrowserHostPageIdentity } = await import('./host-page-identity.ts');
  const { readBrowserPageThumbnail } = await import('./page-thumbnail-disk.ts');
  const { readdir } = await import('node:fs/promises');

  const directory = await mkdtemp(join(tmpdir(), 'page-thumb-no-encrypt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const host = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory,
    announce: () => {},
    encrypt: async () => null,
    decrypt: async () => null,
  });
  t.after(() => host.dispose());

  const secretPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
  host.store.update('https://bank.test/account', {
    title: 'Account',
    thumbnail: `data:image/png;base64,${secretPng.toString('base64')}`,
  });
  await host.file.flush();

  const thumbDir = join(directory, 'page-thumbnails');
  const files = await readdir(thumbDir).catch(() => []);
  assert.deepEqual(files, [], 'no plaintext thumbnail file written when encryption is unavailable');
  const looked = host.store.lookup('https://bank.test/account');
  assert.equal(looked?.title, 'Account');
  assert.equal(looked?.thumbnail, undefined, 'failed unencrypted thumbnail URL is dropped from memory');
  assert.equal(await readBrowserPageThumbnail(`${'0'.repeat(32)}.png`, '0'.repeat(32)), null);
});

test('disk page thumbnail storage serializes remove and put on the same path without leaking per-path state', async (t) => {
  const { createDiskPageThumbnailStorage, readBrowserPageThumbnail } = await import('./page-thumbnail-disk.ts');
  const { readdir } = await import('node:fs/promises');

  const directory = await mkdtemp(join(tmpdir(), 'page-thumb-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let holdFirstEncrypt = true;
  let firstEncryptStarted;
  const firstEncryptWaiting = new Promise((resolve) => (firstEncryptStarted = resolve));
  let releaseFirstEncrypt;
  let encryptCalls = 0;
  const storage = createDiskPageThumbnailStorage(directory, {
    encrypt: async (text) => {
      encryptCalls += 1;
      if (encryptCalls === 1 && holdFirstEncrypt) {
        holdFirstEncrypt = false;
        firstEncryptStarted();
        await new Promise((resolve) => (releaseFirstEncrypt = resolve));
      }
      return Buffer.from(`enc:${text}`);
    },
    decrypt: async (data) => {
      const text = data.toString();
      return text.startsWith('enc:') ? text.slice(4) : null;
    },
  });
  t.after(() => storage.dispose());

  const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
  const secondBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);
  const firstUrl = storage.put('https://race.test/page', `data:image/png;base64,${firstBytes.toString('base64')}`);
  assert.ok(firstUrl);
  await firstEncryptWaiting;
  // Queue a remove followed immediately by a fresh put for the same key while the first write is still pending.
  storage.remove(firstUrl);
  const secondUrl = storage.put('https://race.test/page', `data:image/png;base64,${secondBytes.toString('base64')}`);
  assert.ok(secondUrl);
  releaseFirstEncrypt();
  await storage.settled();

  const parsedSecond = new URL(secondUrl);
  const read = await readBrowserPageThumbnail(
    parsedSecond.pathname.replace(/^\/+/, ''),
    parsedSecond.searchParams.get('t') ?? ''
  );
  assert.deepEqual(read?.bytes, secondBytes, 'remove never unlinks a subsequent put on the same path');

  // Remove many distinct URLs and confirm disk and queues drain cleanly.
  const urls = [];
  for (let i = 0; i < 40; i += 1) {
    const u = storage.put(`https://evict.test/${i}`, `data:image/png;base64,${firstBytes.toString('base64')}`);
    assert.ok(u);
    urls.push(u);
  }
  await storage.settled();
  for (const u of urls) storage.remove(u);
  storage.remove(secondUrl);
  await storage.settled();
  assert.deepEqual(await readdir(directory), [], 'all removed encrypted thumbnails are cleaned from disk');
});

test('browser host shutdown flushes pending encrypted thumbnails before disposing storage and drops aborted writes on direct dispose', async (t) => {
  const { createBrowserHostPageIdentity } = await import('./host-page-identity.ts');
  const { createBrowserHostLifecycleMethods } = await import('./host-methods.ts');
  const { readBrowserPageThumbnail } = await import('./page-thumbnail-disk.ts');
  const { readdir } = await import('node:fs/promises');

  const directory = await mkdtemp(join(tmpdir(), 'page-thumb-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let holdThumbEncrypt = true;
  let releaseThumbEncrypt;
  let thumbEncryptStarted;
  const thumbEncryptWaiting = new Promise((resolve) => (thumbEncryptStarted = resolve));
  const seal = {
    encrypt: async (text) => {
      if (holdThumbEncrypt && !text.startsWith('{')) {
        holdThumbEncrypt = false;
        thumbEncryptStarted();
        await new Promise((resolve) => (releaseThumbEncrypt = resolve));
      }
      return Buffer.from(`sealed:${text}`);
    },
    decrypt: async (data) => {
      const text = data.toString();
      return text.startsWith('sealed:') ? text.slice(7) : null;
    },
  };

  const host = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory,
    announce: () => {},
    ...seal,
  });
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
  host.store.update('https://shutdown.test/doc', {
    title: 'Shutdown Doc',
    thumbnail: `data:image/png;base64,${pngBytes.toString('base64')}`,
  });
  await thumbEncryptWaiting;

  const lifecycle = createBrowserHostLifecycleMethods({
    bridge: { start() {}, stop: async () => {} },
    remoteTabs: { dispose() {} },
    userReclaimTimer: setInterval(() => {}, 60_000),
    stopFollowingScale() {},
    presentationReads: { dispose() {} },
    stopSessionAutosave() {},
    sessionStore: { save: async () => 0 },
    pagePreviews: host.previews,
    pageIdentityFile: host.file,
    cookieJar: { dispose: async () => {} },
    partition: { dispose() {} },
    visibleGuests: () => [],
    detach: async () => {},
    lifecycle: { destroyAllPrimaryPages() {} },
  });

  // Start real shutdown while thumbnail encryption is still pending, then let it finish.
  const shuttingDown = lifecycle.dispose();
  releaseThumbEncrypt();
  await shuttingDown;

  // Encrypted thumbnail file must exist on disk and be restored cleanly on the next startup.
  const files = await readdir(join(directory, 'page-thumbnails'));
  assert.equal(files.length, 1, 'shutdown flushes pending encrypted thumbnail file before disposing');

  const restarted = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory,
    announce: () => {},
    encrypt: async (text) => Buffer.from(`sealed:${text}`),
    decrypt: seal.decrypt,
  });
  t.after(() => restarted.dispose());
  await restarted.file.ensureLoaded();
  const restored = restarted.store.lookup('https://shutdown.test/doc');
  assert.ok(restored?.thumbnail);
  const parsed = new URL(restored.thumbnail);
  assert.deepEqual(
    (await readBrowserPageThumbnail(parsed.pathname.replace(/^\/+/, ''), parsed.searchParams.get('t') ?? ''))?.bytes,
    pngBytes
  );

  // Direct dispose before flush rolls back unpersisted thumbnail URLs so flush never persists a dead URL.
  const dir2 = await mkdtemp(join(tmpdir(), 'page-thumb-direct-dispose-'));
  t.after(() => rm(dir2, { recursive: true, force: true }));
  let releaseDirect;
  let directStarted;
  const directWaiting = new Promise((resolve) => (directStarted = resolve));
  let directThumb = true;
  const host2 = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory: dir2,
    announce: () => {},
    encrypt: async (text) => {
      if (directThumb && !text.startsWith('{')) {
        directThumb = false;
        directStarted();
        await new Promise((resolve) => (releaseDirect = resolve));
      }
      return Buffer.from(`sealed:${text}`);
    },
    decrypt: seal.decrypt,
  });
  host2.store.update('https://aborted.test/page', {
    title: 'Aborted',
    thumbnail: `data:image/png;base64,${pngBytes.toString('base64')}`,
  });
  await directWaiting;
  host2.previews.dispose();
  releaseDirect();
  await host2.file.flush();
  assert.equal(host2.store.lookup('https://aborted.test/page')?.thumbnail, undefined);
  assert.deepEqual(host2.store.snapshot().thumbnails, []);
});

test('dropThumbnail notifies subscribers when a failed thumbnail write rolls back, and ignores stale rollbacks', async (t) => {
  const { createBrowserHostPageIdentity } = await import('./host-page-identity.ts');

  // Unit check: store.dropThumbnail fires onChange only when it actually removes the matching thumbnail URL.
  const changed = [];
  const store = createBrowserPageIdentityStore({ onChange: (origin) => changed.push(origin) });
  store.update('https://rollback.test/item', { title: 'Item', thumbnail: 'data:image/png;base64,AAAA' });
  assert.deepEqual(changed, ['https://rollback.test']);

  store.dropThumbnail('https://rollback.test/item', 'data:image/png;base64,STALE');
  assert.deepEqual(changed, ['https://rollback.test'], 'mismatching expectedUrl does not fire onChange');
  assert.equal(store.lookup('https://rollback.test/item')?.thumbnail, 'data:image/png;base64,AAAA');

  store.dropThumbnail('https://rollback.test/item', 'data:image/png;base64,AAAA');
  assert.deepEqual(changed, ['https://rollback.test', 'https://rollback.test'], 'removing thumbnail fires onChange');
  assert.equal(store.lookup('https://rollback.test/item')?.thumbnail, undefined);

  store.dropThumbnail('https://rollback.test/item', 'data:image/png;base64,AAAA');
  assert.deepEqual(changed, ['https://rollback.test', 'https://rollback.test'], 'duplicate drop does not re-fire');

  // Host check: an async failed disk thumbnail write announces the origin again so renderer caches drop the dead URL.
  const directory = await mkdtemp(join(tmpdir(), 'page-thumb-rollback-notify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  let encryptStarted;
  const encryptWaiting = new Promise((resolve) => (encryptStarted = resolve));
  let releaseEncrypt;
  const announced = [];
  const host = createBrowserHostPageIdentity({
    partitionSession: () => assert.fail('partitionSession unused'),
    directory,
    announce: (origin) => announced.push(origin),
    encrypt: async (text) => {
      if (!text.startsWith('{')) {
        encryptStarted();
        await new Promise((resolve) => (releaseEncrypt = resolve));
        return null;
      }
      return Buffer.from(`sealed:${text}`);
    },
    decrypt: async () => null,
  });
  t.after(() => host.dispose());

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  host.store.update('https://bank.test/account', {
    title: 'Account',
    thumbnail: `data:image/png;base64,${pngBytes.toString('base64')}`,
  });
  await encryptWaiting;
  await settle();
  assert.ok(host.store.lookup('https://bank.test/account')?.thumbnail, 'optimistic URL is visible before write fails');
  assert.deepEqual(announced, ['https://bank.test']);

  releaseEncrypt();
  await host.file.flush();
  await settle();
  assert.equal(host.store.lookup('https://bank.test/account')?.thumbnail, undefined, 'failed thumbnail URL is removed');
  assert.deepEqual(
    announced,
    ['https://bank.test', 'https://bank.test'],
    'rollback announces the origin so renderer caches drop the dead thumbnail URL'
  );
});
