import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { watchBrowserDialogFocus } from './browser-dialog-focus.ts';

test('dialog focus wraps visible enabled controls, delegates Escape, and restores the trigger', (t) => {
  const dom = new JSDOM(
    '<button id="trigger">Open</button><section><button id="first">First</button><input disabled><button id="hidden">Hidden</button><button id="last">Last</button></section>'
  );
  for (const name of ['window', 'document', 'HTMLElement']) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]));
  }
  t.after(() => dom.window.close());
  let focus;
  let cancelled;
  window.requestAnimationFrame = (callback) => {
    focus = callback;
    return 1;
  };
  window.cancelAnimationFrame = (handle) => {
    cancelled = handle;
  };
  const trigger = document.getElementById('trigger');
  const first = document.getElementById('first');
  const last = document.getElementById('last');
  for (const node of [first, last]) Object.defineProperty(node, 'offsetParent', { value: document.body });
  trigger.focus();
  let closes = 0;
  const stop = watchBrowserDialogFocus(
    { current: document.querySelector('section') },
    () => closes++,
    'button:not(:disabled), input:not(:disabled)'
  );
  focus();
  assert.equal(document.activeElement, first);
  const key = (value, shiftKey = false) => {
    const event = new window.KeyboardEvent('keydown', { key: value, shiftKey, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(key('Tab', true), true);
  assert.equal(document.activeElement, last);
  assert.equal(key('Tab'), true);
  assert.equal(document.activeElement, first);
  assert.equal(key('ArrowRight'), false);
  assert.equal(key('Escape'), true);
  assert.equal(closes, 1);
  stop();
  assert.equal(cancelled, 1);
  assert.equal(document.activeElement, trigger);
  assert.equal(key('Escape'), false);
  assert.equal(closes, 1);
});
