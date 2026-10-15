import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { dom, restore } = installTestDom(null, {
  html: '<!doctype html><html><body><div id="host"><div id="slot"></div></div><div id="other"></div></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
});
test.after(() => restore());
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useSlotRemeasure } = await import('./surface-slot-remeasure.ts');

test('only transitions on the slot, its ancestors or descendants re-measure it', async () => {
  const win = dom.window;
  const frames = [];
  let requested = 0;
  win.requestAnimationFrame = (callback) => {
    requested += 1;
    return frames.push(callback);
  };
  win.cancelAnimationFrame = () => {};
  const flush = () => {
    while (frames.length) frames.shift()();
  };
  const refreshes = [];
  const controller = { refresh: (id) => refreshes.push(id) };
  const slot = win.document.getElementById('slot');
  const child = win.document.createElement('span');
  slot.append(child);
  const slotRef = { current: slot };
  function Probe() {
    useSlotRemeasure(slotRef, true, controller, 'session');
    return null;
  }
  const root = createRoot(win.document.createElement('div'));
  await act(async () => root.render(React.createElement(Probe)));
  flush();

  const fire = (target, type) => target.dispatchEvent(new win.Event(type, { bubbles: true }));
  const requestedAfter = (target, type) => {
    const before = requested;
    fire(target, type);
    const delta = requested - before;
    flush();
    return delta;
  };
  const other = win.document.getElementById('other');
  assert.equal(requestedAfter(other, 'transitionrun'), 0, 'an unrelated transition run schedules nothing');
  assert.equal(requestedAfter(other, 'transitionend'), 0, 'an unrelated transition end schedules nothing');
  assert.ok(requestedAfter(win.document.getElementById('host'), 'transitionend') > 0, 'an ancestor re-measures');
  assert.ok(requestedAfter(child, 'transitionend') > 0, 'a descendant re-measures');
  assert.ok(requestedAfter(slot, 'transitionrun') > 0, 'a slot transition starts tracking');

  await act(async () => root.unmount());
});
