import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useBrowserPageInput } from './use-browser-page-input.ts';
import { normalizeBrowserPageControl } from '../shared/browser-page-control.ts';

function fixture() {
  const sent = [];
  let handlers;
  let captures = 0;
  let focuses = 0;
  const image = { hidden: false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  function Harness() {
    handlers = useBrowserPageInput({
      frame: () => ({ width: 800, height: 600, viewportWidth: 800, viewportHeight: 600 }),
      fire: action => sent.push(normalizeBrowserPageControl({ ...action, documentId: 'p1:1' })),
    }, { current: image },
    { current: { focus: () => { focuses++; } } });
    return null;
  }
  renderToString(createElement(Harness));
  const event = (button, buttons) => ({
    button, buttons, clientX: 40, clientY: 50, pointerId: 1, detail: 1,
    preventDefault() {},
    currentTarget: { setPointerCapture() { captures++; } },
  });
  return { handlers, sent, event, image, captures: () => captures, focuses: () => focuses };
}

test('hidden resize frames reject new pointer input but still release an already-held drag', () => {
  const f = fixture();
  f.handlers.onPointerDown(f.event(0, 1));
  f.image.hidden = true;
  f.handlers.onPointerMove(f.event(0, 1));
  f.handlers.onPointerUp(f.event(0, 0));
  f.handlers.onPointerDown(f.event(0, 1));
  assert.deepEqual(f.sent.map(input => input.phase), ['mousePressed', 'mouseReleased']);
});

test('auxiliary button clicks never dispatch a left click or capture the pointer', () => {
  const f = fixture();
  for (const [button, buttons] of [[3, 8], [4, 16], [5, 32]]) {
    f.handlers.onPointerDown(f.event(button, buttons));
    f.handlers.onPointerUp(f.event(button, 0));
  }
  assert.deepEqual(f.sent, []);
  assert.equal(f.captures(), 0);
  assert.equal(f.focuses(), 0);
});

test('auxiliary button motion is admitted as hover without unsupported button bits', () => {
  const f = fixture();
  for (const buttons of [8, 16, 24, 32]) {
    f.handlers.onPointerMove(f.event(-1, buttons));
  }
  assert.equal(f.sent.length, 4);
  for (const action of f.sent) {
    assert.equal(action.phase, 'mouseMoved');
    assert.equal(action.button, 'none');
    assert.equal(action.buttons, 0);
    assert.equal(action.x, 40);
    assert.equal(action.y, 50);
  }
});

test('normal button presses and releases remain valid while auxiliary buttons are held', () => {
  for (const [button, bit, name] of [[0, 1, 'left'], [1, 4, 'middle'], [2, 2, 'right']]) {
    const f = fixture();
    f.handlers.onPointerDown(f.event(button, bit | 24));
    f.handlers.onPointerUp(f.event(button, 24));
    assert.deepEqual(f.sent.map(({ phase, button, buttons }) => ({ phase, button, buttons })), [
      { phase: 'mousePressed', button: name, buttons: bit },
      { phase: 'mouseReleased', button: name, buttons: 0 },
    ]);
    assert.equal(f.captures(), 1);
    assert.equal(f.focuses(), 1);
  }
});

test('right-button drag motion and lost capture retain the correct button and release it once', () => {
  const f = fixture();
  f.handlers.onPointerDown(f.event(2, 2));
  f.handlers.onPointerMove(f.event(-1, 2));
  f.handlers.onPointerCancel(f.event(-1, 2));
  f.handlers.onBlur();
  assert.deepEqual(f.sent.map(({ phase, button, buttons }) => ({ phase, button, buttons })), [
    { phase: 'mousePressed', button: 'right', buttons: 2 },
    { phase: 'mouseMoved', button: 'right', buttons: 2 },
    { phase: 'mouseReleased', button: 'right', buttons: 0 },
  ]);
});

test('focus loss releases every held button without leaving a stuck drag', () => {
  const f = fixture();
  f.handlers.onPointerDown(f.event(0, 1));
  f.handlers.onPointerDown(f.event(2, 3));
  f.handlers.onBlur();
  assert.deepEqual(f.sent.slice(2).map(({ button, buttons }) => ({ button, buttons })), [
    { button: 'left', buttons: 2 }, { button: 'right', buttons: 0 },
  ]);
});
