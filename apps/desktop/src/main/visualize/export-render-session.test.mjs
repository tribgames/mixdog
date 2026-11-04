// Off-screen visualize renders (thumbnails, inspections, exports) share one
// session: Electron never frees a session, so a partition per render kept its
// network context and pooled sockets for the life of the app. Each render
// still runs at an origin of its own (no storage shared) and judges its own
// requests.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sessions = new Map();
const windows = [];

function fakeSession(partition, options) {
  const listeners = {};
  return {
    partition,
    options,
    listeners,
    cleared: [],
    fetched: [],
    webRequest: {
      onBeforeRequest: (_filter, listener) => (listeners.before = listener),
      onCompleted: (_filter, listener) => (listeners.completed = listener),
      onErrorOccurred: (_filter, listener) => (listeners.error = listener),
      onBeforeSendHeaders: (_filter, listener) => (listeners.sendHeaders = listener),
      onHeadersReceived: (_filter, listener) => (listeners.headersReceived = listener),
    },
    protocol: { handle: (scheme, handler) => (listeners[scheme] = handler) },
    setPermissionRequestHandler: (handler) => (listeners.permission = handler),
    async clearData(filter) {
      this.cleared.push(filter);
    },
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      this.fetched.push({ url, method: init?.method, redirect: init?.redirect, credentials: init?.credentials });
      return new Response(`from ${url}`);
    },
  };
}

function fromPartition(partition, options) {
  if (!sessions.has(partition)) sessions.set(partition, fakeSession(partition, options));
  return sessions.get(partition);
}

/** What the session's own `http` handler answers for `url`. */
const served = async (session, url) => (await session.listeners.http(new Request(url))).text();

/** While set, every window waits on it once loaded (renders kept open). */
let hold = null;
let onLive = null;
const live = [];

let requestId = 0;
/** Whether the session admits `url` for the window `webContentsId`. */
function admitted(session, url, webContentsId) {
  let decision;
  session.listeners.before({ id: ++requestId, url, webContentsId }, (answer) => (decision = !answer.cancel));
  return decision;
}

class FakeWindow {
  constructor(options) {
    const preferences = options.webPreferences;
    this.session = preferences.session ?? fromPartition(preferences.partition);
    this.requests = [];
    this.loaded = null;
    this.servedDuring = null;
    this.webContents = {
      id: windows.length + 1,
      session: this.session,
      on: () => undefined,
      setWindowOpenHandler: () => undefined,
      executeJavaScript: async () => false,
      capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
    };
    windows.push(this);
  }
  async loadURL(url) {
    const { id } = this.webContents;
    this.loaded = url;
    this.requests.push(['own', admitted(this.session, `${url}asset.css`, id)]);
    this.requests.push(['foreign', admitted(this.session, 'http://127.0.0.1:9/elsewhere.js', id)]);
    // A service or shared worker's request names no window: no render owns it.
    this.requests.push(['windowless', admitted(this.session, `${new URL(url).origin}/sw.js`, undefined)]);
    this.servedDuring = await served(this.session, `${url}asset.css?v=1`);
    if (hold) {
      live.push(this);
      onLive?.();
      await hold;
    }
  }
  getBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  setContentSize() {}
  destroy() {}
}

globalThis.__exportRenderElectron = { BrowserWindow: FakeWindow, session: { fromPartition } };
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,export const BrowserWindow=globalThis.__exportRenderElectron.BrowserWindow;' +
            'export const session=globalThis.__exportRenderElectron.session;' +
            'export const screen={getDisplayMatching:()=>({scaleFactor:1})};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { inspectPageOffscreen, renderPageThumbnail } = await import('./export-render.ts');

test('repeated off-screen renders reuse one session', async () => {
  await renderPageThumbnail('http://127.0.0.1:4100/a/', false);
  await renderPageThumbnail('http://127.0.0.1:4100/b/', false);
  await inspectPageOffscreen('http://127.0.0.1:4100/c/', false, 'true');
  assert.equal(windows.length, 3);
  assert.equal(new Set(windows.map((window) => window.session)).size, 1);
  // The renders' session and the one the main process fetches their pages
  // through; neither keeps an HTTP cache.
  assert.equal(sessions.size, 2);
  for (const session of sessions.values()) assert.deepEqual(session.options, { cache: false });
});

