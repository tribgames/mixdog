import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { browserRefPointExpression, browserSnapshotExpression } from './snapshot-scripts.ts';

function refPointHarness() {
  const dom = new JSDOM(
    '<!doctype html><button id="target"><span id="child">Run</span></button>'
      + '<div id="ancestor"><span id="nested">Nested target</span></div>'
      + '<a id="link" href="/destination">Destination</a>'
      + '<a id="equivalent" href="/destination">Destination duplicate</a>'
      + '<div id="overlay">Blocking dialog</div>',
    { runScripts: 'outside-only', url: 'https://example.test/' },
  );
  const { window } = dom;
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = (timer) => clearTimeout(timer);
  const target = window.document.querySelector('#target');
  const child = window.document.querySelector('#child');
  const ancestor = window.document.querySelector('#ancestor');
  const nested = window.document.querySelector('#nested');
  const link = window.document.querySelector('#link');
  const equivalent = window.document.querySelector('#equivalent');
  const overlay = window.document.querySelector('#overlay');
  target.scrollIntoView = () => {};
  target.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 110,
    bottom: 60,
    width: 100,
    height: 40,
    toJSON() { return this; },
  });
  window.__mixdogAgentSnapshot = {
    id: 'p1-s1',
    refs: new Map([['p1-s1-e1', { element: target, frames: [] }]]),
  };
  return { dom, window, target, child, ancestor, nested, link, equivalent, overlay };
}

test('browser ref clicks accept the target tree, reject overlays, and never alias generations', async () => {
  const harness = refPointHarness();
  try {
    harness.window.document.elementFromPoint = () => harness.child;
    const point = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(point.x, 60);
    assert.equal(point.y, 40);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.nested, frames: [] }]]),
    };
    harness.nested.scrollIntoView = () => {};
    harness.nested.getBoundingClientRect = harness.target.getBoundingClientRect;
    harness.window.document.elementFromPoint = () => harness.ancestor;
    const arbitraryAncestor = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(arbitraryAncestor.error, 'covered');

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.link, frames: [] }]]),
    };
    harness.link.scrollIntoView = () => {};
    harness.link.getBoundingClientRect = harness.target.getBoundingClientRect;
    harness.window.document.elementFromPoint = () => harness.equivalent;
    const equivalent = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(equivalent.x, 60);
    assert.equal(equivalent.y, 40);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s1',
      refs: new Map([['p1-s1-e1', { element: harness.target, frames: [] }]]),
    };
    harness.window.document.elementFromPoint = () => harness.overlay;
    const covered = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(covered.error, 'covered');
    assert.match(covered.covering, /Blocking dialog/);

    harness.window.__mixdogAgentSnapshot = {
      id: 'p1-s2',
      refs: new Map([['p1-s2-e1', { element: harness.overlay, frames: [] }]]),
    };
    const stale = await harness.window.eval(browserRefPointExpression('p1-s1-e1'));
    assert.equal(stale.error, 'stale');
  } finally {
    harness.dom.window.close();
  }
});

test('DOM fallback semantic query ignores URL search parameters and reports the matched field', () => {
  const dom = new JSDOM(`<!doctype html>
    <a id="signin" href="/login?return_to=%2Fissues%3Fq%3Ddownload">Sign in</a>
    <button id="named">Download report</button>
    <a id="path" href="/downloads/latest?token=tracking">Release asset</a>
    <input id="search-value" type="search" aria-label="Issue search" value="download">
    <div id="focusable-wrapper" role="listitem" tabindex="0">Download report</div>
    <a id="named-link" href="/downloads/report">Download report</a>`, {
    url: 'https://example.test/issues?q=download',
    runScripts: 'outside-only',
  });
  try {
    for (const [index, element] of [...dom.window.document.querySelectorAll('a,button,input,[role="listitem"]')].entries()) {
      element.getBoundingClientRect = () => ({
        left: 10,
        top: 10 + index * 30,
        right: 110,
        bottom: 30 + index * 30,
        width: 100,
        height: 20,
        x: 10,
        y: 10 + index * 30,
        toJSON() { return this; },
      });
    }
    const payload = dom.window.eval(browserSnapshotExpression({
      snapshotId: 'p3-s1',
      query: 'download',
      maxElements: 20,
    }));
    assert.deepEqual(
      Array.from(payload.elements, (entry) => [entry.role, entry.name, entry.matchField]),
      [
        ['link', 'Download report', 'name'],
        ['button', 'Download report', 'name'],
        ['listitem', 'Download report', 'name'],
        ['link', 'Release asset', 'href'],
        ['searchbox', 'Issue search', 'value'],
      ],
    );
  } finally {
    dom.window.close();
  }
});

