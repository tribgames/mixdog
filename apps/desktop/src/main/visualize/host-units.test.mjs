import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { exportTabBytes } from './host-export-path.ts';
import { capturedPng, captureWindowRect, htmlFrames, paneFrames, windowAccess } from './host-frames.ts';
import { watchFile } from './host-file-watch.ts';
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
    guardNavigation: (chain, url, appInitiated) => {
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
