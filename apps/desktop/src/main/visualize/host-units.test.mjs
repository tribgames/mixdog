import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { exportTabBytes } from './host-export-path.ts';
import { capturedPng, captureWindowRect, htmlFrames, paneFrames, windowAccess } from './host-frames.ts';
import { watchFile } from './host-file-watch.ts';
import { pagePoint, visualizeZoomKey, watchVisualizeZoomInput } from './host-zoom-input.ts';
import { PANE_SCROLLBAR_SCRIPT, preparePaneFrame } from './host-pane-frame.ts';
import { watchPageProblems } from './host-page-observer.ts';
import { requireShownWindow } from './host-page-ops.ts';

const frame = (url, parent = null) => ({ url, parent, isDestroyed: () => false });

test('htmlFrames matches frames by lease prefix and paneFrames keeps only direct pane frames', () => {
  const root = frame('app://panel/');
  const pane = frame('http://127.0.0.1:1/tok/index.html', root);
  const nested = frame('http://127.0.0.1:1/tok/inner.html', pane);
  const other = frame('http://127.0.0.1:1/other/index.html', root);
  const window = { webContents: { mainFrame: { framesInSubtree: [root, pane, nested, other] } } };
  const tab = { panes: [{ kind: 'html', label: 'a', url: 'http://127.0.0.1:1/tok/index.html' }, { kind: 'image' }] };
  assert.deepEqual(
    htmlFrames(window, tab).map((entry) => [entry.pane, entry.frame]),
    [
      ['a', pane],
      ['a', nested],
    ]
  );
  assert.deepEqual(
    paneFrames(window, tab).map((entry) => entry.frame),
    [pane]
  );
});

test('capturePage rect is scaled by the zoom factor and an empty capture throws', async () => {
  let seen;
  const window = {
    webContents: {
      getZoomFactor: () => 1.5,
      capturePage: async (rect) => {
        seen = rect;
        return { isEmpty: () => false, toPNG: () => Buffer.from('png') };
      },
    },
  };
  const image = await captureWindowRect(window, { x: 1, y: 2, width: 0.2, height: 10 });
  assert.deepEqual(seen, { x: 2, y: 3, width: 1, height: 15 });
  assert.equal(capturedPng(image).toString(), 'png');
  assert.throws(() => capturedPng({ isEmpty: () => true }), /capture came back empty/);
});

