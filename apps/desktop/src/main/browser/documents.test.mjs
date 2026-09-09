import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  BROWSER_OBSERVATION_REVISION,
  browserDocumentChanged,
  filterBrowserReadLines,
} from './documents.ts';

test('document change ignores pointer activity and scrolling unless asked', () => {
  const at = (version, dom, scrollY = 0) => `1700000000:${version}:800:600:0:${scrollY}:${dom}`;
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1)), false, 'a pointer press alone is not a change');
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 2)), true, 'a mutation or value change is');
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1, 300)), false);
  assert.equal(browserDocumentChanged(at(1, 1), at(2, 1, 300), { includeScroll: true }), true);
  assert.equal(browserDocumentChanged(at(1, 1), `${at(1, 1)}|${at(1, 1)}`), true, 'a frame appeared');
  assert.equal(browserDocumentChanged('1700:1:800:600:0:0', at(1, 1)), undefined, 'an old-format revision is unknown');
  assert.equal(browserDocumentChanged(undefined, at(1, 1)), undefined);
});

test('the page-side revision counts mutations and value changes apart from gestures', () => {
  const dom = new JSDOM('<!doctype html><input id="field"><div id="box"></div>', { runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const parts = () => window.eval(BROWSER_OBSERVATION_REVISION).split(':');
    const first = parts();
    assert.equal(parts()[6], first[6]);
    window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    const pressed = parts();
    assert.notEqual(pressed[1], first[1], 'activity moves the version');
    assert.equal(pressed[6], first[6], 'but not the document counter');
    window.document.querySelector('#box').textContent = 'changed';
    const mutated = parts();
    assert.equal(Number(mutated[6]), Number(pressed[6]) + 1);
    window.document.querySelector('#field').dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(Number(parts()[6]), Number(mutated[6]) + 1, 'a typed value counts as a document change');
  } finally {
    dom.window.close();
  }
});

test('read filters lines by OR keywords or a regular expression with two lines of context', () => {
  const text = ['Title', 'Price: 10', 'Stock: none', 'Shipping', 'Footer', 'Contact', 'Legal'].join('\n');
  assert.deepEqual(filterBrowserReadLines(text, 'stock contact').split('\n'), [
    'Title', 'Price: 10', 'Stock: none', 'Shipping', 'Footer', 'Contact', 'Legal',
  ]);
  assert.deepEqual(filterBrowserReadLines(text, '/^legal$/i').split('\n'), ['Footer', 'Contact', 'Legal']);
  assert.equal(filterBrowserReadLines(text, 'nothing here'), '');
  assert.equal(filterBrowserReadLines(text, '   '), text);
});