import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  BROWSER_BOUND_DROP_GUARD_INSTALL,
  BROWSER_BOUND_DROP_GUARD_TAKE,
  BROWSER_DROP_GUARD_AIM,
  BROWSER_DROP_GUARD_INSTALL,
  BROWSER_DROP_GUARD_TAKE,
} from './file-drop.ts';

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

/** A document with the approved zone and another zone, both taking drops. */
function zones() {
  const dom = new JSDOM('<!doctype html><div id="zone"><span id="inner">Zone</span></div><div id="other">Other</div>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const took = [];
  for (const id of ['zone', 'other']) {
    const element = window.document.getElementById(id);
    element.addEventListener('dragover', (event) => event.preventDefault());
    element.addEventListener('drop', (event) => {
      event.preventDefault();
      took.push(id);
    });
  }
  return { dom, window, took, element: (id) => window.document.getElementById(id) };
}

/** The guard's report, as a plain object of this realm. */
const take = (window) => ({ ...window.eval(BROWSER_BOUND_DROP_GUARD_TAKE) });
const aim = (window, element) => window.Function(`return (${BROWSER_DROP_GUARD_AIM})`)().call(element);

test('an approved upload drop reaches only the target the person approved', () => {
  const page = zones();
  try {
    page.window.eval(BROWSER_BOUND_DROP_GUARD_INSTALL);
    assert.equal(aim(page.window, page.element('zone')), true);
    dispatch(page.window, page.element('inner'), 'dragover');
    dispatch(page.window, page.element('inner'), 'drop');
    assert.deepEqual(page.took, ['zone'], 'a drop inside the target (on its child) is the target’s');
    assert.deepEqual(take(page.window), { accepted: true, strayed: false });
  } finally {
    page.dom.window.close();
  }
});

test('an approved upload drop that lands elsewhere is blocked before the page sees it', () => {
  const page = zones();
  try {
    page.window.eval(BROWSER_BOUND_DROP_GUARD_INSTALL);
    aim(page.window, page.element('zone'));
    const drop = dispatch(page.window, page.element('other'), 'drop');
    assert.deepEqual(page.took, [], 'the other zone never got the files');
    assert.equal(drop.defaultPrevented, true, 'and the browser does not open the file');
    assert.deepEqual(take(page.window), { accepted: false, strayed: true });
  } finally {
    page.dom.window.close();
  }
});

test('a frame without the approved target blocks every drop of an approved upload', () => {
  const page = zones();
  try {
    page.window.eval(BROWSER_BOUND_DROP_GUARD_INSTALL);
    assert.equal(dispatch(page.window, page.element('zone'), 'dragover').defaultPrevented, true);
    dispatch(page.window, page.element('zone'), 'drop');
    assert.deepEqual(page.took, []);
    assert.deepEqual(take(page.window), { accepted: false, strayed: true });
    assert.deepEqual(take(page.window), { accepted: false, strayed: false }, 'removed once read');
    assert.equal(aim(page.window, page.element('zone')), false, 'nothing to aim once removed');
  } finally {
    page.dom.window.close();
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
