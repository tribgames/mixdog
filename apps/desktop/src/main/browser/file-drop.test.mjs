import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { BROWSER_DROP_GUARD_INSTALL, BROWSER_DROP_GUARD_TAKE } from './file-drop.ts';

function dispatch(window, target, type) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('a drop no page handler took is neutralised and reported as refused', () => {
  const dom = new JSDOM('<!doctype html><div id="zone">Zone</div>', { runScripts: 'outside-only' });
  const { window } = dom;
  try {
    assert.equal(window.eval(BROWSER_DROP_GUARD_INSTALL), true);
    const zone = window.document.querySelector('#zone');

    // Without the guard the browser would navigate to the dropped file.
    assert.equal(dispatch(window, zone, 'dragover').defaultPrevented, true);
    assert.equal(dispatch(window, zone, 'drop').defaultPrevented, true);

    assert.equal(window.eval(BROWSER_DROP_GUARD_TAKE), false);
    assert.equal(window.eval(BROWSER_DROP_GUARD_TAKE), false, 'the guard removes itself when it is read');
  } finally {
    dom.window.close();
  }
});

test('a page that takes the drop itself is reported as accepting the files', () => {
  const dom = new JSDOM('<!doctype html><div id="zone">Zone</div>', { runScripts: 'outside-only' });
  const { window } = dom;
  try {
    const zone = window.document.querySelector('#zone');
    zone.addEventListener('dragover', (event) => event.preventDefault());
    zone.addEventListener('drop', (event) => event.preventDefault());
    window.eval(BROWSER_DROP_GUARD_INSTALL);
    window.eval(BROWSER_DROP_GUARD_INSTALL);

    dispatch(window, zone, 'dragover');
    dispatch(window, zone, 'drop');

    assert.equal(window.eval(BROWSER_DROP_GUARD_TAKE), true);
  } finally {
    dom.window.close();
  }
});