test('watchFile reports changes of the watched file only and stops after dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-watch-'));
  try {
    let changes = 0;
    const stop = watchFile(join(dir, 'a.html'), () => {
      changes += 1;
    });
    await writeFile(join(dir, 'b.html'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(changes, 0);
    await writeFile(join(dir, 'a.html'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(changes >= 1);
    stop();
    const before = changes;
    await writeFile(join(dir, 'a.html'), 'y');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(changes, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('watchFile on a missing folder yields a harmless disposer', () => {
  const stop = watchFile(join(tmpdir(), 'host-watch-missing-folder', 'a.html'), () => {});
  assert.doesNotThrow(stop);
});

test('requireShownWindow turns a failure into the remote-only message only when a remote device is viewing', async () => {
  const tab = { id: 't', panes: [] };
  const failure = new Error('no window');
  const viewer = (remote) => ({
    requireWindow: () => {
      throw failure;
    },
    remoteViewing: async () => remote,
  });
  await assert.rejects(requireShownWindow('s', tab, viewer(true), 'remote only'), /remote only/);
  await assert.rejects(requireShownWindow('s', tab, viewer(false), 'remote only'), (error) => error === failure);
});

function fakeContents(id) {
  const handlers = {};
  const web = {};
  const contents = {
    id,
    on: (name, handler) => {
      handlers[name] = handler;
    },
    session: {
      webRequest: new Proxy(web, {
        get: (_target, name) => (_filter, handler) => {
          handlers[name] = handler;
        },
      }),
    },
  };
  return { contents, handlers };
}

test('watchPageProblems judges only requests made by its own webContents and ignores aborted loads', () => {
  const calls = [];
  const service = {
    reportConsole: (report) => calls.push(['console', report.frameUrl]),
    guardNavigation: (_chain, url, appInitiated) => {
      calls.push(['nav', url, appInitiated]);
      return true;
    },
    guardRequest: (chain, request) => {
      calls.push(['request', chain.length, request.url]);
      return true;
    },
    reportAssetFailure: (url, detail, chain) => calls.push(['asset', url, detail, chain.length]),
    reportNavigation: (url, code) => calls.push(['navigated', url, code]),
    reportLoadFailure: (url, description) => calls.push(['load', url, description]),
  };
  const { contents, handlers } = fakeContents(7);
  watchPageProblems(contents, service);

  const mine = { webContentsId: 7, frame: frame('http://x/a/'), referrer: 'http://x/ref' };
  const foreign = { webContentsId: 8, frame: frame('http://x/a/'), referrer: 'http://x/ref' };
  let cancelled;
  handlers.onBeforeRequest({ ...mine, url: 'http://y/', resourceType: 'script' }, (answer) => {
    cancelled = answer.cancel;
  });
  assert.equal(cancelled, true);
  handlers.onBeforeRequest({ ...foreign, url: 'http://y/', resourceType: 'script' }, () => {});
  handlers.onCompleted({ ...mine, url: 'http://y/a.css', statusCode: 404, resourceType: 'stylesheet' });
  handlers.onCompleted({ ...mine, url: 'http://y/', statusCode: 404, resourceType: 'mainFrame' });
  handlers.onErrorOccurred({ ...mine, url: 'http://y/b.js', error: 'net::ERR_ABORTED', resourceType: 'script' });
  handlers.onErrorOccurred({ ...mine, url: 'http://y/c.js', error: 'net::ERR_FAILED', resourceType: 'script' });
  handlers['did-fail-load']({}, -3, 'superseded', 'http://y/d', false);
  handlers['did-fail-load']({}, -2, 'gone', 'http://y/e', false);
  handlers['did-frame-navigate']({}, 'http://y/f', 200, '', true);
  handlers['did-frame-navigate']({}, 'http://y/g', 200, '', false);

  assert.deepEqual(calls, [
    ['request', 2, 'http://y/'],
    ['request', 0, 'http://y/'],
    ['asset', 'http://y/a.css', '404', 2],
    ['asset', 'http://y/c.js', 'net::ERR_FAILED', 2],
    ['load', 'http://y/e', 'gone'],
    ['navigated', 'http://y/g', 200],
  ]);
});

test('windowAccess hands out only a live window and throws when there is none', () => {
  const alive = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  const closed = { isDestroyed: () => true, webContents: { isDestroyed: () => false } };
  const noContents = { isDestroyed: () => false, webContents: { isDestroyed: () => true } };
  assert.equal(windowAccess(() => alive).require(), alive);
  assert.equal(windowAccess(() => closed).live(), null);
  assert.equal(windowAccess(() => noContents).live(), null);
  assert.throws(() => windowAccess(() => null).require(), /desktop window is not open/);
});

test('exportTabBytes refuses a PDF of a non-HTML pane and captures the panel for a PNG of one', async () => {
  const capture = async () => Buffer.from('shot');
  const tab = { panes: [{ kind: 'image', url: '' }] };
  await assert.rejects(exportTabBytes(capture, tab, 'pdf', 0), /Save as PDF is for HTML pages/);
  assert.equal((await exportTabBytes(capture, tab, 'png', 0)).toString(), 'shot');
});

test('zoom gestures inside a pane frame are forwarded to the renderer, once per window', () => {
  const key = (key, extra = {}) => ({ type: 'keyDown', key, control: true, meta: false, alt: false, ...extra });
  assert.equal(visualizeZoomKey(key('=')), 'in');
  assert.equal(visualizeZoomKey(key('+')), 'in');
  assert.equal(visualizeZoomKey(key('-')), 'out');
  assert.equal(visualizeZoomKey(key('0', { control: false, meta: true })), 'reset');
  assert.equal(visualizeZoomKey(key('=', { control: false })), null);
  assert.equal(visualizeZoomKey(key('=', { alt: true })), null);
  assert.equal(visualizeZoomKey(key('=', { type: 'keyUp' })), null);
  assert.equal(visualizeZoomKey(key('a')), null);

  // Every registration is recorded: a Map keyed by event name would hide a
  // second listener for the same event.
  const registrations = [];
  const handlers = { get: (name) => registrations.find(([event]) => event === name)?.[1] };
  const sent = [];
  const mainFrame = {};
  const contents = {
    mainFrame,
    focusedFrame: mainFrame,
    isDestroyed: () => false,
    on: (name, handler) => registrations.push([name, handler]),
    send: (channel, event) => sent.push([channel, event]),
  };
  const cursor = { x: 40, y: 50 };
  watchVisualizeZoomInput(contents, () => cursor);
  const wired = registrations.length;
  assert.deepEqual(registrations.map(([name]) => name).sort(), ['before-input-event', 'blur', 'zoom-changed'].sort());
  watchVisualizeZoomInput(contents, () => cursor);
  assert.equal(registrations.length, wired, 'a second watch must not register again');

  // Ctrl+wheel the frame's page left alone: the pointer's place goes with it.
  // A wheel input-event carries no position (only type and modifiers), so the
  // place cannot come from it.
  handlers.get('input-event')?.({}, { type: 'mouseWheel', modifiers: ['control'] });
  handlers.get('zoom-changed')({}, 'in');
  assert.deepEqual(sent.pop()[1], { sessionId: '', zoom: 'in', point: { x: 40, y: 50 } });

  // A zoom key counts only while a subframe holds focus; the panel's own
  // document handles the main frame's keys itself.
  const press = (input) => {
    let prevented = false;
    handlers.get('before-input-event')({ preventDefault: () => (prevented = true) }, input);
    return prevented;
  };
  assert.equal(press(key('=')), false);
  assert.equal(sent.length, 0);
  contents.focusedFrame = {};
  // The key is swallowed (the PDF viewer must not zoom too) and forwarded;
  // Ctrl already went down under the main frame (the panel's document saw it),
  // so only the zoom is reported.
  assert.equal(press(key('-')), true);
  assert.deepEqual(
    sent.map(([, event]) => event),
    [{ sessionId: '', zoom: 'out' }]
  );
  sent.length = 0;
  assert.equal(press(key('x')), false);
  assert.equal(sent.length, 0);
  // Windows reports the release of Ctrl with Ctrl's own flag still set.
  press({ type: 'keyUp', key: 'Control', control: true, meta: false, alt: false });
  assert.deepEqual(sent.pop()[1], { sessionId: '', zoomModifier: false });

  // Focus transitions: Ctrl pressed in the frame, window blurs, Ctrl released
  // elsewhere, and a new press in the frame must be reported again.
  press({ type: 'keyDown', key: 'Control', control: true, meta: false, alt: false });
  assert.deepEqual(sent.pop()[1], { sessionId: '', zoomModifier: true });
  handlers.get('blur')();
  contents.focusedFrame = mainFrame;
  press({ type: 'keyUp', key: 'Control', control: true, meta: false, alt: false });
  contents.focusedFrame = {};
  press({ type: 'keyDown', key: 'Control', control: true, meta: false, alt: false });
  assert.deepEqual(sent.pop()[1], { sessionId: '', zoomModifier: true });
  // Release in the main frame without a blur is tracked too.
  contents.focusedFrame = mainFrame;
  press({ type: 'keyUp', key: 'Control', control: true, meta: false, alt: false });
  contents.focusedFrame = {};
  press({ type: 'keyDown', key: 'Control', control: true, meta: false, alt: false });
  assert.deepEqual(sent.pop()[1], { sessionId: '', zoomModifier: true });
});

test('a loaded pane page gets the app scrollbar as a layered constructed sheet; other frames get nothing', async () => {
  const ran = [];
  const paneFrame = (url) => ({
    url,
    isDestroyed: () => false,
    executeJavaScript: async (script) => {
      ran.push(script);
    },
  });
  const source = {
    isPaneFrame: (url) => url.startsWith('http://127.0.0.1:1/tok/'),
    marksForFrame: () => [{ selector: 'h1', label: 'a' }],
  };

  await preparePaneFrame(paneFrame('app://panel/other'), source);
  assert.deepEqual(ran, []);

  await preparePaneFrame(paneFrame('http://127.0.0.1:1/tok/index.html'), source);
  assert.equal(ran.length, 2);
  const scrollbar = ran.find((script) => script === PANE_SCROLLBAR_SCRIPT);
  assert.ok(scrollbar);
  assert.ok(
    ran.some((script) => /attachShadow/.test(script)),
    'the marks are redrawn too'
  );

  // Run the injected script against a minimal document.
  const document = { adoptedStyleSheets: ['page-sheet'] };
  class CSSStyleSheet {
    replaceSync(css) {
      this.css = css;
    }
  }
  vm.runInNewContext(scrollbar, { document, CSSStyleSheet });
  assert.equal(document.adoptedStyleSheets.length, 2);
  const { css } = document.adoptedStyleSheets[1];
  // The thin pill look of 02-base.css, inside a cascade layer so the page's own
  // unlayered ::-webkit-scrollbar / scrollbar-width / scrollbar-color rules win.
  assert.match(css, /^@layer [\w-]+ \{/);
  assert.match(css, /::-webkit-scrollbar \{ width: 8px; height: 8px; \}/);
  assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*border-radius: 999px/);
  assert.doesNotMatch(css, /!important|scrollbar-width|scrollbar-color/);
});

test('the cursor maps to page CSS px through the window origin and a non-1 zoom factor', () => {
  assert.deepEqual(pagePoint({ x: 300, y: 200 }, { x: 100, y: 50 }, 1), { x: 200, y: 150 });
  // At 150% a page px is 1.5 device px: 300 device px right of the origin is 200 CSS px.
  assert.deepEqual(pagePoint({ x: 400, y: 350 }, { x: 100, y: 50 }, 1.5), { x: 200, y: 200 });
  assert.deepEqual(pagePoint({ x: 400, y: 350 }, { x: 100, y: 50 }, 0), { x: 300, y: 300 });
});
