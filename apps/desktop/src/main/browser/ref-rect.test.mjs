import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { browserRefRectExpression } from './ref-rect.ts';

function rectHarness(box) {
  const dom = new JSDOM('<!doctype html><div id="box">Box</div>', {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const element = dom.window.document.getElementById('box');
  element.scrollIntoView = () => {};
  element.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
  });
  dom.window.__mixdogAgentSnapshot = { id: 'p1-s1', refs: new Map([['p1-s1-e1', { element, frames: [] }]]) };
  return dom;
}

test('a ref rect measures the element box in top-document coordinates', async () => {
  const dom = rectHarness({ left: 10, top: 20, width: 100, height: 40 });
  try {
    const rect = { ...(await dom.window.eval(browserRefRectExpression('p1-s1-e1'))) };
    assert.deepEqual(rect, { x: 10, y: 20, width: 100, height: 40 });
  } finally {
    dom.window.close();
  }
});

test('a ref rect adds the offset of a same-process frame ancestor', async () => {
  const dom = rectHarness({ left: 10, top: 20, width: 100, height: 40 });
  Object.defineProperty(dom.window, 'frameElement', {
    configurable: true,
    value: {
      getBoundingClientRect: () => ({ left: 5, top: 7 }),
      clientLeft: 1,
      clientTop: 2,
      ownerDocument: {},
    },
  });
  try {
    const rect = { ...(await dom.window.eval(browserRefRectExpression('p1-s1-e1'))) };
    assert.deepEqual(rect, { x: 16, y: 29, width: 100, height: 40 });
  } finally {
    dom.window.close();
  }
});

test('a ref rect refuses a box that is still moving rather than measuring mid-animation', async () => {
  const dom = rectHarness({ left: 10, top: 20, width: 100, height: 40 });
  const element = dom.window.document.getElementById('box');
  let sample = 0;
  element.getBoundingClientRect = () => {
    sample += 1;
    const left = sample === 1 ? 10 : 400;
    return { left, top: 20, width: 100, height: 40, right: left + 100, bottom: 60 };
  };
  try {
    const rect = { ...(await dom.window.eval(browserRefRectExpression('p1-s1-e1'))) };
    assert.equal(rect.error, 'moving');
  } finally {
    dom.window.close();
  }
});

test('a ref rect refuses a ref the page no longer holds and an unmeasurable box', async () => {
  const dom = rectHarness({ left: 10, top: 20, width: 100, height: 40 });
  try {
    const stale = { ...(await dom.window.eval(browserRefRectExpression('p1-s1-e9'))) };
    assert.equal(stale.error, 'stale');
  } finally {
    dom.window.close();
  }
  const collapsed = rectHarness({ left: 10, top: 20, width: 0, height: 0 });
  try {
    const rect = { ...(await collapsed.window.eval(browserRefRectExpression('p1-s1-e1'))) };
    assert.equal(rect.error, 'not-visible');
  } finally {
    collapsed.window.close();
  }
});
