import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { sandboxStorageShimScript, withHeadScript, withSandboxStorageShim } from './sandbox-storage-shim.ts';

/** A scripted window whose real storages throw, like an opaque-origin frame. */
function throwingWindow() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(dom.window, name, {
      configurable: true,
      get() {
        throw new dom.window.DOMException('denied', 'SecurityError');
      },
    });
  }
  return dom.window;
}

test('when the real storage throws, in-memory Storage replacements are installed', () => {
  const win = throwingWindow();
  win.eval(sandboxStorageShimScript());
  for (const name of ['localStorage', 'sessionStorage']) {
    const store = win[name];
    assert.equal(store.length, 0);
    assert.equal(store.getItem('a'), null);
    store.setItem('a', 1);
    store.setItem('b', { toString: () => 'two' });
    assert.equal(store.getItem('a'), '1');
    assert.equal(store.getItem('b'), 'two');
    assert.equal(store.length, 2);
    assert.equal(store.key(0), 'a');
    assert.equal(store.key(1), 'b');
    assert.equal(store.key(2), null);
    store.setItem('a', 'again');
    assert.equal(store.length, 2);
    store.removeItem('a');
    assert.equal(store.getItem('a'), null);
    assert.equal(store.length, 1);
    // Property-style access reaches the same data.
    store.x = 5;
    assert.equal(store.getItem('x'), '5');
    assert.equal(store.x, '5');
    assert.equal(win.eval(`window.${name}.x`), '5');
    delete store.x;
    assert.equal(store.getItem('x'), null);
    store.clear();
    assert.equal(store.length, 0);
    assert.equal(store.key(0), null);
  }
  // The two storages are independent.
  win.localStorage.setItem('only', 'local');
  assert.equal(win.sessionStorage.getItem('only'), null);
});

test('a working real storage is left alone', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const real = dom.window.localStorage;
  dom.window.eval(sandboxStorageShimScript());
  assert.equal(dom.window.localStorage, real);
  assert.equal(dom.window.sessionStorage, dom.window.sessionStorage);
  dom.window.sessionStorage.setItem('k', 'v');
  assert.equal(dom.window.sessionStorage.getItem('k'), 'v');
  assert.ok(dom.window.sessionStorage instanceof dom.window.Storage);
});

test('a page whose script uses localStorage runs in an opaque origin once the shim is first', () => {
  const page =
    '<!doctype html><html><head><title>t</title></head><body><script>' +
    'localStorage.setItem("tab", "2"); window.result = localStorage.getItem("tab");</script></body></html>';
  // jsdom's default about:blank origin is opaque: real storage throws there.
  const bare = new JSDOM(page, { runScripts: 'dangerously' });
  assert.equal(bare.window.result, undefined);
  const shimmed = new JSDOM(withSandboxStorageShim(page), { runScripts: 'dangerously' });
  assert.equal(shimmed.window.result, '2');
});

