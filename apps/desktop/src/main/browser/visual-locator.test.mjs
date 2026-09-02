import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { browserVisualLocatorExpression } from './visual-locator.ts';

test('browser visual locator ranks color, label, and position in screenshot coordinates', () => {
  const dom = new JSDOM(
    '<!doctype html><button id="save" style="background:rgb(235,210,35)">Save</button>'
      + '<button id="cancel">Cancel</button>',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const { window } = dom;
  try {
    Object.defineProperty(window, 'innerWidth', { value: 900 });
    Object.defineProperty(window, 'innerHeight', { value: 600 });
    const save = window.document.querySelector('#save');
    const cancel = window.document.querySelector('#cancel');
    save.getBoundingClientRect = () => ({
      left: 700, top: 20, width: 120, height: 40, right: 820, bottom: 60, x: 700, y: 20,
      toJSON() { return this; },
    });
    cancel.getBoundingClientRect = () => ({
      left: 20, top: 500, width: 120, height: 40, right: 140, bottom: 540, x: 20, y: 500,
      toJSON() { return this; },
    });
    window.document.documentElement.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0,
      toJSON() { return this; },
    });
    window.document.body.getBoundingClientRect = window.document.documentElement.getBoundingClientRect;

    const result = window.eval(browserVisualLocatorExpression('노란 오른쪽 Save 버튼', 10));
    assert.equal(result.candidates[0].name, 'Save');
    assert.equal(result.candidates[0].color, 'yellow');
    assert.equal(result.candidates[0].position, 'top-right');
    assert.equal(result.candidates[0].x, 760);
  } finally {
    dom.window.close();
  }
});
