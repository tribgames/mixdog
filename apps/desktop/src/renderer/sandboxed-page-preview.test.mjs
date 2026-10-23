// The sandboxed page frame never adds in-frame history entries: on a phone
// such an entry takes the Back press meant for the app's panel.
import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://relay.test/' },
  expose: ['window'],
});

const { loadSandboxedPage, sandboxedPageDocument } = await import('./sandboxed-page-preview.ts');

function fakeFrame() {
  const replaced = [];
  const srcs = [];
  const listeners = new Set();
  return {
    replaced,
    srcs,
    style: { visibility: '' },
    addEventListener: (type, listener) => type === 'load' && listeners.add(listener),
    removeEventListener: (type, listener) => type === 'load' && listeners.delete(listener),
    fireLoad: () => {
      for (const listener of [...listeners]) listener();
    },
    contentWindow: { location: { replace: (url) => replaced.push(url) }, postMessage() {} },
    set src(value) {
      srcs.push(value);
    },
    removeAttribute() {},
  };
}

test('a frame that shows a page reloads by replacing its entry, never by a pushed navigation', () => {
  const frame = fakeFrame();
  const first = loadSandboxedPage(frame, '<p>a</p>');
  assert.deepEqual([frame.srcs, frame.replaced], [['/preview-frame'], []]);
  first();
  const second = loadSandboxedPage(frame, '<p>b</p>');
  assert.deepEqual(frame.srcs, ['/preview-frame'], 'no second src navigation');
  assert.deepEqual(frame.replaced, ['https://relay.test/preview-frame']);
  second();
  // Another frame starts with its own first load.
  const other = fakeFrame();
  loadSandboxedPage(other, '<p>c</p>')();
  assert.deepEqual(other.srcs, ['/preview-frame']);
});

test("the frame stays hidden (the panel's background shows) until the page itself has loaded, never the blank white /preview-frame", () => {
  const frame = fakeFrame();
  const unload = loadSandboxedPage(frame, '<p>a</p>');
  assert.equal(frame.style.visibility, 'hidden');
  frame.fireLoad(); // /preview-frame itself
  assert.equal(frame.style.visibility, 'hidden', 'the blank relay page is not shown');
  frame.fireLoad(); // the document written into it
  assert.equal(frame.style.visibility, '');
  unload();

  // The page's first paint shows it before a slow image ends its load; the
  // blank /preview-frame's own messages do not.
  const slow = fakeFrame();
  const unloadSlow = loadSandboxedPage(slow, '<img src="https://slow.test/x.png">');
  const fromFrame = (type) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { type }, source: slow.contentWindow }));
  fromFrame('mixdog-preview-painted');
  assert.equal(slow.style.visibility, 'hidden', 'nothing is posted into the frame yet');
  fromFrame('mixdog-preview-ready');
  slow.fireLoad(); // /preview-frame itself
  fromFrame('mixdog-preview-painted');
  assert.equal(slow.style.visibility, '');
  unloadSlow();

  // A frame cleaned up before its page loaded is not left hidden.
  const early = fakeFrame();
  loadSandboxedPage(early, '<p>b</p>')();
  assert.equal(early.style.visibility, '');
});

test("a page's #anchor links replace the frame's entry; its own pushState is untouched", () => {
  const html = sandboxedPageDocument('<html><head></head><body><a id="go" href="#part">part</a></body></html>');
  // Inside a frame: the page script does nothing in a top window.
  const inner = new JSDOM('<!doctype html><body></body>', {
    url: 'https://relay.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const frame = inner.window.document.createElement('iframe');
  inner.window.document.body.append(frame);
  const doc = frame.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  const win = frame.contentWindow;
  // The page's own history API is left alone (its routes keep Back/Forward).
  assert.equal(win.history.pushState, win.History.prototype.pushState);
  const before = win.history.length;
  const click = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  doc.getElementById('go').dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the anchor click does not push a fragment entry');
  assert.equal(win.history.length, before);
});