test('insertion is HTML-aware: comments, script text and quoted attributes never host the anchor', () => {
  const s = 'SHIM()';
  const tag = '<script>SHIM()</script>';
  // `<head>` inside a comment before the real head.
  assert.equal(
    withHeadScript('<!-- <head> --><html><head><script>p()</script></head></html>', s),
    `<!-- <head> --><html><head>${tag}<script>p()</script></head></html>`
  );
  // A comment mentioning <html> / <head> with no real head: lands after the real <html>.
  assert.equal(
    withHeadScript('<!doctype html><!-- <html><head> --><html><body><script>p()</script></body></html>', s),
    `<!doctype html><!-- <html><head> --><html>${tag}<body><script>p()</script></body></html>`
  );
  // A script whose text contains "<head>" before any head tag.
  const scripted = '<!doctype html><script>var h = "<head>"; p()</script><head></head>';
  assert.equal(withHeadScript(scripted, s), `<!doctype html>${tag}<script>var h = "<head>"; p()</script><head></head>`);
  // A `>` inside a quoted attribute value does not end the tag.
  assert.equal(
    withHeadScript('<html data-x="a>b"><head title=\'x>y\' class=z><script>p()</script></head></html>', s),
    `<html data-x="a>b"><head title='x>y' class=z>${tag}<script>p()</script></head></html>`
  );
  assert.equal(
    withHeadScript('<html data-x="a>b"><body><script>p()</script></body></html>', s),
    `<html data-x="a>b">${tag}<body><script>p()</script></body></html>`
  );
  // Uppercase tags.
  assert.equal(
    withHeadScript('<!DOCTYPE HTML><HTML><HEAD><TITLE>t</TITLE></HEAD></HTML>', s),
    `<!DOCTYPE HTML><HTML><HEAD>${tag}<TITLE>t</TITLE></HEAD></HTML>`
  );
  // A leading BOM stays first; a doctype stays ahead of the shim.
  assert.equal(withHeadScript('\uFEFF<script>p()</script>', s), `\uFEFF${tag}<script>p()</script>`);
  assert.equal(withHeadScript('\uFEFF<!doctype html><p>x</p>', s), `\uFEFF<!doctype html>${tag}<p>x</p>`);
  assert.equal(withHeadScript('\uFEFF<head></head>', s), `\uFEFF<head>${tag}</head>`);
  // No head, no html, no markup at all; a head only after body content is not a head.
  assert.equal(withHeadScript('plain text', s), `${tag}plain text`);
  assert.equal(withHeadScript('', s), tag);
  assert.equal(
    withHeadScript('<body><head></head><script>p()</script></body>', s),
    `${tag}<body><head></head><script>p()</script></body>`
  );
  // A comment closed by `--!>` ends there, so the real head after it is found.
  assert.equal(
    withHeadScript('<!-- x --!><head><script>p()</script><!-- later --></head>', s),
    `<!-- x --!><head>${tag}<script>p()</script><!-- later --></head>`
  );
  // Abrupt empty comments.
  assert.equal(withHeadScript('<!--><head></head>', s), `<!--><head>${tag}</head>`);
  assert.equal(withHeadScript('<!---><head></head>', s), `<!---><head>${tag}</head>`);
  // An unterminated comment or tag is left whole.
  assert.equal(withHeadScript('<!-- <head>', s), `${tag}<!-- <head>`);
  assert.equal(withHeadScript('<html data-x="', s), `${tag}<html data-x="`);
});

test('the in-memory Storage follows real Storage semantics', () => {
  const win = throwingWindow();
  win.eval(sandboxStorageShimScript());
  const store = win.localStorage;
  store.setItem('a', 'x');
  store.setItem('b', 'y');
  // key() truncates like an unsigned long.
  assert.equal(store.key(0.9), 'a');
  assert.equal(store.key('1'), 'b');
  assert.equal(store.key(-1), null);
  assert.equal(store.key(NaN), 'a');
  assert.equal(store.key(2 ** 32), 'a');
  // Missing required arguments throw TypeError (and change nothing).
  assert.throws(() => store.getItem(), win.TypeError);
  assert.throws(() => store.removeItem(), win.TypeError);
  assert.throws(() => store.key(), win.TypeError);
  assert.throws(() => store.setItem('only-key'), win.TypeError);
  assert.equal(store.length, 2);
  assert.equal(store.getItem('only-key'), null);
  // A throwing conversion leaves no phantom key or inflated length.
  const boom = {
    toString() {
      throw new Error('boom');
    },
  };
  assert.throws(() => store.setItem('ghost', boom), /boom/);
  assert.throws(() => store.setItem(boom, 'v'), /boom/);
  assert.throws(() => {
    store.viaProxy = boom;
  }, /boom/);
  assert.equal(store.length, 2);
  assert.equal(store.getItem('ghost'), null);
  assert.equal(store.getItem('viaProxy'), null);
  assert.equal(store.key(2), null);
});

test('the shim lands before the first page script, with or without a head', () => {
  const script = 'SHIM()';
  const tag = '<script>SHIM()</script>';
  assert.equal(
    withHeadScript('<html><head data-x="1"><script>p()</script></head></html>', script),
    `<html><head data-x="1">${tag}<script>p()</script></head></html>`
  );
  // A <header> is not a <head>.
  assert.equal(withHeadScript('<html><header></header></html>', script), `<html>${tag}<header></header></html>`);
  // No head: after <html>, keeping the doctype first.
  assert.equal(
    withHeadScript('<!DOCTYPE html><html lang="en"><body><script>p()</script></body></html>', script),
    `<!DOCTYPE html><html lang="en">${tag}<body><script>p()</script></body></html>`
  );
  // Only a doctype, or nothing at all.
  assert.equal(
    withHeadScript('<!doctype html><script>p()</script>', script),
    `<!doctype html>${tag}<script>p()</script>`
  );
  assert.equal(withHeadScript('<script>p()</script>', script), `${tag}<script>p()</script>`);
  const shimmed = withSandboxStorageShim('<body><script>p()</script></body>');
  assert.ok(shimmed.indexOf(sandboxStorageShimScript()) < shimmed.indexOf('p()'));
  assert.doesNotMatch(sandboxStorageShimScript(), /<\/script/i);
});
