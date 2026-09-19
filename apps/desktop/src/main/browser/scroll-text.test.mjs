import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { browserScrollTextApplyExpression, browserScrollTextMatchExpression } from './scroll-text.ts';

function harness() {
  const dom = new JSDOM(
    '<!doctype html><div id="host"></div><p id="thin">Thin phrase</p>' +
      '<p id="masked" style="display:none">Masked phrase</p><script>const config = "Script phrase";</script>',
    { runScripts: 'outside-only' }
  );
  const { window } = dom;
  const scrolled = [];
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return this.id === 'thin' ? { width: 120, height: 0 } : { width: 120, height: 20 };
  };
  window.Element.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this.id);
  };
  window.document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<p id="deep">Quarterly report</p>';
  return { dom, window, scrolled };
}

test('scroll text reaches an open shadow root and scrolls exactly the matched element', () => {
  const { dom, window, scrolled } = harness();
  try {
    const match = window.eval(browserScrollTextMatchExpression('quarterly'));
    assert.equal(match.found, true);
    assert.equal(match.text, 'Quarterly report');
    assert.equal(window.eval(browserScrollTextApplyExpression(match.token)).scrolled, true);
    assert.deepEqual(scrolled, ['deep']);
  } finally {
    dom.window.close();
  }
});

test('scroll text ignores text that never renders and scrolls for no other frame', () => {
  const { dom, window, scrolled } = harness();
  try {
    for (const phrase of ['thin phrase', 'masked phrase', 'script phrase']) {
      assert.equal(window.eval(browserScrollTextMatchExpression(phrase)).found, false, phrase);
    }
    window.eval(browserScrollTextMatchExpression('quarterly'));
    assert.equal(window.eval(browserScrollTextApplyExpression('another-frame')).scrolled, false);
    assert.deepEqual(scrolled, []);
  } finally {
    dom.window.close();
  }
});
