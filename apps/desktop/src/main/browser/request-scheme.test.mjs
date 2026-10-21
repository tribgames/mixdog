import assert from 'node:assert/strict';
import test from 'node:test';
import { browserRequestDisposition, isBrowserComponentAddress } from './request-scheme.ts';

test("a browser component is told by its URL or origin's scheme", () => {
  for (const address of ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai', 'chrome://resources/js/assert.js']) {
    assert.equal(isBrowserComponentAddress(address), true, address);
  }
  for (const address of ['http://127.0.0.1:1/', '://', 'node:electron/js2c/sandbox_bundle', '', undefined]) {
    assert.equal(isBrowserComponentAddress(address), false, String(address));
  }
});

test('web traffic goes to the URL policy; a page document is only ever an http(s) document', () => {
  for (const url of ['https://a.test/', 'http://a.test/x']) {
    assert.equal(browserRequestDisposition(url, 'mainFrame'), 'web');
    assert.equal(browserRequestDisposition(url, 'script'), 'web');
  }
  for (const url of ['wss://a.test/s', 'ws://a.test/s']) {
    assert.equal(browserRequestDisposition(url, 'webSocket'), 'web');
    assert.equal(browserRequestDisposition(url, 'mainFrame'), 'deny', url);
  }
  for (const url of [
    'data:text/html,x',
    'blob:https://a.test/1',
    'about:srcdoc',
    'chrome://settings/',
    'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(browserRequestDisposition(url, 'mainFrame'), 'deny', url);
  }
});

test("an about:blank page's dialog bridge request is let through for the host to answer, nothing else on its host", () => {
  // window.open('') pages have no origin of their own to ask; the bridge asks
  // a reserved host that never resolves, and the debugger answers it.
  assert.equal(
    browserRequestDisposition('http://mixdog-dialog-bridge.invalid/.well-known/mixdog-dialog-bridge?type=alert', 'xhr'),
    'allow'
  );
  for (const [url, type] of [
    ['http://mixdog-dialog-bridge.invalid/other', 'xhr'],
    ['http://mixdog-dialog-bridge.invalid/.well-known/mixdog-dialog-bridge', 'mainFrame'],
    ['https://mixdog-dialog-bridge.invalid/.well-known/mixdog-dialog-bridge', 'xhr'],
    ['http://evil.test/.well-known/mixdog-dialog-bridge', 'xhr'],
  ]) {
    assert.equal(browserRequestDisposition(url, type), 'web', url);
  }
});

test("embedded content and the browser's own components load; other schemes do not", () => {
  // Chromium's PDF viewer: its frame, its scripts and the shared modules it imports.
  for (const [url, type] of [
    ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', 'subFrame'],
    ['chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/pdf_embedder.css', 'stylesheet'],
    ['chrome://resources/lit/v3_0/lit.rollup.js', 'script'],
    ['data:image/png;base64,AA==', 'image'],
    ['blob:https://a.test/1', 'xhr'],
    ['about:srcdoc', 'subFrame'],
  ]) {
    assert.equal(browserRequestDisposition(url, type), 'allow', url);
  }
  for (const url of [
    'file:///C:/secret.txt',
    'ftp://a.test/x',
    'mixdog-media://x',
    'devtools://devtools/bundled/devtools_app.html',
    'chrome-untrusted://print/1/0/print.pdf',
    'not a url',
  ]) {
    assert.equal(browserRequestDisposition(url, 'subFrame'), 'deny', url);
  }
});
