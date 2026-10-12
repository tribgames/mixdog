import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installTouchGestures } from './touch-gestures.ts';

const LONG_PRESS_MS = 20;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A session-like row: its trailing action rests hidden at x 180-200. */
function setup() {
  const dom = new JSDOM('<div id="row"><span id="title">Title</span><button id="action">Archive</button></div>');
  const win = dom.window;
  const doc = win.document;
  const row = doc.getElementById('row');
  const title = doc.getElementById('title');
  const action = doc.getElementById('action');
  action.getBoundingClientRect = () => ({ left: 180, right: 200, top: 0, bottom: 20, width: 20, height: 20 });
  const log = [];
  row.addEventListener('click', (event) => log.push(`row-click:${event.target.id}`));
  action.addEventListener('click', () => log.push('action-click'));
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    log.push(`menu:${event.clientX},${event.clientY}`);
  });
  const dispose = installTouchGestures(win, LONG_PRESS_MS);
  return { win, doc, row, title, action, log, dispose };
}

function pointer(win, target, type, { x = 190, y = 10, pointerType = 'touch', id = 1, isPrimary = true } = {}) {
  const Ctor = win.PointerEvent ?? win.MouseEvent;
  const event = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerId: id,
    pointerType,
    isPrimary,
  });
  for (const [key, value] of Object.entries({ pointerType, pointerId: id, isPrimary })) {
    if (event[key] !== value) Object.defineProperty(event, key, { value });
  }
  target.dispatchEvent(event);
  return event;
}

function mouse(win, target, type, init = {}) {
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 190, clientY: 10, ...init });
  target.dispatchEvent(event);
  return event;
}

test('a tap that began on the row is not taken by a control revealed during it', () => {
  const { win, row, action, log, dispose } = setup();
  // Pressed while hidden: the press lands on the row itself.
  pointer(win, row, 'pointerdown');
  pointer(win, row, 'pointerup');
  // :hover revealed the action, and the click hit-test now finds it.
  const click = mouse(win, action, 'click');
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(log, ['row-click:row']);
  dispose();
});

test('a tap that began on the control still clicks it', () => {
  const { win, action, log, dispose } = setup();
  pointer(win, action, 'pointerdown');
  pointer(win, action, 'pointerup');
  mouse(win, action, 'click');
  assert.deepEqual(log, ['action-click', 'row-click:action']);
  dispose();
});

test('a tap merely near a control keeps the browser target adjustment', () => {
  const { win, title, action, log, dispose } = setup();
  pointer(win, title, 'pointerdown', { x: 170 });
  pointer(win, title, 'pointerup', { x: 170 });
  mouse(win, action, 'click', { clientX: 170 });
  assert.deepEqual(log, ['action-click', 'row-click:action']);
  dispose();
});

test('mouse clicks are never redirected', () => {
  const { win, row, action, log, dispose } = setup();
  pointer(win, row, 'pointerdown', { pointerType: 'mouse' });
  pointer(win, row, 'pointerup', { pointerType: 'mouse' });
  mouse(win, action, 'click');
  assert.deepEqual(log, ['action-click', 'row-click:action']);
  dispose();
});

test('long-press opens the context menu once and its release clicks nothing', async () => {
  const { win, title, log, dispose } = setup();
  pointer(win, title, 'pointerdown', { x: 40, y: 8 });
  await wait(LONG_PRESS_MS * 3);
  assert.deepEqual(log, ['menu:40,8']);
  // The platform's own long-press menu for the same press is dropped.
  const native = mouse(win, title, 'contextmenu', { clientX: 40, clientY: 8, button: 2 });
  assert.equal(native.defaultPrevented, true);
  const touchMove = new win.Event('touchmove', { bubbles: true, cancelable: true });
  title.dispatchEvent(touchMove);
  assert.equal(touchMove.defaultPrevented, true, 'the open menu must not scroll away');
  pointer(win, title, 'pointerup', { x: 40, y: 8 });
  mouse(win, title, 'mousedown');
  mouse(win, title, 'click');
  assert.deepEqual(log, ['menu:40,8']);
  dispose();
});

test('moving the finger is a scroll, not a long-press', async () => {
  const { win, title, log, dispose } = setup();
  pointer(win, title, 'pointerdown', { x: 40, y: 8 });
  pointer(win, title, 'pointermove', { x: 40, y: 40 });
  await wait(LONG_PRESS_MS * 3);
  pointer(win, title, 'pointercancel', { x: 40, y: 40 });
  assert.deepEqual(log, []);
  dispose();
});

test('the platform long-press menu wins when it comes first', async () => {
  const { win, title, log, dispose } = setup();
  pointer(win, title, 'pointerdown', { x: 40, y: 8 });
  mouse(win, title, 'contextmenu', { clientX: 40, clientY: 8, button: 2 });
  await wait(LONG_PRESS_MS * 3);
  assert.deepEqual(log, ['menu:40,8']);
  dispose();
});

test('text fields keep their own long-press', async () => {
  const dom = new JSDOM('<input id="field">');
  const win = dom.window;
  const field = win.document.getElementById('field');
  let menus = 0;
  field.addEventListener('contextmenu', () => {
    menus += 1;
  });
  const dispose = installTouchGestures(win, LONG_PRESS_MS);
  pointer(win, field, 'pointerdown');
  await wait(LONG_PRESS_MS * 3);
  assert.equal(menus, 0);
  dispose();
});