test('every render loads at an origin of its own, served from its page only while it runs', async () => {
  windows.length = 0;
  const shared = sessions.get('visualize-offscreen');
  const network = sessions.get('visualize-offscreen-network');
  const fetchedBefore = network.fetched.length;
  // Two at once, then one later: the same page each time.
  await Promise.all([
    renderPageThumbnail('http://127.0.0.1:4100/tok/page.html', false),
    renderPageThumbnail('http://127.0.0.1:4100/tok/page.html', false),
  ]);
  await renderPageThumbnail('http://127.0.0.1:4100/tok/page.html', false);
  const origins = windows.map((window) => new URL(window.loaded).origin);
  assert.equal(new Set(origins).size, 3, `three renders, three origins: ${origins}`);
  for (const [index, window] of windows.entries()) {
    assert.match(origins[index], /^http:\/\/[\da-f]{32}\.localhost$/);
    assert.equal(new URL(window.loaded).pathname, '/tok/page.html');
    assert.equal(window.servedDuring, 'from http://127.0.0.1:4100/tok/page.htmlasset.css?v=1');
  }
  assert.deepEqual(
    network.fetched.slice(fetchedBefore).map(({ method, redirect, credentials }) => [method, redirect, credentials]),
    [
      ['GET', 'manual', 'omit'],
      ['GET', 'manual', 'omit'],
      ['GET', 'manual', 'omit'],
    ]
  );
  // Released: no longer served, and what its page stored is dropped.
  for (const origin of origins) {
    assert.equal((await shared.listeners.http(new Request(`${origin}/tok/page.html`))).status, 404);
    assert.ok(shared.cleared.some((filter) => filter.origins?.length === 1 && filter.origins[0] === origin));
  }
  // Any other http address goes out through the network session, cookieless.
  assert.equal(await served(shared, 'http://example.test/a.js'), 'from http://example.test/a.js');
  assert.equal(network.fetched.at(-1).credentials, 'omit');
});

test('each render filters its own requests on the shared session, overlapping renders included', async () => {
  windows.length = 0;
  const [first, second] = await Promise.all([
    inspectPageOffscreen('http://127.0.0.1:4101/x/', false, 'true'),
    inspectPageOffscreen('http://127.0.0.1:9/y/', true, 'true'),
  ]);
  assert.deepEqual(windows[0].requests, [
    ['own', true],
    ['foreign', false],
    ['windowless', false],
  ]);
  assert.deepEqual(windows[1].requests, [
    ['own', true],
    ['foreign', true],
    ['windowless', false],
  ]);
  assert.equal(first.problems.length, 1);
  assert.match(first.problems[0], /^blocked request: /);
  assert.deepEqual(second.problems, []);

  const shared = windows[0].session;
  const origin = new URL(windows[0].loaded).origin;
  // A finished render's window and origin, and a request no render owns, are refused.
  assert.equal(admitted(shared, `${origin}/x/late.js`, windows[0].webContents.id), false);
  assert.equal(admitted(shared, `${origin}/x/worker.js`, undefined), false);
  assert.equal(admitted(shared, 'http://127.0.0.1:4101/x/worker.js', undefined), false);
});

/** Two renders kept open at once, `network` allowed for the first only. */
async function twoLive(check) {
  windows.length = 0;
  live.length = 0;
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const bothLive = new Promise((resolve) => (onLive = () => live.length === 2 && resolve()));
  const renders = Promise.all([
    inspectPageOffscreen('http://127.0.0.1:4102/a/', true, 'true'),
    inspectPageOffscreen('http://127.0.0.1:4102/b/', false, 'true'),
  ]);
  await bothLive;
  try {
    const [a, b] = windows;
    await check({ a, b, origin: (window) => new URL(window.loaded).origin, shared: a.session });
  } finally {
    hold = null;
    onLive = null;
    release();
    await renders;
  }
}

test('a request toward another live render is refused, from a window or from none', async () => {
  await twoLive(({ a, b, origin, shared }) => {
    // Even with network allowed, another render's origin is not an address.
    assert.equal(admitted(shared, `${origin(b)}/b/secret.json`, a.webContents.id), false);
    assert.equal(admitted(shared, `${origin(a)}/a/own.json`, a.webContents.id), true);
    // A request without a window is judged by no render: not by the one it targets.
    assert.equal(admitted(shared, `${origin(b)}/b/secret.json`, undefined), false);
    assert.equal(admitted(shared, `${origin(a)}/a/own.json`, undefined), false);
  });
});

test('no off-screen request carries or sets a cookie, and frames of other origins run sandboxed', async () => {
  await twoLive(({ a, origin, shared }) => {
    let sent;
    shared.listeners.sendHeaders(
      { url: 'https://cdn.example.test/x.js', webContentsId: a.webContents.id, requestHeaders: { Cookie: 'k=1', Accept: '*/*' } },
      (answer) => (sent = answer.requestHeaders)
    );
    assert.deepEqual(sent, { Accept: '*/*' });
    const received = (url, resourceType, responseHeaders) => {
      let headers;
      shared.listeners.headersReceived(
        { url, resourceType, webContentsId: a.webContents.id, responseHeaders },
        (answer) => (headers = answer.responseHeaders)
      );
      return headers;
    };
    assert.deepEqual(received('https://cdn.example.test/x.js', 'script', { 'set-cookie': ['k=1'], 'Content-Type': ['text/javascript'] }), {
      'Content-Type': ['text/javascript'],
    });
    assert.deepEqual(received('https://embed.example.test/', 'subFrame', { 'content-security-policy': ["default-src 'self'"] }), {
      'content-security-policy': [
        "default-src 'self'",
        'sandbox allow-scripts allow-forms allow-modals allow-pointer-lock allow-presentation',
      ],
    });
    // The render's own frames keep its origin (and their script cookies).
    assert.deepEqual(received(`${origin(a)}/a/inner.html`, 'subFrame', {}), {});
  });
});