test('semantic snapshots include shadow controls, omit password values, and bind generated refs', () => {
  const dom = new JSDOM(
    '<!doctype html><title>Demo</title><button id="plain">Run</button>'
      + '<label for="secret">Password</label><input id="secret" type="password" value="do-not-leak">'
      + `<div id="custom" role="button" aria-expanded="${'expanded '.repeat(100)}">Custom</div><div id="host"></div>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/app' },
  );
  const { window } = dom;
  try {
    Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value() {
        const index = [...this.ownerDocument.querySelectorAll('*')].indexOf(this);
        return {
          left: 10,
          top: Math.max(0, index * 20),
          right: 130,
          bottom: Math.max(20, index * 20 + 20),
          width: 120,
          height: 20,
          x: 10,
          y: Math.max(0, index * 20),
          toJSON() { return this; },
        };
      },
    });
    const host = window.document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowButton = window.document.createElement('button');
    shadowButton.textContent = 'Shadow action';
    shadow.append(shadowButton);

    const payload = window.eval(browserSnapshotExpression({
      snapshotId: 'p7-s3',
      maxElements: 10,
      textChars: 500,
    }));
    assert.equal(payload.snapshotId, 'p7-s3');
    assert.ok(payload.elements.some((entry) => entry.name === 'Shadow action'));
    assert.ok(payload.elements.every((entry) => entry.ref.startsWith('p7-s3-e')));
    const password = payload.elements.find((entry) => entry.name === 'Password');
    assert.ok(password);
    assert.equal(password.sensitive, true);
    assert.equal(password.value, '');
    assert.doesNotMatch(JSON.stringify(payload), /do-not-leak/);
    const custom = payload.elements.find((entry) => entry.name === 'Custom');
    assert.ok(custom.states.every((state) => state.length <= 89));
    assert.ok(window.__mixdogAgentSnapshot.refs.has(payload.elements[0].ref));
  } finally {
    dom.window.close();
  }
});

test('DOM fallback queries match keywords with OR or a regex, count the unfiltered page, and mark file inputs', () => {
  const dom = new JSDOM(
    '<!doctype html><button id="draft">Save draft</button><button id="publish">Publish</button>'
    + '<a id="save" href="/save">Save</a>'
    + '<input id="photos" type="file" accept="image/png, image/jpeg" multiple aria-label="Photos">',
    { runScripts: 'outside-only', url: 'https://example.test/' },
  );
  try {
    for (const [index, element] of [...dom.window.document.querySelectorAll('button,a,input')].entries()) {
      element.getBoundingClientRect = () => ({
        left: 10, top: 10 + index * 30, right: 110, bottom: 30 + index * 30, width: 100, height: 20,
        x: 10, y: 10 + index * 30, toJSON() { return this; },
      });
    }
    const snapshot = (query) => dom.window.eval(browserSnapshotExpression({ snapshotId: 'p5-s1', query, maxElements: 20 }));
    // Page-realm arrays are spread into this realm before strict comparison.
    const names = (payload) => [...payload.elements.map((entry) => entry.name)];
    const keywords = snapshot('publish save');
    assert.deepEqual(new Set(names(keywords)), new Set(['Save draft', 'Publish', 'Save']));
    assert.equal(keywords.unfilteredElements, 4);
    assert.deepEqual(names(snapshot('/^pub/i')), ['Publish']);
    const none = snapshot('nothing-here');
    assert.equal(none.elements.length, 0);
    assert.equal(none.unfilteredElements, 4);
    const photos = snapshot('').elements.find((entry) => entry.name === 'Photos');
    assert.deepEqual([...photos.states], ['file-input', 'accept=image/png, image/jpeg', 'multiple']);
  } finally {
    dom.window.close();
  }
});

test('a hidden checkbox resolves through its label, and the label can still be covered', async () => {
  const dom = new JSDOM(
    '<!doctype html><label for="agree" id="agree-label"><span id="box"></span> I agree</label>'
    + '<input id="agree" type="checkbox"><input id="lonely" type="checkbox"><div id="overlay">Modal</div>',
    { runScripts: 'outside-only', url: 'https://example.test/' },
  );
  try {
    const { window } = dom;
    window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
    window.cancelAnimationFrame = (timer) => clearTimeout(timer);
    const rect = (left, top, width, height) => () => ({
      left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
    });
    const input = window.document.querySelector('#agree');
    const lonely = window.document.querySelector('#lonely');
    const label = window.document.querySelector('#agree-label');
    const box = window.document.querySelector('#box');
    const overlay = window.document.querySelector('#overlay');
    for (const element of [input, lonely]) element.scrollIntoView = () => {};
    input.getBoundingClientRect = rect(0, 0, 0, 0);
    lonely.getBoundingClientRect = rect(0, 0, 0, 0);
    label.getBoundingClientRect = rect(10, 20, 100, 40);
    window.__mixdogAgentSnapshot = {
      id: 'p6-s1',
      refs: new Map([
        ['p6-s1-e1', { element: input, frames: [] }],
        ['p6-s1-e2', { element: lonely, frames: [] }],
      ]),
    };
    // The invisible control has no box of its own; its label is the landing spot.
    window.document.elementFromPoint = () => box;
    assert.deepEqual({ ...await window.eval(browserRefPointExpression('p6-s1-e1')) }, { x: 60, y: 40 });
    // A 1px control that a label's text sits over is clicked where it is.
    input.getBoundingClientRect = rect(5, 5, 1, 1);
    assert.deepEqual({ ...await window.eval(browserRefPointExpression('p6-s1-e1')) }, { x: 6, y: 6 });
    // Something over the label is still an overlay.
    input.getBoundingClientRect = rect(0, 0, 0, 0);
    window.document.elementFromPoint = () => overlay;
    const covered = await window.eval(browserRefPointExpression('p6-s1-e1'));
    assert.equal(covered.error, 'covered');
    assert.match(covered.covering, /Modal/);
    // Without a label there is nothing to land on.
    assert.equal((await window.eval(browserRefPointExpression('p6-s1-e2'))).error, 'not-visible');
  } finally {
    dom.window.close();
  }
});
